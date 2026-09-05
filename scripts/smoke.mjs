// Headless smoke test: load real pipeline JSON, run the viewer in both lenses,
// catch errors. Fails loudly if the graph or timeline render empty.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.SVGSVGElement = dom.window.SVGSVGElement;
globalThis.getComputedStyle = dom.window.getComputedStyle;
Element.prototype.scrollIntoView = () => {}; // jsdom gap, real browsers have it

const { render } = await import("../dist/src/render.js");
const page = JSON.parse(readFileSync(new URL("../data/sample.json", import.meta.url), "utf8"));

try {
  render(page);

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

  console.log("SMOKE OK");
} catch (err) {
  console.error("RENDER THREW:", err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n") : err);
  process.exit(1);
}
