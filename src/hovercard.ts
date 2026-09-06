// One floating card shared by every hover surface — diff ticks, graph edges,
// chips. Quiet, positioned next to its anchor, clamped to the viewport.

import { el } from "./dom.js";

let hcard: HTMLDivElement | null = null;

export function showHoverCard(anchor: Element, build: (card: HTMLElement) => void): void {
  if (!hcard) {
    hcard = el("div", "hcard");
    document.body.appendChild(hcard);
  }
  hcard.textContent = "";
  build(hcard);
  hcard.style.display = "block";
  const r = anchor.getBoundingClientRect();
  const w = hcard.offsetWidth;
  const h = hcard.offsetHeight;
  let x = r.right + 10;
  let y = r.top + 2;
  if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - 10);
  if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
  hcard.style.left = `${x}px`;
  hcard.style.top = `${y}px`;
}

export function hideHoverCard(): void {
  if (hcard) hcard.style.display = "none";
}
