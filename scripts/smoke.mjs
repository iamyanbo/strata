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
