// Small DOM helpers shared by every view.
// Kept apart from the renderers so a module can build markup without pulling in
// the whole application.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl<T extends SVGElement = SVGElement>(tag: string, cls?: string): T {
  const e = document.createElementNS(SVG_NS, tag) as T;
  if (cls) e.setAttribute("class", cls);
  return e;
}

/** raw markup, for the hand-drawn icons and diagrams */
export function svgIcon(markup: string, cls = "ic"): HTMLElement {
  const span = el("span", cls);
  span.innerHTML = markup;
  return span;
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
