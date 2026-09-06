// Headless smoke test: load real pipeline JSON, run the viewer in both lenses,
// catch errors. Fails loudly if the graph or timeline render empty.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

// a real origin, so localStorage works — review checkpoints and the notes you
// write here both live there, and an opaque origin would silently swallow them
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.SVGSVGElement = dom.window.SVGSVGElement;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.localStorage = dom.window.localStorage;
Element.prototype.scrollIntoView = () => {}; // jsdom gap, real browsers have it
dom.window.scrollTo = () => {};                // ditto — the bar measures, jsdom cannot scroll

const { render } = await import("../dist/src/render.js");
const page = JSON.parse(readFileSync(new URL("../data/sample.json", import.meta.url), "utf8"));

try {
  render(page, "sample"); // a dataset name, so the export path is live

  // -- components lens --------------------------------------------------------
  const nodes = document.querySelectorAll(".gp-node").length;
  const edges = document.querySelectorAll(".gp-edge").length;
  const labels = document.querySelectorAll(".gp-label").length;
  const entries = document.querySelectorAll(".entry").length;
  console.log(`[components] entries: ${entries}, nodes: ${nodes}, edges: ${edges}, labels: ${labels}`);
  const storybar = document.querySelectorAll(".storybar").length;
  const stubLabels = document.querySelectorAll(".gp-stub-label").length;
  console.log(`[story] bar: ${storybar}, cross-component labels: ${stubLabels}`);

  // click a node -> card -> open button exists
  document.querySelector(".gp-node").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const card = document.querySelector(".gtip");
  const btn = card.querySelector(".gtip-open");
  console.log(`[components] card: ${card.style.display === "block"}, open-btn: ${!!btn}, pointer-events: ${getComputedStyle(card).pointerEvents}`);
  if (!nodes || !edges || !btn) {
    console.log("GRAPH BROKEN — dumping diagnostics");
    const c = page.components[0];
    console.log("component:", c.id, c.entryIds.slice(0, 2));
    console.log("entry keys sample:", Object.keys(page.entries).slice(0, 2));
    process.exit(1);
  }

  // -- object bar + compact rows: one screen per component, not sixteen ------
  const bar = document.querySelector(".objbar");
  const compact = document.querySelectorAll(".entry.compact").length;
  const open0 = document.querySelectorAll(".entry.open").length;
  const count0 = document.querySelector(".ob-count")?.textContent;
  console.log(`[objbar] present: ${!!bar}, compact rows: ${compact}, open cards: ${open0}, counter: ${count0}`);
  if (!bar || !compact || open0 !== 1) { console.log("OBJECT BAR BROKEN"); process.exit(1); }

  // next steps the counter and keeps exactly one object open (accordion)
  document.querySelectorAll(".ob-step")[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const count1 = document.querySelector(".ob-count")?.textContent;
  const open1 = document.querySelectorAll(".entry.open").length;
  console.log(`[objbar] after next: counter ${count0} -> ${count1}, open cards: ${open1}`);
  if (count1 === count0 || open1 !== 1) { console.log("OBJECT NAV BROKEN"); process.exit(1); }

  // j / k drive the same walk from the keyboard
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j", bubbles: true }));
  const count2 = document.querySelector(".ob-count")?.textContent;
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", bubbles: true }));
  const count3 = document.querySelector(".ob-count")?.textContent;
  console.log(`[keys] j -> ${count2}, k -> ${count3}`);
  if (count2 === count1 || count3 !== count1) { console.log("KEYBOARD NAV BROKEN"); process.exit(1); }

  // -- context objects live in one collapsed group, not between the changes --
  const group = document.querySelector(".entry.context-group");
  const unchangedInStream = [...document.querySelectorAll(".entries > .entry")]
    .filter((n) => n.classList.contains("fill") && !n.classList.contains("context-group")).length;
  console.log(`[context] group: ${group ? group.querySelector(".kind").textContent : "MISSING"}, collapsed: ${group?.classList.contains("compact")}, unchanged loose in the stream: ${unchangedInStream}`);
  if (!group || !group.classList.contains("compact") || unchangedInStream) { console.log("CONTEXT GROUPING BROKEN"); process.exit(1); }
  group.querySelector(".entry-head").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const revealed = document.querySelectorAll(".context-body > .entry").length;
  console.log(`[context] expanding reveals ${revealed} referenced object(s)`);
  if (!revealed) { console.log("CONTEXT GROUP EMPTY"); process.exit(1); }
  group.querySelector(".entry-head").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  // -- per-object diffs: no two objects show the same file-wide diff ----------
  const deltas = [...document.querySelectorAll(".entry .delta-chip")].map((d) => d.textContent);
  const dupes = deltas.filter((d, i) => deltas.indexOf(d) !== i && d !== "").length;
  const leftovers = document.querySelector(".entry.leftovers");
  console.log(`[slices] object deltas: ${[...new Set(deltas)].slice(0, 6).join(" ")}${deltas.length > 6 ? " …" : ""}`);
  console.log(`[slices] leftovers row: ${leftovers ? leftovers.querySelector(".row-meta").textContent : "MISSING"}`);
  if (!leftovers) { console.log("LEFTOVERS BROKEN"); process.exit(1); }
  // the open object's diff must be smaller than its whole file's diff
  {
    const openFile = document.querySelector(".entry.open .file .diff");
    const rows = openFile ? openFile.querySelectorAll(".ln").length : 0;
    const whole = page.files.find((f) => f.path.endsWith("to-json-schema.ts"));
    console.log(`[slices] open object shows ${rows} rows of a ${whole.lines.length}-row file diff`);
    if (!rows || rows >= whole.lines.length) { console.log("SLICING BROKEN"); process.exit(1); }
  }

  // -- directed edges: arrowheads, state classes, hoverable hit lines ---------
  const arrows = document.querySelectorAll(".gp-edge[marker-end], .gp-edge[marker-start]").length;
  const kinds = ["co", "risk", "out", "quiet"].map((k) => `${k}:${document.querySelectorAll(`.gp-edge.k-${k}`).length}`);
  const hits = document.querySelectorAll(".gp-edge-hit").length;
  const markers = document.querySelectorAll("marker").length;
  console.log(`[edges] arrowheads: ${arrows}, markers: ${markers}, hit lines: ${hits}, states ${kinds.join(" ")}`);
  if (!arrows || markers !== 4 || !hits) { console.log("DIRECTED EDGES BROKEN"); process.exit(1); }

  // -- connections: expand a card, expect rows with real call sites ----------
  document.querySelector(".entry .entry-head").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const conns = document.querySelectorAll(".conn").length;
  const sites = document.querySelectorAll(".conn-site").length;
  const sum = document.querySelector(".conn-sum");
  console.log(`[connections] rows: ${conns}, call sites shown: ${sites} · ${sum ? sum.textContent : "NO SUMMARY"}`);
  if (!conns || !sites) { console.log("CONNECTIONS BROKEN"); process.exit(1); }

  // a call site expands into a labeled peek at unchanged head source
  const siteBtn = document.querySelector(".conn-site");
  siteBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const peek = document.querySelector(".peek.open");
  const peekLines = peek ? peek.querySelectorAll(".peek-line").length : 0;
  const atLine = peek ? peek.querySelectorAll(".peek-line.at").length : 0;
  console.log(`[peek] lines: ${peekLines}, marked call line: ${atLine}, note: ${peek ? peek.querySelector(".peek-note").textContent.slice(-40) : "NONE"}`);
  if (!peekLines || atLine !== 1) { console.log("CALL SITE PEEK BROKEN"); process.exit(1); }

  // hovering a connection row must light the matching wire in the graph
  document.querySelector(".conn").dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
  document.querySelector(".conn").dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: true }));
  const lit = document.querySelectorAll(".graphbox.focusing .gp-edge.hi").length;
  console.log(`[link] connection hover lights ${lit} edge(s) in the graph`);
  if (!lit) { console.log("CROSS-PANEL HIGHLIGHT BROKEN"); process.exit(1); }
  document.querySelector(".conn").dispatchEvent(new dom.window.MouseEvent("mouseleave", { bubbles: true }));

  // -- notes: write one on a diff line, see it inline and in the export -------
  // n jumps to the next unread CHANGED object, which is the one with a diff
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "n", bubbles: true }));
  const noteBtn = document.querySelector(".ln.add .ln-note");
  noteBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const ta = document.querySelector(".composer-in");
  ta.value = "smoke: does this handle an empty $defs?";
  [...document.querySelectorAll(".composer-actions .strip-btn")].pop()
    .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const notes = document.querySelectorAll(".note").length;
  const noteText = document.querySelector(".note-body")?.textContent ?? "";
  console.log(`[notes] rendered inline: ${notes}, body: ${JSON.stringify(noteText.slice(0, 32))}`);
  if (!notes || !noteText) { console.log("NOTE COMPOSER BROKEN"); process.exit(1); }

  // a note on a deleted line must anchor to the OLD file (GitHub side LEFT)
  const delBtn = document.querySelector(".ln.del .ln-note");
  if (delBtn) {
    delBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const ta2 = document.querySelector(".composer-in");
    ta2.value = "smoke: why was this removed?";
    [...document.querySelectorAll(".composer-actions .strip-btn")].pop()
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  }
  const stored = JSON.parse(dom.window.localStorage.getItem(`strata-notes:${page.pr.repo}${page.pr.number}`) ?? "[]");
  console.log(`[notes] stored: ${stored.map((d) => `${d.path.split("/").pop()}:${d.line} ${d.side}`).join(" | ")}`);
  if (stored.length !== 2 || !stored.some((d) => d.side === "LEFT")) { console.log("NOTE ANCHORING BROKEN"); process.exit(1); }

  // the export button counts them and the card lists them as yours
  const expBtn = document.querySelector(".theme-toggle.has-notes");
  console.log(`[export] button: ${expBtn ? expBtn.textContent : "MISSING"}`);
  expBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const mineRows = document.querySelectorAll(".exp-row.mine").length;
  const checked = [...document.querySelectorAll(".exp-row input")].filter((i) => i.checked).length;
  console.log(`[export] card rows from strata: ${mineRows}, checked: ${checked}`);
  if (mineRows !== 2 || !checked) { console.log("EXPORT CARD BROKEN"); process.exit(1); }
  document.querySelector(".overlay").remove();
  dom.window.localStorage.clear();

  // -- commits lens -----------------------------------------------------------
  document.querySelector('[data-mode="commits"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const matrix = document.querySelectorAll(".matrix td.s1, .matrix td.s2, .matrix td.s3, .matrix td.s4").length;
  const timeKey = document.querySelectorAll(".time-key .tk").length;
  const rows = document.querySelectorAll(".hist-row").length;
  const lanes = document.querySelectorAll(".hist-av").length;
  const days = document.querySelectorAll(".hist-day").length;
  const dayOrder = [...document.querySelectorAll(".hist-day-t")].map((d) => d.textContent);
  console.log(`[commits] matrix cells: ${matrix}, time-key swatches: ${timeKey}, history rows: ${rows}, avatars: ${lanes}, day headers: ${days} (${dayOrder.join(" → ")})`);

  // click first history row -> commit doc renders
  document.querySelector(".hist-row").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const docHead = document.querySelector(".doc-head h1");
  console.log(`[commits] doc after row click: ${docHead ? docHead.textContent.slice(0, 48) : "MISSING"}`);

  if (!rows || !lanes || !docHead) {
    console.log("HISTORY BROKEN");
    process.exit(1);
  }

  // -- ribbons: attributed lines carry a colored tick, context lines none -----
  const d2 = document.querySelectorAll(".diff .ln.add .ribbon.s1, .diff .ln.add .ribbon.s2, .diff .ln.add .ribbon.s3, .diff .ln.add .ribbon.s4").length;
  const bare = document.querySelectorAll(".diff .ribbon:not([class*=' s'])").length;
  console.log(`[ribbons] attributed: ${d2}, unattributed (should be present but invisible): ${bare}`);

  // -- the file lens: every changed file reachable, runs labeled by owner ----
  document.querySelector('[data-mode="files"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const railFiles = document.querySelectorAll(".rail .comp").length;
  const runs = document.querySelectorAll(".run-head").length;
  const owned = document.querySelectorAll(".run-jump").length;
  const orphanRuns = document.querySelectorAll(".run-none").length;
  const barCount = document.querySelector(".ob-count")?.textContent;
  console.log(`[files] rail: ${railFiles} files, bar ${barCount}, runs: ${runs} (${owned} owned, ${orphanRuns} unowned)`);
  if (railFiles !== page.files.length || !runs || !owned || !orphanRuns) { console.log("FILE LENS BROKEN"); process.exit(1); }

  // j walks files, and every changed line of the PR is reachable this way
  const seen = new Set();
  for (let i = 0; i < page.files.length; i++) {
    const path = document.querySelector(".doc .file-head .path").textContent;
    seen.add(path);
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j", bubbles: true }));
  }
  const covered = page.files.filter((f) => seen.has(f.path)).length;
  const lines = page.files.reduce((n, f) => n + f.lines.filter((l) => l.kind !== "ctx").length, 0);
  console.log(`[files] walking j reached ${covered}/${page.files.length} files (${lines} changed lines, all reachable)`);
  if (covered !== page.files.length) { console.log("FILE WALK BROKEN"); process.exit(1); }

  console.log("SMOKE OK");
} catch (err) {
  console.error("RENDER THREW:", err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n") : err);
  process.exit(1);
}
