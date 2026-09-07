// The viewer, rendered against the bundled dataset in jsdom.
//
// These run in order and share one document on purpose: a reviewer's session is
// stateful (open an object, write a note, mark it read), and the bugs worth
// catching live in that sequence rather than in any single render.

import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, click, press, dataset, viewer, all, text } from "./helpers/dom.mjs";

const dom = browser();
const { render } = await viewer();
const page = dataset("sample");
const comp = page.components.find((c) => c.id === page.initialComponent) ?? page.components[0];
const changedIn = (c) => c.entryIds.filter((id) => page.entries[id]?.seed).length;

render(page, "sample");

test("the component lens renders both panels", () => {
  assert.ok(all(".entry").length, "objects");
  assert.ok(all(".gp-node").length, "graph nodes");
  assert.ok(all(".gp-edge").length, "graph edges");
  assert.equal(all(".gp-label").length, all(".gp-node").length, "every node is labelled");
});

test("graph edges are directed and carry their call sites", () => {
  assert.ok(all(".gp-edge[marker-end], .gp-edge[marker-start]").length, "arrowheads");
  assert.equal(all("marker").length, 4, "one arrowhead per edge state");
  assert.ok(all(".gp-edge-hit").length, "hover targets");
});

test("the sticky bar walks only what changed, biggest first", () => {
  const counter = text(".ob-count");
  assert.match(counter, /^1 \/ \d+$/);
  const stops = Number(counter.split("/")[1]);
  // changed objects, plus the card holding changes no symbol owns
  assert.equal(stops, changedIn(comp) + (all(".entry.rest").length ? 1 : 0));
  assert.equal(all(".entry.open").length, 1, "one object open at a time");
});

test("j and k step the walk, and the counter follows", () => {
  const start = text(".ob-count");
  press("j");
  const next = text(".ob-count");
  assert.notEqual(next, start);
  press("k");
  assert.equal(text(".ob-count"), start);
});

test("an object shows its own slice, not its whole file", () => {
  const rows = all(".entry.open .file .diff .ln").length;
  const whole = page.files.find((f) => f.path.endsWith("to-json-schema.ts"));
  assert.ok(rows > 0, "the open object has a diff");
  assert.ok(rows < whole.lines.length, `${rows} rows is a slice of ${whole.lines.length}`);
});

test("unchanged objects are grouped, collapsed, and out of the review", () => {
  const group = document.querySelector(".entry.context-group");
  assert.ok(group, "the group exists");
  assert.ok(group.classList.contains("compact"), "collapsed by default");
  const loose = all(".entries > .entry").filter(
    (n) => n.classList.contains("fill") && !n.classList.contains("context-group")
  );
  assert.equal(loose.length, 0, "nothing unchanged sits between the changes");

  click(group.querySelector(".entry-head"));
  assert.ok(all(".context-body > .entry").length, "expanding reveals them");
  assert.equal(all(".context-body .read-tick").length, 0, "and none can be ticked off");
  click(group.querySelector(".entry-head"));
});

test("changes no symbol owns are a card of their own, and reviewable", () => {
  const rest = document.querySelector(".entry.rest");
  assert.ok(rest, "the card exists");
  assert.ok(rest.querySelector(".read-tick"), "it can be marked read");
  assert.ok(/\d+ lines?/.test(rest.querySelector(".trace-badge").textContent));
});

test("connections list callers with the call site that justifies them", () => {
  press("n"); // the first unread changed object
  const conns = all(".conn");
  assert.ok(conns.length, "connection rows");
  assert.ok(all(".conn-site").length, "call sites");
  click(document.querySelector(".conn-site"));
  const peek = document.querySelector(".peek.open");
  assert.ok(peek, "a call site opens in place");
  assert.equal(peek.querySelectorAll(".peek-line.at").length, 1, "the call line is marked");
});

test("hovering a connection lights the matching edge in the graph", () => {
  document.querySelector(".conn").dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: false }));
  assert.equal(all(".graphbox.focusing .gp-edge.hi").length, 1);
  document.querySelector(".conn").dispatchEvent(new dom.window.MouseEvent("mouseleave", { bubbles: false }));
});

test("a note anchors to the right side of the diff", () => {
  const add = document.querySelector(".ln.add .ln-note");
  assert.ok(add, "added lines offer a note");
  click(add);
  document.querySelector(".composer-in").value = "does this handle an empty $defs?";
  click(all(".composer-actions .strip-btn").pop());

  const del = document.querySelector(".ln.del .ln-note");
  click(del);
  document.querySelector(".composer-in").value = "why was this removed?";
  click(all(".composer-actions .strip-btn").pop());

  const notes = JSON.parse(localStorage.getItem(`strata-notes:${page.pr.repo}${page.pr.number}`));
  assert.equal(notes.length, 2);
  // a removed line lives in the old file, which is the side GitHub wants
  assert.deepEqual(notes.map((n) => n.side).sort(), ["LEFT", "RIGHT"]);
  assert.ok(all(".note").length, "and they render inline");
});

test("notes reach the export card as yours", () => {
  const button = document.querySelector(".theme-toggle.has-notes");
  assert.ok(button, "the topbar counts them");
  assert.match(button.textContent, /2 notes to push/);
  click(button);
  assert.equal(all(".exp-row.mine").length, 2);
  assert.equal(all(".exp-row input").filter((i) => i.checked).length, 2);
  document.querySelector(".overlay").remove();
});

test("a thread from GitHub is listed but cannot be re-posted", () => {
  // the dataset's own threads have nowhere to go: they came from there
  click(document.querySelector(".theme-toggle"));
  const rows = all(".exp-row");
  const fromGithub = rows.filter((r) => r.querySelector(".note-chip")?.textContent === "from github");
  for (const r of fromGithub) {
    assert.equal(r.querySelector("input").disabled, true, "not selectable");
    assert.equal(r.querySelector("input").checked, false, "not checked");
  }
  document.querySelector(".overlay")?.remove();
});

test("mark reviewed checkpoints AND ticks everything off", () => {
  click(document.querySelector(".review-strip .strip-btn"));
  const state = JSON.parse(localStorage.getItem(`strata-review:${page.pr.repo}${page.pr.number}`));
  const changed = Object.values(page.entries).filter((e) => e.seed).length;
  assert.ok(state.read.length >= changed, "every changed object is read");
  assert.ok(state.reviewedAt > 0, "and a checkpoint was taken");
  assert.equal(document.querySelector(".ob-next"), null, "nothing left unread");
  assert.ok(all(".read-tick.on").length, "ticks show on screen");
});

test("a new push un-reads only what it touched", () => {
  const key = `strata-review:${page.pr.repo}${page.pr.number}`;
  const state = JSON.parse(localStorage.getItem(key));
  const dropped = state.seenCommits.shift(); // pretend this commit just landed
  localStorage.setItem(key, JSON.stringify(state));
  render(page, "sample");

  const touched = Object.entries(page.entries).filter(([, e]) =>
    e.seed && (e.files ?? []).some((f) => f.lines.some((l) => l.kind !== "ctx" && l.by === dropped)));
  assert.ok(touched.length, "the commit touched something");
  const stillRead = all(".entries > .entry .read-tick.on").length;
  assert.equal(stillRead, 0, "objects it wrote came back to unread");
});

test("reset forgets the checkpoint and every tick", () => {
  click(document.querySelector(".review-strip .strip-btn.ghost"));
  assert.equal(localStorage.getItem(`strata-review:${page.pr.repo}${page.pr.number}`), null);
  assert.equal(all(".read-tick.on").length, 0);
});

test("the untested chip stays off types, which no test can exercise", () => {
  click(document.querySelector('[data-mode="components"]'));
  for (const card of all(".entries > .entry")) {
    const kind = card.querySelector(".kind")?.textContent ?? "";
    if (kind === "TYPEALIAS" || kind === "INTERFACE") {
      assert.equal(card.querySelector(".untested-chip"), null, `${kind} should not claim to be untested`);
    }
  }
});

test("the commit lens renders history and a commit's diff", () => {
  click(document.querySelector('[data-mode="commits"]'));
  assert.ok(all(".hist-row").length, "history rows");
  assert.ok(all(".matrix td").length, "the contributions matrix");
  click(document.querySelector(".hist-row"));
  assert.ok(text(".doc-head h1").length, "the commit opens");
  assert.equal(document.querySelector(".commit-nav"), null, "no duplicate nav at the bottom");
});

test("the file lens reaches every changed file", () => {
  click(document.querySelector('[data-mode="files"]'));
  assert.equal(all(".rail .comp").length, page.files.length, "every file in the rail");
  assert.ok(all(".run-jump").length, "runs owned by an object");
  assert.ok(all(".run-none").length, "and runs owned by none");

  const seen = new Set();
  for (let i = 0; i < page.files.length; i++) {
    seen.add(text(".doc .file-head .path"));
    press("j");
  }
  assert.equal(seen.size, page.files.length, "j walks all of them");
});

test("every diff line carries its commit, deletions included", () => {
  const lines = page.files.flatMap((f) => f.lines);
  const adds = lines.filter((l) => l.kind === "add");
  const dels = lines.filter((l) => l.kind === "del");
  assert.ok(adds.every((l) => l.by), "additions are attributed");
  assert.ok(dels.every((l) => l.by), "so are deletions");
});
