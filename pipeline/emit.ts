// Stage 4: Emit — assemble the PageData JSON the viewer consumes.
// Traces are computed facts with provenance; nothing heuristic.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { PageData, Entry, ComponentDoc, Commit, PRInfo, EntryKind, Comment, RawComment, Stratum } from "../src/types.js";
import type { RawPR, RawCommit, RawFileDiff } from "./git.js";
import type { Index, Def } from "./index.js";
import type { FlowResult } from "./flow.js";

export function emit(
  pr: RawPR,
  index: Index,
  baseIndex: Index,
  flow: FlowResult,
  fileNameMap: Map<string, string>,
  outPath: string,
  meta?: { title?: string; number?: string; author?: string; repo?: string; comments?: RawComment[] }
): void {
  const entries = new Map<string, Entry>();
  // reuse flow entries as the base, then enrich
  for (const [id, e] of flow.entries) {
    entries.set(id, {
      ...e,
      kind: e.kind as EntryKind,
      traces: [...e.traces]
    });
  }

  // --- rename detection: same file, `function OLD(` in removed lines, `function NEW(` in added
  const renames = new Map<string, string>(); // new def id -> old name
  for (const f of pr.files) {
    const removedFns = new Set<string>();
    const addedFns = new Set<string>();
    for (const l of f.lines) {
      const del = l.text.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*[<(]/);
      if (l.kind === "del" && del) removedFns.add(del[1]);
      const add = l.text.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*[<(]/);
      if (l.kind === "add" && add) addedFns.add(add[1]);
    }
    for (const addName of addedFns) {
      for (const remName of removedFns) {
        if (remName !== addName && !remName.startsWith(addName)) {
          const def = [...entries.values()].find((e) => e.name === addName);
          if (def) renames.set(def.id, remName);
        }
      }
    }
  }

  // --- traces per entry
  for (const [id, e] of entries) {
    const def = index.byId.get(id);
    if (!def) continue;

    // uses on head
    const usesHead = countRefs(index, def);
    // uses that were part of this PR's edits (def's uses landing on changed lines)
    const changedFiles = new Set([...pr.paths]);
    const usesInDiff = def.uses.filter((u) => changedFiles.has(u.file)).length;
    const usesOutside = usesHead - usesInDiff;

    if (usesHead > 0) {
      e.traces.push({ relation: `${usesHead} reference${usesHead === 1 ? "" : "s"} at head \u00b7 ${usesInDiff} touched by this PR` });
    }

    // rename fact + kept-alias refs
    const oldName = renames.get(id);
    if (oldName) {
      e.traces.push({ relation: `renamed from ${oldName}()` });
      // kept-alias: a same-kind, same-file top-level def of the old name at head
      const headOld = index.defs.filter(
        (d) => d.name === oldName && d.file === def.file && d.kind === def.kind && d.topLevel
      );
      if (headOld.length) {
        const refs = countRefs(index, headOld[0]);
        e.traces.push({ relation: `${refs} references still use ${oldName}`, negative: true });
      } else {
        // export-alias pattern in the diff itself: `export { x as old }` or `old,` in export list
        const aliasExport = pr.files.some((f) =>
          f.lines.some((l) => l.kind === "add" && new RegExp(`\\bas\\s+${oldName}\\b|\\b${oldName}\\s*,|\\b${oldName}\\s*}`).test(l.text))
        );
        if (aliasExport) {
          e.traces.push({ relation: `export alias kept: ${oldName} (importable under old name)` });
        }
      }
    }

    // test coverage observation — quiet fact, not a gap: framework code is
    // typically covered indirectly via public API, so "0 direct refs" is ambient
    // information, not a hole in the change. Red gaps are reserved for facts a
    // reviewer must respond to (unupdated callers, broken renames).
    const coverageKinds = new Set(["function", "class", "method", "typeAlias", "interface", "const"]);
    const testFiles = ["test", "spec", "__tests__"];
    if (coverageKinds.has(def.kind) && def.topLevel) {
      const testRefs = def.uses.filter((u) => testFiles.some((t) => u.file.includes(t))).length;
      if (testRefs > 0) {
        const first = def.uses.find((u) => testFiles.some((t) => u.file.includes(t)))!;
        e.traces.push({ relation: `covered by ${first.file.split("/").pop()}`, file: first.file });
      } else {
        e.traces.push({ relation: "no direct test references" });
      }
    }
  }

  // --- components (largest first, deterministic)
  const components: ComponentDoc[] = flow.components
    .sort((x, y) => y.entryIds.length - x.entryIds.length)
    .map((c) => ({
      id: c.id,
      name: c.name,
      origin: c.origin,
      stats: `${c.entryIds.length} objects`,
      entryIds: c.entryIds
    }));

  // --- edges among displayed entries (both endpoints present in some component)
  const displayed = new Set(components.flatMap((c) => c.entryIds));
  const edges = flow.edges.filter((e) => displayed.has(e.a) && displayed.has(e.b));

  // --- commits (strata = time bands; merge commits are plumbing, excluded).
  // Bands follow SWEEPS — bursts of commit activity separated by a calendar-day
  // change or a gap over 2h — so a second pass bolted on an hour before the PR
  // was opened lands in a different band than the careful first draft. Up to 4
  // sweeps each get their own band; more are folded onto the 4-step ramp.
  // Fallback without timestamps: band by commit order.
  const MERGE_RE = /^Merge (pull request|branch|remote-tracking)/;
  const isMerge = (c: RawCommit): boolean => c.parents.split(" ").filter(Boolean).length >= 2 || MERGE_RE.test(c.message);
  const real = pr.commits.filter((c) => !isMerge(c));
  // content first introduced BY a merge commit = hand-resolved conflict lines
  const mergeShas = new Set(pr.commits.filter((c) => c.parents.split(" ").filter(Boolean).length >= 2).map((c) => c.sha));
  const bandOfSha = new Map<string, Stratum>();
  const chronological = [...real].reverse(); // oldest first
  if (chronological.length && chronological[0].ts) {
    const HOUR = 3600 * 1000;
    const sweeps: { shas: string[]; from: string; to: string }[] = [];
    let prev: number | null = null;
    let prevDay = "";
    for (const c of chronological) {
      const t = new Date(c.ts!.replace(" ", "T")).getTime();
      const day = c.ts!.slice(0, 10);
      if (prev === null || day !== prevDay || t - prev > 2 * HOUR) {
        sweeps.push({ shas: [], from: c.ts!, to: c.ts! });
      }
      const s = sweeps[sweeps.length - 1];
      s.shas.push(c.sha);
      s.to = c.ts!;
      prev = t;
      prevDay = day;
    }
    const n = sweeps.length;
    for (let i = 0; i < n; i++) {
      const band = (n <= 4 ? i + 1 : Math.min(4, Math.floor((i / n) * 4) + 1)) as Stratum;
      for (const sha of sweeps[i].shas) bandOfSha.set(sha, band);
    }
  } else {
    const m = Math.max(real.length, 1);
    real.forEach((c, i) => {
      // git log order is newest-first, so band 1 (oldest) maps to the LAST index
      const band = Math.min(3, Math.floor(((m - 1 - i) / m) * 4));
      bandOfSha.set(c.sha, (band + 1) as Stratum);
    });
  }

  // --- per-line time attribution: blame the head tree so every added line of
  // the whole-PR diff carries the band (and sha) of the commit that wrote it.
  // Context lines blame outside the PR window and stay unattributed — the
  // ribbons only mark code this PR actually produced. Multiple sweeps in one
  // file therefore render as different colors on adjacent lines.
  const blameCache = new Map<string, Map<number, string>>();
  const blameHead = (p: string): Map<number, string> => {
    let map = blameCache.get(p);
    if (!map) {
      map = new Map<number, string>();
      try {
        const out = execFileSync("git", ["-C", pr.repoDir, "blame", "-l", "--porcelain", pr.head, "--", p], {
          maxBuffer: 1024 * 1024 * 64,
          encoding: "utf8"
        });
        for (const row of out.split("\n")) {
          const bm = row.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/);
          if (bm) map.set(Number(bm[3]), bm[1]);
        }
      } catch { /* shallow or missing object: this file just gets no bands */ }
      blameCache.set(p, map);
    }
    return map;
  };
  for (const f of pr.files) {
    if (!f.lines.some((l) => l.kind === "add")) continue;
    const blame = blameHead(f.path);
    for (const l of f.lines) {
      if (l.kind !== "add" || l.new === undefined) continue;
      const sha = blame.get(l.new);
      const band = sha ? bandOfSha.get(sha) : undefined;
      if (sha && band) {
        l.stratum = band;
        l.by = sha.slice(0, 7);
      } else if (sha && mergeShas.has(sha)) {
        // first introduced by the merge commit itself: hand-resolved content
        l.by = sha.slice(0, 7);
        l.conflict = true;
      }
    }
  }

  const commits: Commit[] = pr.commits.map((c, i) => ({
    id: `c${i}`,
    sha: c.sha.slice(0, 7),
    at: Number(c.at) || undefined,
    author: c.author,
    day: c.day,
    time: c.time,
    ts: c.ts,
    message: c.message,
    stratum: bandOfSha.get(c.sha) ?? 1,
    touches: [],
    files: c.files.map((f) => stampOwn(f, bandOfSha.get(c.sha) ?? 1, c.sha.slice(0, 7)))
  }));

  // map commit touches: entry whose def file intersects commit paths
  for (const commit of commits) {
    const raw = pr.commits.find((c) => c.sha.startsWith(commit.sha));
    if (!raw) continue;
    for (const [id, e] of entries) {
      const def = index.byId.get(id);
      if (def && raw.paths.has(def.file)) commit.touches.push(id);
    }
  }

  // attach real diff files to entries — seeds only. Fill-only neighbors keep
  // "no diff": their file wasn't changed by this PR (they're unchanged context).
  for (const [id, e] of entries) {
    if (!e.seed) continue;
    const def = index.byId.get(id);
    if (!def) continue;
    const fileDiff = pr.files.find((f) => fileNameMap.get(f.path) === def.file);
    if (fileDiff) e.files = [toDiffLines(fileDiff)];
  }

  // thread + attach review comments to the entries whose file they discuss
  if (meta?.comments?.length) {
    const withPath = meta.comments.filter((c) => c.path);
    const nodes = new Map<string, Comment & { path: string; line: number | null; replies: Comment[] }>();
    withPath.forEach((c, i) => {
      nodes.set(String(c.id ?? `c${i}`), {
        id: String(c.id ?? `c${i}`),
        author: c.author,
        body: c.body,
        created: c.created,
        anchor: c.line ? `${c.path}:${c.line}` : c.path!,
        path: c.path!,
        line: c.line ?? null,
        replies: []
      });
    });

    // staleness: if the anchored line was rewritten by a commit newer than the
    // comment, record the before/after pair — what the reviewer saw vs what the
    // line says now. `before` comes from the file content at the newest commit
    // that existed when the comment was posted (one git show per stale thread).
    const byShort = new Map<string, { at: number; sha: string; ts?: string }>();
    for (const c of pr.commits) byShort.set(c.sha.slice(0, 7), { at: Number(c.at) || 0, sha: c.sha, ts: c.ts });
    const showFile = (rev: string, p: string): string | null => {
      try {
        return execFileSync("git", ["-C", pr.repoDir, "show", `${rev}:${p}`], {
          maxBuffer: 1024 * 1024 * 64,
          encoding: "utf8"
        });
      } catch { return null; }
    };
    for (const [, node] of nodes) {
      if (!node.created || !node.line) continue;
      const createdAt = Date.parse(node.created) / 1000;
      if (!Number.isFinite(createdAt)) continue;
      const fd = pr.files.find((f) => f.path === node.path);
      const row = fd?.lines.find((l) => l.kind !== "del" && l.new === node.line);
      const writer = row?.by ? byShort.get(row.by) : undefined;
      if (!writer || writer.at <= createdAt) continue;
      const headAtComment = [...pr.commits]
        .filter((cc) => Number(cc.at) <= createdAt)
        .sort((a, b) => Number(b.at) - Number(a.at))[0];
      let before: string | undefined;
      if (headAtComment) {
        const content = showFile(headAtComment.sha, node.path);
        if (content !== null) before = (content.split("\n")[node.line - 1] ?? "").trimEnd();
      }
      node.stale = { before, after: row!.text, in: writer.sha.slice(0, 7), at: writer.ts };
    }

    const roots: (Comment & { path: string })[] = [];
    withPath.forEach((c, i) => {
      const node = nodes.get(String(c.id ?? `c${i}`))!;
      const parent = c.inReplyTo != null ? nodes.get(String(c.inReplyTo)) : undefined;
      if (parent && parent !== node) parent.replies.push(node);
      else roots.push(node);
    });
    for (const [, e] of entries) {
      const p = e.files[0]?.path;
      if (!p) continue;
      const mine = roots.filter((r) => r.path === p);
      if (mine.length) e.comments = mine.map(({ path, ...rest }) => rest);
    }
  }

  /** diffs of files a trace points at (covering tests) that are not entries */
  const extraFiles = (): Record<string, ReturnType<typeof toDiffLines>> => {
    const out: Record<string, ReturnType<typeof toDiffLines>> = {};
    for (const [, e] of entries) {
      for (const t of e.traces) {
        if (!t.file || out[t.file]) continue;
        const fd = pr.files.find((f) => f.path === t.file);
        if (fd) out[t.file] = toDiffLines(fd);
      }
    }
    return out;
  };

  const prNum = meta?.number ?? pr.title.match(/#(\d+)/)?.[1] ?? "";
  // for merge-commit PRs: title/author come from the first real (non-merge) commit
  const isMergeSubject = /^Merge (pull request|branch|remote-tracking)/.test(pr.title);
  const firstReal = [...pr.commits].reverse().find((c) => !/^Merge (pull request|branch|remote-tracking)/.test(c.message));
  const prTitle = meta?.title ?? (isMergeSubject && firstReal ? firstReal.message : pr.title);
  const prAuthor = meta?.author ?? firstReal?.author ?? pr.commits[0]?.author ?? "unknown";
  const page: PageData & { entries: Record<string, Entry> } = {
    head: pr.head,
    pr: {
      repo: meta?.repo ?? "",
      number: prNum ? `#${prNum}` : "",
      title: prTitle,
      author: prAuthor
    } satisfies PRInfo,
    banner: `base ${pr.base.slice(0, 7)} \u2192 head ${pr.head.slice(0, 7)} \u00b7 TypeScript AST def\u2212use index \u00b7 3-hop co-change analysis \u00b7 per-line git blame`,
    initialComponent: components[0]?.id ?? "",
    components,
    commits,
    entries: Object.fromEntries(entries),
    edges,
    extraFiles: extraFiles()
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(page, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(`components: ${components.map((c) => `${c.name} [${c.entryIds.length}]`).join(" \u00b7 ")}`);
}

/** the whole-PR diff, per-line strata already attached by blame */
function toDiffLines(f: RawFileDiff) {
  return {
    path: f.path,
    delta: f.delta,
    lines: f.lines.map((l) => ({ ...l }))
  };
}

/** a commit's own diff: its adds and deletes happened at that commit —
    stamp both with its band so the commit lens colors honestly */
function stampOwn(f: RawFileDiff, band: Stratum, by: string) {
  return {
    path: f.path,
    delta: f.delta,
    lines: f.lines.map((l) =>
      l.kind === "add" || l.kind === "del" ? { ...l, stratum: band, by } : { ...l }
    )
  };
}

function countRefs(index: Index, def: Def): number {
  return def.uses.length;
}
