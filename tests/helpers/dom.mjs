// One jsdom window for the render tests: the browser globals the viewer needs,
// on a real origin so localStorage works (review checkpoints and the notes you
// write live there, and an opaque origin swallows both silently).

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function browser() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/"
  });
  for (const k of ["document", "window", "HTMLElement", "Element", "SVGSVGElement", "getComputedStyle", "localStorage"]) {
    globalThis[k] = dom.window[k];
  }
  globalThis.Element.prototype.scrollIntoView = () => {}; // jsdom gaps
  dom.window.scrollTo = () => {};
  return dom;
}

export function click(node) {
  node.dispatchEvent(new globalThis.window.MouseEvent("click", { bubbles: true }));
}

export function press(key) {
  globalThis.document.dispatchEvent(new globalThis.window.KeyboardEvent("keydown", { key, bubbles: true }));
}

export function dataset(name) {
  return JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url), "utf8"));
}

export async function viewer() {
  return import(pathToFileURL(process.cwd() + "/dist/src/render.js").href);
}

export const text = (sel) => globalThis.document.querySelector(sel)?.textContent ?? "";
export const all = (sel) => [...globalThis.document.querySelectorAll(sel)];
