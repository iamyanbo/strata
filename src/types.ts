// ---- core types ------------------------------------------------------------
// One PR, two lenses over the same data:
//   "by commit"    — the time axis: commits grouped by date
//   "by component" — the correlation axis: flood fill from changed symbols
//                    over data/control-flow edges; overlapping fills merge.
// A commit FEEDS components; a component is WRITTEN BY commits (ribbons).

export type Stratum = 1 | 2 | 3 | 4; // 1 = oldest, 4 = newest

export type LineKind = "add" | "del" | "ctx" | "move";

export interface DiffLine {
  kind: LineKind;
  old?: number;
  new?: number;
  text: string;
  stratum?: Stratum;
  /** short sha of the commit this line was written in (blame / own-diff) */
  by?: string;
  /** first introduced by a merge commit — hand-resolved conflict content */
  conflict?: boolean;
}

export interface FileDiff {
  path: string;
  delta: string;
  lines: DiffLine[];
}

export interface Comment {
  id?: string;
  author: string;
  /** ISO timestamp of the comment — drives the staleness check */
  created?: string;
  /** the anchored line was rewritten after this comment was posted */
  stale?: {
    /** what the line said when the comment was posted */
    before?: string;
    /** what it says now */
    after?: string;
    /** short sha of the commit that rewrote it */
    in?: string;
    /** local timestamp of the rewrite */
    at?: string;
  };
  /** symbol anchor, e.g. "fetchUser@e7f2a9c" — survives force-pushes */
  anchor?: string;
  body: string;
  resolved?: boolean;
  replies?: Comment[];
}

/** raw comment as fetched from the GitHub API (pre-threading) */
export interface RawComment {
  id?: string | number;
  path?: string;
  line?: number | null;
  created?: string;
  author: string;
  body: string;
  inReplyTo?: string | number;
}

/** A deterministic trace: this object relates to `object` in `component`.
    `negative` states something MISSING. */
export interface TraceLink {
  relation: string;
  component?: string;
  object?: string;
  /** repo file this fact points at (e.g. the covering test) */
  file?: string;
  negative?: boolean;
}

export type EntryKind = "function" | "type" | "route" | "config" | "block";

/** One changed object. May appear in several components (things correlate). */
export interface Entry {
  id: string;
  kind: EntryKind;
  name: string;
  /** deterministic one-liner shown at overview level */
  summary: string;
  files: FileDiff[];
  traces: TraceLink[];
  comments?: Comment[];
  /** reference count at head — graph node size (pipeline data) */
  refs?: number;
  /** changed in this PR (seed) vs pulled in by the fill (pipeline data) */
  seed?: boolean;
}

/** A component DERIVED by flood fill from changed symbols.
    Not a folder — a correlated set of code. May span folders and
    overlap with other components. */
export interface ComponentDoc {
  id: string;
  name: string;
  /** deterministic description of how the fill was formed */
  origin: string;
  stats: string;
  entryIds: string[];
}

/** A commit on the time axis. */
export interface Commit {
  id: string;
  sha: string;
  /** author unix timestamp (seconds) — exact ordering for staleness checks */
  at?: number;
  author: string;
  day: string;
  time: string;
  /** local timestamp "YYYY-MM-DD HH:MM" — exact when, drives the time key */
  ts?: string;
  message: string;
  stratum: Stratum;
  /** entry ids this commit's changes belong to (feeds components) */
  touches: string[];
  files: FileDiff[];
}

export interface PRInfo {
  repo: string;
  number: string;
  title: string;
  author: string;
}

export type Mode = "commits" | "components";

export interface PageData {
  pr: PRInfo;
  /** full sha of the PR head — commit_id for review exports */
  head?: string;
  banner: string;
  initialComponent: string;
  components: ComponentDoc[];
  commits: Commit[];
  /** all entry objects, keyed by id */
  entries: Record<string, Entry>;
  /** def−use edges between entries (a references b) */
  edges?: { a: string; b: string; rel: string }[];
  /** diffs of referenced files that are not entries (e.g. covering tests) */
  extraFiles?: Record<string, FileDiff>;
}
