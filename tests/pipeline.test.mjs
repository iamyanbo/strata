// Unit tests for the pipeline's pure functions.
//   npm test   (builds implicitly assume `npx tsc` has run — CI runs tsc first)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "../dist/pipeline/git.js";
import { sweepBands, isStaleWriter, SWEEP_GAP_HOURS } from "../dist/pipeline/sweeps.js";
import { insignificant, changedHeadLines } from "../dist/pipeline/flow.js";
import { parsePrUrl } from "../scripts/analyze.mjs";
import { readFileSync } from "node:fs";

// ---- parseUnifiedDiff --------------------------------------------------------

const SAMPLE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,3 @@",
  "+const a = 1;",
  "+const b = 2;",
  "+",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,3 +1,2 @@",
  " const keep = true;",
  "-dead();",
  "+alive();"
].join("\n");

test("parseUnifiedDiff: kinds, numbering and deltas", () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);
  assert.equal(files.length, 2);

  const [added, changed] = files;
  assert.equal(added.path, "src/a.ts");
  assert.equal(added.delta, "new");
  assert.deepEqual(added.lines.map((l) => l.kind), ["add", "add", "add"]);
  assert.deepEqual(added.lines.map((l) => l.new), [1, 2, 3]);
  assert.ok(added.lines.every((l) => l.old === undefined));

  assert.equal(changed.path, "src/b.ts");
  assert.equal(changed.delta, "+1 \u22121");
  assert.deepEqual(changed.lines.map((l) => l.kind), ["ctx", "del", "add"]);
  assert.equal(changed.lines[0].old, 1);
  assert.equal(changed.lines[0].new, 1);
  assert.equal(changed.lines[1].old, 2);
  assert.equal(changed.lines[2].new, 2);
});

test("parseUnifiedDiff: empty input yields no files", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
});

// ---- sweepBands ----------------------------------------------------------------

const mk = (sha, ts) => ({
  sha, parents: "", at: "0", author: "", day: ts?.slice(0, 3) ?? "",
  time: "", ts, message: "", files: [], paths: new Set()
});

test("sweepBands: one sitting stays in band 1", () => {
  // newest-first input, all within the gap on the same day
  const bands = sweepBands([mk("c", "2022-01-01 11:30"), mk("b", "2022-01-01 10:30"), mk("a", "2022-01-01 10:00")]);
  assert.equal(bands.get("a"), 1);
  assert.equal(bands.get("b"), 1);
  assert.equal(bands.get("c"), 1);
});

test("sweepBands: a gap beyond the threshold starts a new band", () => {
  const bands = sweepBands([mk("new", "2022-01-01 18:00"), mk("old", "2022-01-01 10:00")]);
  assert.equal(bands.get("old"), 1);
  assert.equal(bands.get("new"), 2);
});

test("sweepBands: a calendar-day change starts a new band even without a gap", () => {
  const bands = sweepBands([mk("late", "2022-01-02 00:30"), mk("early", "2022-01-01 23:45")]);
  assert.equal(bands.get("early"), 1);
  assert.equal(bands.get("late"), 2);
});

test("sweepBands: more than 4 sweeps fold onto the 4-step ramp", () => {
  const mkDay = (i) => `2022-01-${String(i + 1).padStart(2, "0")} 10:00`;
  const commits = [];
  for (let i = 10; i >= 1; i--) commits.push(mk(`d${i}`, mkDay(i - 1))); // newest day first
  const bands = sweepBands(commits);
  assert.equal(bands.get("d1"), 1); // oldest sweep
  assert.equal(bands.get("d10"), 4); // newest sweep
  const values = new Set(bands.values());
  assert.deepEqual([...values].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test("sweepBands: without timestamps, bands follow commit order", () => {
  const bands = sweepBands([mk("n1"), mk("n2"), mk("n3"), mk("n4")]);
  assert.equal(bands.get("n1"), 4); // newest
  assert.equal(bands.get("n4"), 1); // oldest
});

// ---- staleness rule --------------------------------------------------------------

test("isStaleWriter: rewrite newer than the comment is stale", () => {
  const writerAt = Date.parse("2022-02-01T21:51:00Z") / 1000;
  assert.equal(isStaleWriter(writerAt, "2022-02-01T19:00:00Z"), true);
  assert.equal(isStaleWriter(writerAt, "2022-02-02T08:00:00Z"), false);
  assert.equal(isStaleWriter(writerAt, "not a date"), false);
});

// ---- PR url parsing ---------------------------------------------------------------

test("parsePrUrl: full url, short form, trailing junk", () => {
  assert.deepEqual(parsePrUrl("https://github.com/colinhacks/zod/pull/899"), { owner: "colinhacks", repo: "zod", num: "899" });
  assert.deepEqual(parsePrUrl("owner/repo#123"), { owner: "owner", repo: "repo", num: "123" });
  assert.deepEqual(parsePrUrl("  https://github.com/a/b.git/pull/7  "), { owner: "a", repo: "b", num: "7" });
  assert.throws(() => parsePrUrl("not a pr"));
});

test("sweep gap knob defaults to 2 hours", () => {
  assert.equal(SWEEP_GAP_HOURS, 2);
});

// ---- graph edges -------------------------------------------------------------
// Edges are directed (a references b) and carry the reference sites that
// justify them — the graph panel and the Connections block both read these.

test("bundled dataset: every edge is directed and carries its call sites", () => {
  const page = JSON.parse(readFileSync(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.ok(page.edges.length > 0, "sample has edges");
  for (const e of page.edges) {
    assert.ok(page.entries[e.a] && page.entries[e.b], `both endpoints exist: ${e.a} -> ${e.b}`);
    assert.notEqual(e.a, e.b, "no self edges");
    assert.ok(Array.isArray(e.sites) && e.sites.length > 0, `edge has call sites: ${e.a} -> ${e.b}`);
    assert.ok(e.refs >= e.sites.length, "refs counts at least the sites kept");
    for (const s of e.sites) {
      assert.match(s.file, /\.tsx?$/);
      assert.ok(s.line > 0 && s.text.length > 0, "site points at real source");
      // context lets an unchanged caller be read in place, so the reference
      // line must actually be inside the window we shipped
      assert.ok(Array.isArray(s.ctx) && s.ctx.length > 0, "site carries context");
      assert.ok(s.ctxStart <= s.line && s.line < s.ctxStart + s.ctx.length,
        `call line ${s.line} inside ctx window ${s.ctxStart}..${s.ctxStart + s.ctx.length - 1}`);
      // site text is capped shorter than the context line, so compare prefixes
      assert.ok(s.ctx[s.line - s.ctxStart].trim().startsWith(s.text.trim().slice(0, 60)),
        "context line matches the site text");
    }
  }
  // direction is meaningful: a caller referencing itself both ways would be a bug
  const keys = new Set(page.edges.map((e) => `${e.a}->${e.b}`));
  assert.equal(keys.size, page.edges.length, "no duplicate directed edges");
});

// ---- what counts as a change -------------------------------------------------
// A symbol is "changed" when a changed line falls inside its span. Blank lines
// and separator rules must not count, or an added blank above a //////// banner
// reads as an edit to the interface below it.

test("insignificant: blanks and rules say nothing about the code", () => {
  for (const t of ["", "   ", "	", "////////////////", "// ----", "=====", "/*", "*/", "  ***  "]) {
    assert.equal(insignificant(t), true, JSON.stringify(t));
  }
  for (const t of ["const a = 1;", "// explain the thing", "}", "import x from 'y';", "* @param a"]) {
    assert.equal(insignificant(t), false, JSON.stringify(t));
  }
});

test("changedHeadLines: additions map to their line, deletions to the line they sit against", () => {
  const f = {
    path: "a.ts",
    delta: "",
    lines: [
      { kind: "ctx", old: 10, new: 10, text: "keep" },
      { kind: "del", old: 11, text: "gone" },          // sits against head line 10
      { kind: "add", new: 11, text: "fresh" },
      { kind: "add", new: 12, text: "" },              // blank: not a change
      { kind: "ctx", old: 12, new: 13, text: "keep" }
    ]
  };
  assert.deepEqual([...changedHeadLines(f)].sort((a, b) => a - b), [10, 11]);
});

test("changedHeadLines: a file of nothing but blank shifts touches no line", () => {
  const f = { path: "a.ts", delta: "", lines: [{ kind: "add", new: 4, text: "   " }, { kind: "del", old: 9, text: "" }] };
  assert.equal(changedHeadLines(f).size, 0);
});

// ---- dataset invariants ------------------------------------------------------

const sample = JSON.parse(readFileSync(new URL("../data/sample.json", import.meta.url), "utf8"));

test("bundled dataset: no two objects claim the same line", () => {
  const owner = new Map();
  for (const [id, e] of Object.entries(sample.entries)) {
    for (const f of e.files ?? []) {
      for (const l of f.lines) {
        const key = `${f.path}|${l.kind}|${l.old ?? ""}|${l.new ?? ""}`;
        assert.equal(owner.get(key) ?? id, id, `${key} claimed by two objects`);
        owner.set(key, id);
      }
    }
  }
});

test("bundled dataset: a changed object has at least one line of real code", () => {
  for (const [id, e] of Object.entries(sample.entries)) {
    if (!e.seed) continue;
    const real = (e.files ?? []).some((f) =>
      f.lines.some((l) => l.kind !== "ctx" && !insignificant(l.text)));
    assert.ok(real, `${id} is marked changed but nothing in it changed`);
  }
});

test("bundled dataset: every changed line is attributed to a commit", () => {
  const shas = new Set(sample.commits.map((c) => c.sha));
  for (const f of sample.files) {
    for (const l of f.lines) {
      if (l.kind === "ctx") continue;
      assert.ok(l.by, `${f.path}:${l.new ?? l.old} has no commit`);
      assert.ok(shas.has(l.by), `${l.by} is not a commit of this PR`);
    }
  }
});

test("bundled dataset: the lineage the header links to is present", () => {
  assert.match(sample.head, /^[0-9a-f]{40}$/);
  assert.match(sample.base, /^[0-9a-f]{40}$/);
  assert.ok(sample.branch.head && sample.branch.base);
  assert.ok(Array.isArray(sample.method) && sample.method.length);
});
