// Stage 4: Emit — assemble the PageData JSON the viewer consumes.
// Traces are computed facts with provenance; nothing heuristic.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { PageData, Entry, ComponentDoc, Commit, PRInfo, EntryKind, Comment, RawComment, Stratum } from "../src/types.js";
import type { RawPR, RawCommit, RawFileDiff } from "./git.js";
import { sweepBands, isStaleWriter } from "./sweeps.js";
import type { Index, Def } from "./index.js";
import type { FlowResult } from "./flow.js";
import { defRange, insignificant } from "./flow.js";

export function emit(
  pr: RawPR,
  index: Index,
  baseIndex: Index,
  flow: FlowResult,
  fileNameMap: Map<string, string>,
  outPath: string,
  meta?: {
    title?: string;
    number?: string;
    author?: string;
    repo?: string;
    baseRef?: string;
    headRef?: string;
    headLabel?: string;
    comments?: RawComment[];
  }
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
  const bandOfSha = sweepBands(real);

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

  // --- deletions: blame cannot see a line that no longer exists at head, so a
  // removed line is attributed to the commit whose OWN diff removed that text.
  // Same provenance as an addition — the ribbon answers when, who and which
  // commit on both sides of the change, not just on the lines that survived.
  const removals = new Map<string, { sha: string; band: Stratum | undefined }[]>();
  for (const c of [...pr.commits].filter((c) => !isMerge(c)).reverse()) {
    for (const f of c.files) {
      for (const l of f.lines) {
        if (l.kind !== "del" || !l.text.trim()) continue;
        const key = `${f.path} ${l.text.trim()}`;
        if (!removals.has(key)) removals.set(key, []);
        removals.get(key)!.push({ sha: c.sha, band: bandOfSha.get(c.sha) });
      }
    }
  }
  // the same text can be removed more than once in a file; walk the whole-PR
  // deletions in order and consume the per-commit removals in the same order
  const taken = new Map<string, number>();
  for (const f of pr.files) {
    for (const l of f.lines) {
      if (l.kind !== "del" || !l.text.trim()) continue;
      const key = `${f.path} ${l.text.trim()}`;
      const list = removals.get(key);
      if (!list?.length) continue;
      const i = Math.min(taken.get(key) ?? 0, list.length - 1);
      taken.set(key, i + 1);
      const hit = list[i];
      if (hit.band) {
        l.stratum = hit.band;
        l.by = hit.sha.slice(0, 7);
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

  // map commit touches — filled in below, once every entry knows which lines
  // are actually its own; a commit touches an object when it wrote or removed
  // one of THAT object's lines, not merely a line somewhere in its file.

  // attach real diff files to entries — seeds only. Fill-only neighbors keep
  // "no diff": their file wasn't changed by this PR (they're unchanged context).
  //
  // The slice matters: an object gets the lines inside ITS OWN span, not the
  // whole file's diff. Six symbols declared in one edited file used to render
  // six copies of the same +145 -3, with the same threads and the same
  // introducing commit on each.
  const ranges = new Map<string, { start: number; end: number }>();
  for (const [id, e] of entries) {
    if (!e.seed) continue;
    const def = index.byId.get(id);
    if (!def) continue;
    const fileDiff = pr.files.find((f) => fileNameMap.get(f.path) === def.file);
    if (!fileDiff) continue;
    const r = defRange(index, def);
    ranges.set(id, r);
    const slice = sliceToRange(fileDiff, r.start, r.end);
    // an object whose only changed lines are blank or a separator rule did not
    // change: it drops to context, and the line itself falls to the file view
    const real = slice.lines.some((l) => l.kind !== "ctx" && !insignificant(l.text));
    e.files = real ? [slice] : [];
    if (!real) e.seed = false;
  }

  for (const [id, e] of entries) {
    const shas = new Set<string>();
    for (const f of e.files) for (const l of f.lines) if (l.by) shas.add(l.by);
    for (const commit of commits) if (shas.has(commit.sha)) commit.touches.push(id);
  }

  // threads on files no object covers, kept for the file lens
  const fileComments: Record<string, Comment[]> = {};

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
      if (!writer || !isStaleWriter(writer.at, node.created)) continue;
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
    // a thread belongs to the object whose span contains its line; one that
    // falls between objects goes to the nearest one in the same file, so no
    // thread is lost and none is shown on six cards at once
    const claimed = new Set<Comment & { path: string }>();
    for (const [id, e] of entries) {
      const p = e.files[0]?.path;
      const r = ranges.get(id);
      if (!p || !r) continue;
      const mine = roots.filter((c) => {
        const line = (c as { line?: number | null }).line;
        return c.path === p && line != null && line >= r.start && line <= r.end;
      });
      for (const c of mine) claimed.add(c);
      if (mine.length) e.comments = mine.map(({ path, ...rest }) => rest);
    }
    for (const c of roots) {
      if (claimed.has(c)) continue;
      const line = (c as { line?: number | null }).line ?? 0;
      let best: string | undefined;
      let bestGap = Infinity;
      for (const [id, e] of entries) {
        const r = ranges.get(id);
        if (!r || e.files[0]?.path !== c.path) continue;
        const gap = line < r.start ? r.start - line : line - r.end;
        if (gap < bestGap) { bestGap = gap; best = id; }
      }
      if (!best) {
        // no object in this file at all (docs, untyped sources, files with no
        // seeds): the thread still belongs to the PR, so the file lens shows it
        const { path, ...rest } = c;
        (fileComments[c.path] ??= []).push(rest);
        continue;
      }
      const e = entries.get(best)!;
      const { path, ...rest } = c;
      e.comments = [...(e.comments ?? []), rest];
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
  // branch lineage: where this PR merges from and to (GitHub head/base refs)
  const branch = meta?.baseRef && meta?.headRef
    ? { head: meta.headRef, base: meta.baseRef, label: meta.headLabel }
    : undefined;
  const branchLine = branch ? ` \u00b7 ${branch.head} \u2192 ${branch.base}` : "";
  const page: PageData & { entries: Record<string, Entry> } = {
    head: pr.head,
    base: pr.base,
    pr: {
      repo: meta?.repo ?? "",
      number: prNum ? `#${prNum}` : "",
      title: prTitle,
      author: prAuthor
    } satisfies PRInfo,
    banner: `base ${pr.base.slice(0, 7)} \u2192 head ${pr.head.slice(0, 7)} \u00b7 TypeScript AST def\u2212use index \u00b7 3-hop co-change analysis \u00b7 per-line git blame${branchLine}`,
    method: [
      "TypeScript AST def−use index over base and head",
      "components: flood fill from changed symbols, 3 hops",
      "per-line attribution: git blame for additions, per-commit diffs for deletions"
    ],
    branch,
    initialComponent: components[0]?.id ?? "",
    components,
    commits,
    entries: Object.fromEntries(entries),
    edges,
    fileComments,
    extraFiles: extraFiles(),
    files: pr.files.map(toDiffLines)
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(page, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(`components: ${components.map((c) => `${c.name} [${c.entryIds.length}]`).join(" \u00b7 ")}`);
}

/** the part of a file's diff that lies inside one object's head line span */
function sliceToRange(f: RawFileDiff, start: number, end: number): ReturnType<typeof toDiffLines> {
  const lines = [];
  let lastNew = 0;
  let add = 0;
  let del = 0;
  for (const l of f.lines) {
    if (l.new !== undefined) lastNew = l.new;
    const at = l.new ?? lastNew;
    if (at < start || at > end) continue;
    lines.push({ ...l });
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { path: f.path, delta: `+${add} −${del}`, lines };
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
