// Stage 1: Git — extract the raw shape of a merged PR.
// Deterministic: everything derives from (base, head) commit ids.

import { execFileSync } from "node:child_process";
import * as path from "node:path";

export interface RawLine {
  kind: "add" | "del" | "ctx";
  text: string;
  old?: number;
  new?: number;
  stratum?: 1 | 2 | 3 | 4;
  /** short sha of the commit this line came from (blame or own-diff stamping) */
  by?: string;
  /** first introduced by a merge commit — hand-resolved conflict content */
  conflict?: boolean;
}

export interface RawFileDiff {
  path: string;
  oldPath?: string;
  delta: string;
  lines: RawLine[];
}

export interface RawCommit {
  sha: string;
  /** parent shas, space-separated — two or more = merge commit */
  parents: string;
  /** author unix timestamp, seconds */
  at: string;
  author: string;
  day: string;
  time: string;
  /** ISO-ish local timestamp "YYYY-MM-DD HH:MM" — drives sweep clustering */
  ts?: string;
  message: string;
  files: RawFileDiff[];
  paths: Set<string>;
}

export interface RawPR {
  repoDir: string;
  base: string;
  head: string;
  title: string;
  commits: RawCommit[];
  files: RawFileDiff[];
  /** all paths changed across the PR (head-side paths) */
  paths: Set<string>;
  /** paths at base for same-path files (for base-tree indexing) */
  basePaths: Set<string>;
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], {
    maxBuffer: 1024 * 1024 * 64,
    encoding: "utf8"
  });
}

/** parse unified diff text into per-file line records */
export function parseUnifiedDiff(diff: string): RawFileDiff[] {
  const files: RawFileDiff[] = [];
  let cur: RawFileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = { path: m ? m[2] : raw, delta: "", lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("deleted file")) { cur.delta = "deleted"; continue; }
    if (raw.startsWith("new file")) { cur.delta = "new"; continue; }
    if (raw.startsWith("rename from")) { cur.oldPath = raw.slice("rename from ".length); continue; }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("index ")) continue;
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }
    if (raw.startsWith("+")) {
      cur.lines.push({ kind: "add", text: raw.slice(1), new: newLine++ });
    } else if (raw.startsWith("-")) {
      cur.lines.push({ kind: "del", text: raw.slice(1), old: oldLine++ });
    } else if (raw.startsWith(" ")) {
      cur.lines.push({ kind: "ctx", text: raw.slice(1), old: oldLine++, new: newLine++ });
    }
    // "\ No newline at end of file" and others are skipped
  }

  for (const f of files) {
    if (f.delta === "") {
      const adds = f.lines.filter((l) => l.kind === "add").length;
      const dels = f.lines.filter((l) => l.kind === "del").length;
      f.delta = `+${adds} \u2212${dels}`;
    }
  }
  return files;
}

export function loadPR(repoDir: string, mergeCommit: string): RawPR {
  const base = git(repoDir, ["rev-parse", `${mergeCommit}^`]).trim();
  const head = mergeCommit;

  const log = git(repoDir, ["log", `${base}..${head}`, "--format=%H%x09%P%x09%an%x09%at%x09%ad%x09%s", "--date=format:%a|%Y-%m-%d %H:%M|%H:%M"]);
  const commits: RawCommit[] = [];
  for (const row of log.trim().split("\n")) {
    if (!row) continue;
    const [sha, parents = "", author = "", at = "", date = "", message = ""] = row.split("\t");
    const [day = "", ts = "", time = ""] = date.split("|");
    commits.push({ sha, parents, at, author, day, time, ts, message, files: [], paths: new Set() });
  }

  const files = parseUnifiedDiff(git(repoDir, ["diff", `${base}..${head}`, "--find-renames"]));
  const paths = new Set(files.map((f) => f.path));
  const basePaths = new Set(files.filter((f) => !f.delta).map((f) => f.oldPath ?? f.path));

  // per-commit file scope: each commit carries its OWN diff — what that commit
  // alone changed — so the commit lens shows honest per-commit edits, and its
  // add lines can be stamped with the commit's time band. Paths feed the
  // commit→component analysis. Merge commits diff empty (plumbing).
  for (const c of commits) {
    const patch = git(repoDir, ["diff-tree", "--no-commit-id", "--find-renames", "-r", "-p", c.sha]);
    c.files = parseUnifiedDiff(patch);
    for (const f of c.files) c.paths.add(f.path);
  }

  return { repoDir, base, head, title: git(repoDir, ["log", "-1", "--format=%s", head]).trim(), commits, files, paths, basePaths };
}
