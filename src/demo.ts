// The landing page's demo: a small, working replica of the viewer.
//
// It is not a screenshot and not a video — it is the same markup vocabulary and
// the same tokens the app uses, wired to a canned slice of the bundled sample
// PR. The lens switch works, the ribbons and edges answer hover, and the whole
// stage replays itself. Everything here is inert data; nothing is fetched.

import { el, svgEl } from "./dom.js";
import { showHoverCard, hideHoverCard } from "./hovercard.js";
import { deltaChip } from "./format.js";

type Lens = "commits" | "components" | "files";

const LENSES: { id: Lens; label: string }[] = [
  { id: "commits", label: "By commit" },
  { id: "components", label: "By component" },
  { id: "files", label: "By file" }
];

interface Row {
  band?: 1 | 2 | 3 | 4;
  kind: "add" | "del" | "ctx";
  no: string;
  text: string;
  /** what the ribbon says on hover */
  by?: { who: string; when: string; msg: string; removed?: boolean };
}

const OBJECT_ROWS: Row[] = [
  { kind: "ctx", no: "211", text: "  ): JSONSchema.BaseSchema {" },
  {
    kind: "del", band: 4, no: "212", text: "export function process<T extends schemas.$ZodType>(",
    by: { who: "Colin McDonnell", when: "Aug 31 · 15:44", msg: "Rename the JSON Schema `process` helper", removed: true }
  },
  {
    kind: "add", band: 1, no: "212", text: "// never rename this back to `process`: bundler polyfills",
    by: { who: "Colin McDonnell", when: "Aug 31 · 15:44", msg: "Rename the JSON Schema `process` helper" }
  },
  {
    kind: "add", band: 1, no: "213", text: "export function processSchema<T extends schemas.$ZodType>(",
    by: { who: "Colin McDonnell", when: "Aug 31 · 15:44", msg: "Rename the JSON Schema `process` helper" }
  },
  { kind: "ctx", no: "214", text: "  schema: T," }
];

const COMMIT_ROWS: Row[] = [
  { kind: "ctx", no: "104", text: "  process(schema: schemas.$ZodType) {" },
  {
    kind: "del", band: 4, no: "105", text: "    return process(schema, this.ctx, _params);",
    by: { who: "Colin McDonnell", when: "Aug 31 · 15:44", msg: "Rename the JSON Schema `process` helper", removed: true }
  },
  {
    kind: "add", band: 1, no: "105", text: "    return processSchema(schema, this.ctx, _params);",
    by: { who: "Colin McDonnell", when: "Aug 31 · 15:44", msg: "Rename the JSON Schema `process` helper" }
  },
  { kind: "ctx", no: "106", text: "  }" }
];

const NODES = [
  { id: "a", x: 22, y: 22, r: 7, cls: "ghost", name: "arrayProcessor" },
  { id: "b", x: 80, y: 24, r: 6, cls: "ghost", name: "objectProcessor" },
  { id: "c", x: 138, y: 20, r: 7, cls: "ghost", name: "unionProcessor" },
  { id: "hub", x: 80, y: 64, r: 12, cls: "hub", name: "processSchema" },
  { id: "d", x: 42, y: 104, r: 7, cls: "", name: "ToJSONSchemaContext" },
  { id: "e", x: 120, y: 104, r: 7, cls: "", name: "JSONSchema" }
];

const EDGES = [
  { from: "a", to: "hub", risk: true, site: "json-schema-processors.ts:297" },
  { from: "b", to: "hub", risk: true, site: "json-schema-processors.ts:341" },
  { from: "c", to: "hub", risk: true, site: "json-schema-processors.ts:433" },
  { from: "hub", to: "d", risk: false, site: "to-json-schema.ts:215" },
  { from: "hub", to: "e", risk: false, site: "to-json-schema.ts:217" }
];

const reduced = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** one diff row, with a ribbon that answers when, who and which commit */
function diffRow(r: Row, i: number): HTMLElement {
  const row = el("div", `shot-ln ${r.kind}`);
  row.style.setProperty("--i", String(i));
  const rib = el("i", `shot-rib${r.band ? ` s${r.band}` : ""}${r.kind === "del" && r.band ? " del" : ""}`);
  if (r.by) {
    rib.addEventListener("mouseenter", () => showHoverCard(rib, (card) => {
      const when = el("span", "hc-when");
      when.append(el("i", `tk-tick s${r.band}`), el("b", undefined, `${r.by!.removed ? "removed" : "written"} ${r.by!.when}`));
      card.append(when, el("div", "hc-who", r.by!.who), el("div", "hc-msg", r.by!.msg));
    }));
    rib.addEventListener("mouseleave", hideHoverCard);
  }
  const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
  row.append(rib, el("span", "shot-no", r.no), el("span", "shot-sign", sign), el("code", undefined, r.text));

  // the note affordance, exactly where the app puts it
  const note = el("button", "shot-note", "＋");
  note.title = "comment on this line";
  note.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = row.parentElement?.querySelector(".shot-composer");
    open?.remove();
    if (open && open.previousElementSibling === row) return;
    const box = el("div", "shot-composer");
    box.append(
      el("span", "shot-comp-who", "you"),
      el("span", "shot-comp-body", "notes anchor to this line and leave as one GitHub review")
    );
    row.insertAdjacentElement("afterend", box);
  });
  row.appendChild(note);
  return row;
}

function diffBlock(path: string, add: number, del: number, rows: Row[]): HTMLElement {
  const box = el("div", "shot-file");
  const head = el("div", "shot-file-head");
  head.append(el("span", "shot-path", path), deltaChip(add, del));
  box.appendChild(head);
  rows.forEach((r, i) => box.appendChild(diffRow(r, i)));
  return box;
}

/** the dependency graph, wired the way the real one is: hovering a node lifts
    its neighbourhood, hovering an edge names the call site behind it */
function miniGraph(): HTMLElement {
  const wrap = el("div", "shot-graph");
  const svg = svgEl<SVGSVGElement>("svg", "shot-svg");
  svg.setAttribute("viewBox", "0 0 160 126");
  svg.setAttribute("aria-label", "dependency graph: three unchanged callers reaching a changed function");

  const defs = svgEl("defs");
  defs.innerHTML = `<marker id="dm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9 z" fill="context-stroke"/></marker>`;
  svg.appendChild(defs);

  const at = (id: string) => NODES.find((n) => n.id === id)!;
  const lines: { el: SVGLineElement; from: string; to: string }[] = [];
  EDGES.forEach((e, i) => {
    const a = at(e.from);
    const b = at(e.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const line = svgEl<SVGLineElement>("line", `sh-edge${e.risk ? " risk" : ""}`);
    line.setAttribute("x1", String(a.x + (dx / len) * (a.r + 2)));
    line.setAttribute("y1", String(a.y + (dy / len) * (a.r + 2)));
    line.setAttribute("x2", String(b.x - (dx / len) * (b.r + 5)));
    line.setAttribute("y2", String(b.y - (dy / len) * (b.r + 5)));
    line.setAttribute("marker-end", "url(#dm)");
    line.style.setProperty("--len", String(len));
    line.style.setProperty("--i", String(i));
    const hit = svgEl<SVGLineElement>("line", "sh-hit");
    for (const k of ["x1", "y1", "x2", "y2"]) hit.setAttribute(k, line.getAttribute(k)!);
    hit.addEventListener("mouseenter", () => {
      wrap.classList.add("lit");
      line.classList.add("hi");
      showHoverCard(hit, (card) => {
        const head = el("div", "hc-edge");
        head.append(el("code", undefined, at(e.from).name), el("span", "hc-arrow", " → "), el("code", undefined, at(e.to).name));
        card.append(head, el("div", `hc-kind${e.risk ? " k-risk" : ""}`,
          e.risk ? "caller is UNCHANGED and depends on changed code" : "changed code reaching into unchanged code"));
        card.appendChild(el("div", "hc-site", e.site));
      });
    });
    hit.addEventListener("mouseleave", () => {
      wrap.classList.remove("lit");
      line.classList.remove("hi");
      hideHoverCard();
    });
    svg.append(line, hit);
    lines.push({ el: line, from: e.from, to: e.to });
  });

  for (const [i, n] of NODES.entries()) {
    const g = svgEl<SVGGElement>("g", "sh-g");
    const c = svgEl<SVGCircleElement>("circle", `sh-node ${n.cls}`);
    c.setAttribute("cx", String(n.x));
    c.setAttribute("cy", String(n.y));
    c.setAttribute("r", String(n.r));
    c.style.setProperty("--i", String(i));
    const label = svgEl<SVGTextElement>("text", "sh-label");
    label.textContent = n.name.length > 15 ? n.name.slice(0, 14) + "…" : n.name;
    label.setAttribute("x", String(n.x));
    label.setAttribute("y", String(n.y + n.r + 9));
    label.setAttribute("text-anchor", "middle");
    g.append(c, label);
    g.addEventListener("mouseenter", () => {
      wrap.classList.add("lit");
      g.classList.add("hi");
      for (const l of lines) if (l.from === n.id || l.to === n.id) l.el.classList.add("hi");
    });
    g.addEventListener("mouseleave", () => {
      wrap.classList.remove("lit");
      g.classList.remove("hi");
      for (const l of lines) l.el.classList.remove("hi");
    });
    svg.appendChild(g);
  }

  wrap.append(svg, el("div", "shot-legend", "3 unchanged callers depend on changed code"));
  return wrap;
}

// ---- the three lenses ---------------------------------------------------------

function componentsView(): HTMLElement {
  const body = el("div", "shot-body");
  const doc = el("div", "shot-doc");
  const head = el("div", "shot-head");
  head.append(
    el("span", "shot-tick"),
    el("span", "shot-name", "processSchema"),
    el("span", "shot-kind", "FUNCTION"),
    deltaChip(3, 2),
    el("span", "shot-refs", "7 refs")
  );
  doc.append(head, diffBlock("packages/zod/src/v4/core/to-json-schema.ts", 3, 2, OBJECT_ROWS));
  doc.appendChild(el("p", "shot-foot", "hover a tick for the commit that wrote the line · hover the graph for the call site"));
  body.append(doc, miniGraph());
  return body;
}

function commitsView(): HTMLElement {
  const body = el("div", "shot-body");
  const doc = el("div", "shot-doc");
  const head = el("div", "shot-head");
  head.append(el("span", "shot-name", "Rename the JSON Schema `process` helper"), el("span", "shot-kind", "18E71C7"));
  doc.append(head, diffBlock("packages/zod/src/v4/core/json-schema-generator.ts", 1, 1, COMMIT_ROWS));
  doc.appendChild(el("p", "shot-foot", "one commit at a time, in the order they landed"));

  const side = el("div", "shot-side");
  side.appendChild(el("div", "shot-side-h", "HISTORY"));
  const hist: { band: number; msg: string; who: string; when: string }[] = [
    { band: 1, msg: "Rename the JSON Schema `process` helper", who: "Colin McDonnell", when: "15:44 · 18e71c7" },
    { band: 2, msg: "keep an export alias for the old name", who: "Colin McDonnell", when: "16:02 · a41f9c2" },
    { band: 4, msg: "coverage update", who: "Colin McDonnell", when: "19:48 · 4116dae" }
  ];
  hist.forEach((h, i) => {
    const row = el("div", `shot-hist${i === 0 ? " on" : ""}`);
    row.style.setProperty("--i", String(i));
    row.append(
      el("i", `shot-dot s${h.band}`),
      el("span", "shot-hist-msg", h.msg),
      el("span", "shot-hist-meta", h.when)
    );
    side.appendChild(row);
  });
  body.append(doc, side);
  return body;
}

function filesView(): HTMLElement {
  const body = el("div", "shot-body");
  const doc = el("div", "shot-doc");
  const head = el("div", "shot-head");
  head.append(el("span", "shot-name", "to-json-schema.ts"), deltaChip(9, 5));
  doc.appendChild(head);

  const box = el("div", "shot-file");
  const runA = el("div", "shot-run");
  runA.append(el("span", "shot-run-in", "in "), el("code", undefined, "processSchema"), el("span", "shot-run-kind", "FUNCTION"));
  box.appendChild(runA);
  OBJECT_ROWS.slice(1, 4).forEach((r, i) => box.appendChild(diffRow(r, i)));
  const runB = el("div", "shot-run none");
  runB.appendChild(el("span", undefined, "no object"));
  box.appendChild(runB);
  box.appendChild(diffRow({ kind: "add", band: 1, no: "13", text: "  processSchema," }, 3));
  doc.appendChild(box);
  doc.appendChild(el("p", "shot-foot", "every changed line, in order — each run named by the object that owns it"));

  const side = el("div", "shot-side");
  side.appendChild(el("div", "shot-side-h", "FILES · 4"));
  const files = [
    { name: "to-json-schema.ts", add: 9, del: 5, on: true, obj: true },
    { name: "json-schema-processors.ts", add: 25, del: 25, on: false, obj: true },
    { name: "polyfill-collision.test.ts", add: 46, del: 0, on: false, obj: false },
    { name: "coverage.svg", add: 1, del: 1, on: false, obj: false }
  ];
  files.forEach((f, i) => {
    const row = el("div", `shot-filerow${f.on ? " on" : ""}`);
    row.style.setProperty("--i", String(i));
    row.append(el("span", "shot-fname", f.name), deltaChip(f.add, f.del));
    if (!f.obj) row.appendChild(el("span", "shot-noobj", "no object"));
    side.appendChild(row);
  });
  body.append(doc, side);
  return body;
}

const VIEWS: Record<Lens, () => HTMLElement> = {
  commits: commitsView,
  components: componentsView,
  files: filesView
};

/** the whole demo: a lens switch that works, and a stage that replays */
export function demoShot(): HTMLElement {
  const shot = el("div", "shot");
  let lens: Lens = "components";
  let cycling = !reduced();
  let timer = 0;

  const bar = el("div", "shot-bar");
  const seg = el("div", "shot-seg");
  const buttons = new Map<Lens, HTMLElement>();
  for (const l of LENSES) {
    const b = el("button", "shot-seg-b", l.label);
    b.addEventListener("click", () => { stop(); show(l.id); });
    buttons.set(l.id, b);
    seg.appendChild(b);
  }
  const counter = el("span", "shot-count");
  const replay = el("button", "shot-replay", "▶ replay");
  replay.addEventListener("click", () => { stop(); show(lens); });
  bar.append(seg, counter, el("span", "spacer"), el("span", "shot-keys", "live demo"), replay);

  const stage = el("div", "shot-stage");

  function show(next: Lens): void {
    lens = next;
    for (const [id, b] of buttons) b.classList.toggle("on", id === lens);
    counter.textContent = lens === "components" ? "1 / 14 objects" : lens === "files" ? "1 / 4 files" : "1 / 12 commits";
    stage.textContent = "";
    const view = VIEWS[lens]();
    stage.appendChild(view);
    // restart the entry animation: strip the class, force a reflow, re-add
    stage.classList.remove("in");
    void stage.offsetWidth;
    if (!reduced()) stage.classList.add("in");
  }

  function stop(): void {
    cycling = false;
    if (timer) { window.clearInterval(timer); timer = 0; }
    shot.classList.add("touched");
  }

  show("components");
  if (cycling) {
    timer = window.setInterval(() => {
      const order: Lens[] = ["components", "files", "commits"];
      show(order[(order.indexOf(lens) + 1) % order.length]);
    }, 5200);
    // hovering the demo means you are reading it, not watching it
    shot.addEventListener("mouseenter", stop, { once: true });
  }

  shot.append(bar, stage);
  return shot;
}
