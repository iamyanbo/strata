// Stage 3: Flow — seeds from the diff, flood fill over def-use edges,
// merge overlapping fills into components. Deterministic.

import type { RawPR, RawFileDiff } from "./git.js";
import * as fs from "node:fs";
import type { Index, Def } from "./index.js";

export interface Component {
  id: string;
  name: string;
  origin: string;
  entryIds: string[];
}

export interface EntryData {
  id: string;
  kind: string;
  name: string;
  summary: string;
  files: RawFileDiff[];
  traces: { relation: string; component?: string; object?: string; negative?: boolean }[];
  /** reference count at head — graph node size */
  refs: number;
  /** changed in this PR (seed) vs pulled in by the fill (neighbor) */
  seed: boolean;
}

/** one reference of b inside a: the source line that justifies the edge */
export interface CallSite {
  file: string;
  line: number;
  text: string;
  /** a few head lines around the reference, so an unchanged caller can be read
      in place without pretending it is part of the diff */
  ctx?: string[];
  /** 1-based line number of ctx[0] */
  ctxStart?: number;
}

/** a references b, with up to SITE_CAP of the actual reference sites */
export interface Edge { a: string; b: string; rel: string; refs?: number; sites?: CallSite[] }

export interface FlowResult {
  entries: Map<string, EntryData>;
  components: Component[];
  /** seed def id -> component id */
  seedMap: Map<string, string>;
  /** def−use edges among top-level defs (a references b) */
  edges: Edge[];
}

const MAX_HOPS = 3;
const CTX_SPAN = 3; // head lines kept either side of a reference
const SITE_CAP = 3; // reference sites kept per edge — enough to explain it, not a dump

// The span a top-level def occupies, including its leading trivia, so a change
// to a symbol's doc comment — or the removal of its old signature, which sits
// just above the new one — counts as a change to that symbol. Spans are clamped
// against the previous def in the file so no line belongs to two objects.
const rangeCache = new Map<string, Map<string, { start: number; end: number }>>();

function fileRanges(index: Index, file: string): Map<string, { start: number; end: number }> {
  let map = rangeCache.get(file);
  if (map) return map;
  map = new Map();
  const defs = index.defs
    .filter((d) => d.file === file && d.topLevel)
    .sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const d of defs) {
    const end = offsetToLine(d.file, d.end, index);
    const start = Math.max(offsetToLine(d.file, d.full, index), prevEnd + 1);
    map.set(d.id, { start: Math.min(start, end), end });
    prevEnd = Math.max(prevEnd, end);
  }
  rangeCache.set(file, map);
  return map;
}

/** the head line span a top-level def occupies — the object's own territory */
export function defRange(index: Index, d: Def): { start: number; end: number } {
  return fileRanges(index, d.file).get(d.id)
    ?? { start: offsetToLine(d.file, d.start, index), end: offsetToLine(d.file, d.end, index) };
}

/** a changed line that says nothing about the code: blank, or a rule of
    slashes, dashes or equals. Moving one of these does not change a symbol,
    and letting it count made blank-line shifts look like edits. */
export function insignificant(text: string): boolean {
  const t = text.trim();
  return !t || /^[/*\-=#~_ ]+$/.test(t);
}

/** head line numbers a file's diff touched, blank and separator lines aside:
    an added line is its own head line, a deleted line is attributed to the head
    line it sits against */
export function changedHeadLines(f: RawFileDiff): Set<number> {
  const out = new Set<number>();
  let lastNew = 0;
  for (const l of f.lines) {
    if (l.new !== undefined) lastNew = l.new;
    if (l.kind === "ctx" || insignificant(l.text)) continue;
    out.add(l.new ?? Math.max(1, lastNew));
  }
  return out;
}

/** seeds: top-level defs with a changed line inside their OWN span.
    Testing against the whole file's changed range (as this once did) makes
    every symbol in a heavily edited file look changed, and then every one of
    them ends up showing the same file-wide diff. */
export function findSeeds(pr: RawPR, index: Index, fileNameMap: Map<string, string>): Set<string> {
  const seeds = new Set<string>();
  for (const f of pr.files) {
    const headPath = fileNameMap.get(f.path);
    if (!headPath) continue;
    const touched = changedHeadLines(f);
    if (!touched.size) continue;
    for (const d of index.defs) {
      if (d.file !== headPath || !d.topLevel) continue;
      const r = defRange(index, d);
      for (const n of touched) {
        if (n >= r.start && n <= r.end) { seeds.add(d.id); break; }
      }
    }
  }
  return seeds;
}

const lineTables = new Map<string, number[]>(); // headPath -> line start offsets

function offsetToLine(file: string, offset: number, index: Index): number {
  let starts = lineTables.get(file);
  if (!starts) {
    const text = fs.readFileSync(`${index.root}/${file}`, "utf8");
    starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    lineTables.set(file, starts);
  }
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const fileTexts = new Map<string, string[]>(); // headPath -> source lines

/** the trimmed source text of one line, for showing a call site verbatim */
function sourceLine(file: string, line: number, index: Index): string {
  let lines = fileTexts.get(file);
  if (!lines) {
    try {
      lines = fs.readFileSync(`${index.root}/${file}`, "utf8").split(/\r?\n/);
    } catch {
      lines = [];
    }
    fileTexts.set(file, lines);
  }
  return (lines[line - 1] ?? "").trim().slice(0, 160);
}

/** the head source around a reference: enough to see what the call is doing */
function sourceWindow(file: string, line: number, index: Index): { ctx: string[]; ctxStart: number } {
  sourceLine(file, line, index); // fills the cache
  const lines = fileTexts.get(file) ?? [];
  const start = Math.max(1, line - CTX_SPAN);
  const end = Math.min(lines.length, line + CTX_SPAN);
  return {
    ctx: lines.slice(start - 1, end).map((l) => l.replace(/\s+$/, "").slice(0, 200)),
    ctxStart: start
  };
}

/** adjacency: def -> defs that reference it (callers) and defs it references (callees) */
export function buildAdjacency(index: Index): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  // enclosing TOP-LEVEL def: refs inside locals route to the function that owns them
  const spans: { file: string; start: number; end: number; defId: string }[] = [];
  for (const d of index.defs) if (d.topLevel) spans.push({ file: d.file, start: d.start, end: d.end, defId: d.id });
  spans.sort((a, b) => b.end - a.start - (b.end - b.start) || a.start - b.start);

  const enclosing = (file: string, offset: number): string | null => {
    for (const s of spans) {
      if (s.file === file && s.start <= offset && offset <= s.end) return s.defId;
    }
    return null;
  };

  for (const d of index.defs) {
    if (!d.topLevel) continue; // locals/properties must not leak into the graph
    for (const u of d.uses) {
      const caller = enclosing(u.file, u.start);
      // edge: caller-def references d (def-use)
      if (caller && caller !== d.id) touch(caller, d.id);
    }
  }
  return adj;
}

/** BFS flood fills from seeds; fills sharing any node merge into components */
export function floodFill(
  seeds: Set<string>,
  adj: Map<string, Set<string>>,
  index: Index,
  pr: RawPR
): FlowResult {
  const membership = new Map<string, number>(); // node -> fill index
  const fills: Set<string>[] = [];
  let fillIdx = 0;

  for (const seed of seeds) {
    if (membership.has(seed)) continue;
    const seen = new Set<string>([seed]);
    const queue: [string, number][] = [[seed, 0]];
    while (queue.length) {
      const [node, hops] = queue.shift()!;
      if (hops >= MAX_HOPS) continue;
      for (const next of adj.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push([next, hops + 1]);
        }
      }
    }
    for (const node of seen) if (!membership.has(node)) membership.set(node, fillIdx);
    fills.push(seen);
    fillIdx++;
  }

  // merge fills that share nodes (union-find over membership)
  const groups = new Map<number, Set<string>>();
  const groupOf = new Map<string, number>();
  let nextGroup = 0;
  for (const fill of fills) {
    const existing = [...fill].map((n) => groupOf.get(n)).find((g) => g !== undefined);
    if (existing !== undefined) {
      const g = groups.get(existing)!;
      for (const n of fill) { g.add(n); groupOf.set(n, existing); }
    } else {
      const g = new Set(fill);
      groups.set(nextGroup, g);
      for (const n of fill) groupOf.set(n, nextGroup);
      nextGroup++;
    }
  }

  // build components from groups that contain at least one seed
  const seedByGroup = new Map<number, string[]>();
  for (const seed of seeds) {
    const g = groupOf.get(seed);
    if (g === undefined) continue;
    const arr = seedByGroup.get(g) ?? [];
    arr.push(seed);
    seedByGroup.set(g, arr);
  }

  const components: Component[] = [];
  const entries = new Map<string, EntryData>();
  const seedMap = new Map<string, string>();

  for (const [g, nodes] of groups) {
    const gseeds = seedByGroup.get(g) ?? [];
    if (!gseeds.length) continue;

    const seedDefs = gseeds.map((id) => index.byId.get(id)!).filter(Boolean);
    const nameSeed = seedDefs.sort((a, b) => (b.uses.length - a.uses.length))[0];
    const name = nameSeed ? nameSeed.name : `group-${g}`;

    const cid = `flow-${g}`;
    // display surface: top seeds by refs (capped) + top neighbors (capped at 16 total)
    const byRefs0 = (x: string, y: string) =>
      (index.byId.get(y)?.uses.length ?? 0) - (index.byId.get(x)?.uses.length ?? 0);
    const sortedSeeds = [...gseeds].sort(byRefs0);
    const display = new Set<string>(sortedSeeds.slice(0, 14));
    const neighbors = [...adj.get(gseeds[0]) ?? []]
      .concat(...gseeds.slice(1).map((s) => [...adj.get(s) ?? []]))
      .filter((n) => index.byId.has(n) && index.byId.get(n)!.topLevel)
      .sort(byRefs0);
    for (const n of neighbors) {
      if (display.size >= 16) break;
      display.add(n);
    }
    // deterministic order: seeds first (by refs), then neighbors (by refs)
    const byRefs = byRefs0;
    const entryList = [...display].sort(byRefs);

    for (const n of nodes) {
      const d = index.byId.get(n)!;
      if (!display.has(n)) continue;
      if (!entries.has(n)) {
        entries.set(n, {
          id: n,
          kind: d.kind,
          name: d.name,
          summary: `${d.kind} in ${d.file}`,
          files: [],
          traces: [],
          refs: d.uses.length,
          seed: gseeds.includes(n)
        });
      }
    }

    components.push({
      id: cid,
      name,
      origin: (() => {
        // a rename can seed twenty symbols; name a handful and count the rest
        const all = gseeds.map((s) => index.byId.get(s)?.name ?? s);
        const shown = all.slice(0, 6).join(", ");
        const more = all.length > 6 ? ` and ${all.length - 6} more` : "";
        return `derived from changed symbols ${shown}${more} · def−use edges · 3-hop reach`;
      })(),
      entryIds: entryList
    });
    for (const s of gseeds) seedMap.set(s, cid);
  }

  const allEdges = collectEdges();
  return { entries, components, seedMap, edges: allEdges };

  function collectEdges(): Edge[] {
    const out: Edge[] = [];
    const byKey = new Map<string, Edge>();

    // walk uses again: caller(top-level def enclosing the reference) -> referenced def
    const spans: { file: string; start: number; end: number; defId: string }[] = [];
    for (const d of index.defs) if (d.topLevel) spans.push({ file: d.file, start: d.start, end: d.end, defId: d.id });
    spans.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const enclosing = (file: string, offset: number): string | null => {
      for (const s of spans) {
        if (s.file === file && s.start <= offset && offset <= s.end) return s.defId;
      }
      return null;
    };
    for (const d of index.defs) {
      if (!d.topLevel) continue;
      for (const u of d.uses) {
        const caller = enclosing(u.file, u.start);
        if (caller && caller !== d.id) {
          const key = `${caller}->${d.id}`;
          let edge = byKey.get(key);
          if (!edge) {
            edge = { a: caller, b: d.id, rel: "def\u2212use", refs: 0, sites: [] };
            byKey.set(key, edge);
            out.push(edge);
          }
          // the reference sites ARE the answer to "why is this edge here" — keep
          // a few verbatim (deduped per line) and count the rest
          const line = offsetToLine(u.file, u.start, index);
          if (!edge.sites!.some((st) => st.file === u.file && st.line === line)) {
            edge.refs = (edge.refs ?? 0) + 1;
            if (edge.sites!.length < SITE_CAP) {
              edge.sites!.push({
                file: u.file, line, text: sourceLine(u.file, line, index),
                ...sourceWindow(u.file, line, index)
              });
            }
          }
        }
      }
    }
    return out;
  }
}
