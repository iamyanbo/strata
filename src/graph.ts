// The dependency graph panel: the component's local shape, drawn from the
// def−use edges the flood fill walked.
//
// It reads the page through render.ts and calls back into it to navigate. The
// two modules import each other on purpose — every crossing happens at call
// time, never while the modules are evaluating.

import type { ComponentDoc, Entry, GraphEdge } from "./types.js";
import { el, svgEl } from "./dom.js";
import { isMergeCommit } from "./format.js";
import { showHoverCard, hideHoverCard } from "./hovercard.js";
import { page, entry, component, selectComponent, commitsOf } from "./render.js";

function internalEdges(comp: ComponentDoc): { a: string; b: string; rel: string }[] {
  // real pipeline data carries explicit def−use edges
  if (page.edges) {
    const members = new Set(comp.entryIds);
    return page.edges.filter((e) => members.has(e.a) && members.has(e.b));
  }
  // mock fallback: derive from trace links
  const seen = new Set<string>();
  const edges: { a: string; b: string; rel: string }[] = [];
  for (const id of comp.entryIds) {
    const e = entry(id);
    if (!e) continue;
    for (const t of e.traces) {
      if (t.component === comp.id && t.object && comp.entryIds.includes(t.object)) {
        const key = [id, t.object].sort().join("→");
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ a: id, b: t.object, rel: t.relation });
        }
      }
    }
  }
  return edges;
}

// node encodings: size = log refs (how much code depends on it),
// fill = changed by this PR (seed) vs pulled in by the fill (neighbor).

function nodeRefs(id: string): number {
  return entry(id)?.refs ?? 2;
}

export function nodeSeed(id: string): boolean {
  const e = entry(id);
  if (e?.seed !== undefined) return e.seed;
  return (e?.files?.length ?? 0) > 0; // mock fallback
}

/** the time band (1 oldest → 4 newest) of the commit that introduced this entry,
    or null for fill-only neighbors no commit touched directly */
function nodeBand(id: string): number | null {
  const cs = commitsOf(id).filter((c) => !isMergeCommit(c));
  if (!cs.length) return null;
  return Math.min(...cs.map((c) => c.stratum));
}

export function nodeFile(id: string): string {
  const e = entry(id);
  if (!e) return "";
  const parts = e.id.split("#");
  if (parts.length >= 4) return parts.slice(0, parts.length - 3).join("#");
  return e.files[0]?.path ?? e.summary;
}

// ---- edge semantics ---------------------------------------------------------
// An edge is directed: `a` references `b` (a calls b). What makes it worth
// looking at is where the PR's changes sit on it — an unchanged caller reaching
// into a changed callee is the shape most breakage takes, so it gets its own
// color, its own legend row and a one-click filter.

type EdgeKind = "co" | "risk" | "out" | "quiet";

const EDGE_NOTE: Record<EdgeKind, string> = {
  co: "both ends changed — this edge is part of the change",
  risk: "caller is UNCHANGED and depends on changed code",
  out: "changed code reaching into unchanged code",
  quiet: "neither end changed — context pulled in by the fill"
};

const EDGE_LABEL: Record<EdgeKind, string> = {
  co: "co-changed",
  risk: "unchanged caller",
  out: "into unchanged",
  quiet: "context"
};

export function edgeKind(e: { a: string; b: string }): EdgeKind {
  const ca = nodeSeed(e.a);
  const cb = nodeSeed(e.b);
  if (ca && cb) return "co";
  if (!ca && cb) return "risk";
  if (ca && !cb) return "out";
  return "quiet";
}

/** every edge touching this entry, in both directions, across components */
export function edgesOf(id: string): { out: GraphEdge[]; in: GraphEdge[] } {
  const all = page.edges ?? [];
  return {
    out: all.filter((e) => e.a === id && entry(e.b)),
    in: all.filter((e) => e.b === id && entry(e.a))
  };
}

/** which component owns an entry — Connections rows jump across components */
export function componentOf(id: string): ComponentDoc | undefined {
  return page.components.find((c) => c.entryIds.includes(id));
}

// ---- layered layout ---------------------------------------------------------
// Rank by longest path over the directed edges: callers on top, callees below.
// The pass cap breaks cycles rather than looping forever (a cycle just collapses
// onto adjacent ranks, and its back-edge still draws with an arrowhead).

function layerRanks(ids: string[], edges: { a: string; b: string }[]): Map<string, number> {
  const inSet = new Set(ids);
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const es = edges.filter((e) => inSet.has(e.a) && inSet.has(e.b) && e.a !== e.b);
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of es) {
      const want = rank.get(e.a)! + 1;
      if (rank.get(e.b)! < want) {
        rank.set(e.b, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return rank;
}

/** place each rank on its own row; within a row, order by the mean x of the
    callers above (barycenter) so the arrows cross as little as possible */
function layeredPositions(
  ids: string[],
  edges: { a: string; b: string }[],
  rank: Map<string, number>,
  VB: number
): { pos: Map<string, { x: number; y: number }>; above: Set<string>; lane: number } {
  const SP = 84;        // horizontal step between neighbours in a lane
  const PER = 4;        // nodes per lane — beyond this, labels have nowhere to go
  const MARGIN = 52;    // keep nodes and their labels off the canvas edge
  const SWEEPS = 6;     // barycenter ordering passes (down, up, down, ...)
  const RELAX = 40;     // x relaxation iterations

  const inSet = new Set(ids);
  const es = edges.filter((e) => inSet.has(e.a) && inSet.has(e.b) && e.a !== e.b);
  const nbrs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of es) {
    nbrs.get(e.a)!.push(e.b);
    nbrs.get(e.b)!.push(e.a);
  }

  // wholly unconnected objects say nothing about flow — park them on their own
  // bottom lane instead of letting them stretch the first rank
  const linked = ids.filter((id) => nbrs.get(id)!.length > 0);
  const loose = ids.filter((id) => nbrs.get(id)!.length === 0);

  const rows = new Map<number, string[]>();
  for (const id of linked) {
    const r = rank.get(id) ?? 0;
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)!.push(id);
  }
  const order = [...rows.keys()].sort((a, b) => a - b);

  // split a wide rank into balanced lanes: 5 nodes read better as 3+2 than 4+1
  const lanes: string[][] = [];
  const laneOf = new Map<string, number>();
  const addLane = (members: string[]): void => {
    for (const id of members) laneOf.set(id, lanes.length);
    lanes.push(members);
  };
  for (const r of order) {
    const row = rows.get(r)!.slice().sort((a, b) => a.localeCompare(b));
    const parts = Math.ceil(row.length / PER);
    const per = Math.ceil(row.length / parts);
    for (let i = 0; i < row.length; i += per) addLane(row.slice(i, i + per));
  }
  if (loose.length) {
    const per = Math.ceil(loose.length / Math.ceil(loose.length / PER));
    for (let i = 0; i < loose.length; i += per) addLane(loose.slice(i, i + per));
  }

  // slot = position within the lane; x is derived from it so ordering and
  // spacing stay separable (order first, then relax the coordinates)
  const slot = new Map<string, number>();
  const centerLane = (lane: string[]): void => {
    lane.forEach((id, i) => slot.set(id, i - (lane.length - 1) / 2));
  };
  for (const lane of lanes) centerLane(lane);

  // crossing reduction: repeatedly reorder each lane by the mean slot of its
  // neighbours in the adjacent lane, alternating direction
  for (let s = 0; s < SWEEPS; s++) {
    const down = s % 2 === 0;
    const seq = down ? lanes.map((_, i) => i) : lanes.map((_, i) => lanes.length - 1 - i);
    for (const li of seq) {
      const from = down ? li - 1 : li + 1;
      if (from < 0 || from >= lanes.length) continue;
      const key = new Map<string, number>();
      for (const id of lanes[li]) {
        const ns = nbrs.get(id)!.filter((n) => laneOf.get(n) === from).map((n) => slot.get(n)!);
        key.set(id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : slot.get(id)!);
      }
      lanes[li].sort((a, b) => key.get(a)! - key.get(b)! || a.localeCompare(b));
      centerLane(lanes[li]);
    }
  }

  // relax x toward the mean of each node's neighbours, then push apart anything
  // that got too close — straightens long chains without letting nodes collide
  const x = new Map<string, number>();
  for (const [id, s] of slot) x.set(id, VB / 2 + s * SP);
  for (let it = 0; it < RELAX; it++) {
    for (const id of ids) {
      const ns = nbrs.get(id)!;
      if (!ns.length) continue;
      const mean = ns.reduce((a, n) => a + x.get(n)!, 0) / ns.length;
      x.set(id, x.get(id)! + (mean - x.get(id)!) * 0.35);
    }
    for (const lane of lanes) {
      lane.sort((a, b) => x.get(a)! - x.get(b)!);
      for (let i = 1; i < lane.length; i++) {
        const need = x.get(lane[i - 1])! + SP;
        if (x.get(lane[i])! < need) x.set(lane[i], need);
      }
      // re-center the lane so relaxation never drifts the drawing sideways
      const lo = x.get(lane[0])!, hi = x.get(lane[lane.length - 1])!;
      const shift = VB / 2 - (lo + hi) / 2;
      for (const id of lane) x.set(id, x.get(id)! + shift);
    }
  }

  // fit horizontally: the lanes are centered, so one scale keeps them centered
  const xs = [...x.values()];
  const half = Math.max(...xs.map((v) => Math.abs(v - VB / 2)), 1);
  const scale = Math.min(1, (VB / 2 - MARGIN) / half);

  const LANE = lanes.length > 1
    ? Math.min(54, (VB - 2 * MARGIN) / (lanes.length - 1))
    : 0;
  const top = VB / 2 - ((lanes.length - 1) * LANE) / 2;

  // neighbours in a lane alternate: dropped a little, and labelled above rather
  // than below — two long names side by side can then never overlap
  const pos = new Map<string, { x: number; y: number }>();
  const above = new Set<string>();
  lanes.forEach((lane, li) => {
    lane.forEach((id, j) => {
      const stagger = lane.length > 2 && j % 2 === 1;
      if (stagger) above.add(id);
      pos.set(id, {
        x: VB / 2 + (x.get(id)! - VB / 2) * scale,
        y: top + li * LANE + (stagger ? 13 : 0)
      });
    });
  });
  return { pos, above, lane: LANE || 54 };
}

/** one arrowhead per edge state; context-stroke keeps each in its line's color */
function arrowDefs(): SVGElement {
  const defs = svgEl("defs");
  for (const k of ["co", "risk", "out", "quiet"] as EdgeKind[]) {
    const m = svgEl("marker");
    m.setAttribute("id", `gp-arrow-${k}`);
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "9");
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "5");
    m.setAttribute("markerHeight", "5");
    m.setAttribute("orient", "auto-start-reverse");
    const p = svgEl("path", `gp-arrow k-${k}`);
    p.setAttribute("d", "M 0 1 L 9 5 L 0 9 z");
    p.setAttribute("fill", "context-stroke");
    m.appendChild(p);
    defs.appendChild(m);
  }
  return defs;
}

/** the edge hover card: who calls whom, what state the edge is in, and the
    actual source lines that put it there — the "why" behind the drawing */
function showEdgeTip(anchor: SVGElement, e: GraphEdge, k: EdgeKind): void {
  showHoverCard(anchor as unknown as HTMLElement, (card) => {
    const head = el("div", "hc-edge");
    head.append(
      el("code", undefined, entry(e.a)?.name ?? e.a),
      el("span", "hc-arrow", " → "),
      el("code", undefined, entry(e.b)?.name ?? e.b)
    );
    card.appendChild(head);
    card.appendChild(el("div", `hc-kind k-${k}`, EDGE_NOTE[k]));
    for (const s of e.sites ?? []) {
      const row = el("div", "hc-site");
      row.append(
        el("span", "hc-site-at", `${s.file.split("/").pop()}:${s.line}`),
        el("code", undefined, s.text.length > 64 ? s.text.slice(0, 63) + "…" : s.text)
      );
      card.appendChild(row);
    }
    const shown = e.sites?.length ?? 0;
    if (e.refs && e.refs > shown) {
      card.appendChild(el("div", "hc-msg", `+${e.refs - shown} more reference site${e.refs - shown === 1 ? "" : "s"}`));
    }
  });
}

// ---- cross-panel highlight ---------------------------------------------------
// The graph is the index, the cards are the explanation. Hovering either side
// lights the other: these two hooks are re-pointed at whichever graph is on
// screen, and go null when the panel shows something else.

export let graphFocus: ((ids: string[], edge?: { a: string; b: string }) => void) | null = null;
export let graphClear: (() => void) | null = null;

/** the panel drops the hooks before it re-renders: a stale one would point at a
    graph that is no longer in the document */
export function clearGraphHooks(): void {
  graphFocus = null;
  graphClear = null;
}

/** light the document cards for these entries (empty array clears) */
function markDocCards(ids: string[]): void {
  for (const n of Array.from(document.querySelectorAll(".entry.wired"))) n.classList.remove("wired");
  for (const id of ids) document.getElementById(`entry-${id}`)?.classList.add("wired");
}

export function renderComponentGraph(comp: ComponentDoc): HTMLElement {
  const VB = 460; // world/viewBox size (square) — bigger canvas, zoom/pan inside it
  const box = el("div", "graphbox");
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `0 0 ${VB} ${VB}`);
  svg.setAttribute("class", "gp-svg");

  const ids = comp.entryIds.filter((id) => entry(id));
  const edges = internalEdges(comp);

  // everything lives in a world group; zoom/pan move the group, never the nodes
  const world = svgEl<SVGGElement>("g", "gp-world");
  const view = { k: 1, x: 0, y: 0 };
  const target = { k: 1, x: 0, y: 0 };
  const applyView = (): void => {
    world.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
  };
  svg.appendChild(arrowDefs());

  // starting layout: ranked top-to-bottom by call direction — callers above,
  // callees below — so the drawing reads as a flow, not an arbitrary ring.
  // Drag moves any node from there; the ranks are a starting point, not a cage.
  const rank = layerRanks(ids, edges);
  const { pos, above: labelAbove, lane: laneGap } = layeredPositions(ids, edges, rank, VB);

  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  const center = [...ids].sort((x, y) => (deg.get(y) ?? 0) - (deg.get(x) ?? 0))[0] ?? ids[0];

  // size still reads as "how much depends on this", but never so large that a
  // deep graph's rows collide — the cap follows the row spacing
  const rCap = Math.max(9, Math.min(20, laneGap * 0.4));
  const radius = (id: string): number => Math.min(rCap, 5 + Math.log2(1 + nodeRefs(id)) * 2.8);

  const nodeEls = new Map<string, { circle: SVGCircleElement; label: SVGTextElement; r: number; g: SVGGElement }>();
  const edgeEls: {
    els: SVGLineElement[];
    a: string;
    b: string;
    kind: EdgeKind;
    stub?: { x: number; y: number };
    into?: boolean; // stub edge pointing INTO this component
  }[] = [];

  // internal edges: a fat transparent line takes the hover (1px is unhittable),
  // the visible line carries the state color and the arrowhead
  for (const e of edges) {
    const kind = edgeKind(e);
    const hit = svgEl<SVGLineElement>("line", "gp-edge-hit");
    const line = svgEl<SVGLineElement>("line", `gp-edge k-${kind}`);
    line.setAttribute("marker-end", `url(#gp-arrow-${kind})`);
    const t = svgEl("title");
    t.textContent = `${entry(e.a)?.name ?? e.a} → ${entry(e.b)?.name ?? e.b} · ${EDGE_LABEL[kind]}`;
    line.appendChild(t);
    hit.addEventListener("mouseenter", () => {
      showEdgeTip(hit, e, kind);
      focus([e.a, e.b], e);
      markDocCards([e.a, e.b]);
    });
    hit.addEventListener("mouseleave", () => {
      hideHoverCard();
      clearFocus();
      markDocCards([]);
    });
    world.appendChild(line);
    world.appendChild(hit);
    edgeEls.push({ els: [line, hit], a: e.a, b: e.b, kind });
  }

  // cross-component edges: which other components do our entries reference, and
  // which reference us? Deduped per target component, direction kept, count
  // labeled, clickable to jump across.
  const cross = new Map<string, Map<string, boolean>>(); // component -> (our entry -> points into us)
  const noteCross = (from: string, targetComp: string, into: boolean): void => {
    if (!targetComp || targetComp === comp.id) return;
    if (!cross.has(targetComp)) cross.set(targetComp, new Map());
    const m = cross.get(targetComp)!;
    if (!m.has(from) || !into) m.set(from, into);
  };
  for (const id of ids) {
    for (const t of entry(id)!.traces) {
      if (t.component) noteCross(id, t.component, false);
    }
  }
  for (const e of page.edges ?? []) {
    const aIn = ids.includes(e.a), bIn = ids.includes(e.b);
    if (aIn === bIn) continue;
    const outside = aIn ? e.b : e.a;
    const tc = page.components.find((c) => c.entryIds.includes(outside));
    // aIn means one of ours calls out; otherwise the outside world calls in
    if (tc) noteCross(aIn ? e.a : e.b, tc.id, !aIn);
  }
  const crossList = [...cross.entries()];
  const RS = 205;
  crossList.forEach(([cid, froms], i) => {
    // stubs sit out to the left and right: the vertical lanes belong to the ranks
    const side = i % 2 === 0 ? 1 : -1;
    const fan = ((Math.floor(i / 2) % 3) - 1) * 0.44;
    const ang = (side > 0 ? 0 : Math.PI) + fan;
    const sx = VB / 2 + RS * Math.cos(ang);
    const sy = VB / 2 + RS * Math.sin(ang);
    for (const [from, into] of froms) {
      const line = svgEl<SVGLineElement>("line", "gp-edge ext");
      line.setAttribute(into ? "marker-start" : "marker-end", "url(#gp-arrow-quiet)");
      const t = svgEl("title");
      t.textContent = into
        ? `${component(cid)?.name ?? cid} → ${entry(from)?.name ?? from} (called from another component)`
        : `${entry(from)?.name ?? from} → ${component(cid)?.name ?? cid}`;
      line.appendChild(t);
      world.appendChild(line);
      edgeEls.push({ els: [line], a: from, b: from, kind: "quiet", stub: { x: sx, y: sy }, into });
    }
    const dot = svgEl<SVGCircleElement>("circle", "gp-stub");
    dot.setAttribute("cx", String(sx)); dot.setAttribute("cy", String(sy)); dot.setAttribute("r", "5");
    const dt = svgEl("title"); dt.textContent = component(cid)?.name ?? cid;
    dot.appendChild(dt);
    world.appendChild(dot);
    const label = svgEl<SVGTextElement>("text", "gp-stub-label clickable");
    label.textContent = `${component(cid)?.name ?? cid} ×${froms.size}`;
    label.setAttribute("x", String(sx));
    label.setAttribute("y", String(sy - 10));
    label.setAttribute("text-anchor", "middle");
    const jump = () => selectComponent(cid);
    label.addEventListener("click", jump);
    dot.addEventListener("click", jump);
    world.appendChild(label);
  });

  // hovering a Connections row in a card, or an edge here, lights the same wires
  function focus(hi: string[], edge?: { a: string; b: string }): void {
    box.classList.add("focusing");
    for (const [id, n] of nodeEls) n.g.classList.toggle("hi", hi.includes(id));
    for (const e of edgeEls) {
      const on = edge
        ? e.a === edge.a && e.b === edge.b && !e.stub
        : !e.stub && hi.includes(e.a) && hi.includes(e.b);
      for (const l of e.els) l.classList.toggle("hi", on);
    }
  }
  function clearFocus(): void {
    box.classList.remove("focusing");
    for (const [, n] of nodeEls) n.g.classList.remove("hi");
    for (const e of edgeEls) for (const l of e.els) l.classList.remove("hi");
  }
  graphFocus = focus;
  graphClear = clearFocus;


  // click card (replaces hover)
  const tip = el("div", "gtip");
  tip.style.display = "none";
  let selected: string | null = null;

  for (const id of ids) {
    const e = entry(id)!;
    const r = radius(id);
    const g = svgEl<SVGGElement>("g", "gp-node clickable");
    const c = svgEl<SVGCircleElement>("circle");
    c.setAttribute("r", String(r));
    const cls = [
      id === center ? "hub" : "",
      nodeSeed(id) ? (nodeBand(id) ? `st${nodeBand(id)}` : "seed") : "neighbor"
    ].filter(Boolean).join(" ");
    if (cls) c.setAttribute("class", cls);
    g.appendChild(c);
    const label = svgEl<SVGTextElement>("text", "gp-label");
    label.textContent = e.name.length > 18 ? e.name.slice(0, 17) + "\u2026" : e.name;
    g.appendChild(label);
    nodeEls.set(id, { circle: c, label, r, g });

    let suppressClick = false;
    g.addEventListener("click", () => {
      if (!suppressClick) showTip(id);
    });
    // hovering a node lights its wires here and its card in the document
    const near = [id, ...edges.filter((x) => x.a === id || x.b === id).map((x) => (x.a === id ? x.b : x.a))];
    g.addEventListener("mouseenter", () => { focus(near); markDocCards([id]); });
    g.addEventListener("mouseleave", () => { clearFocus(); markDocCards([]); });

    // node drag (zoom-aware deltas); small movement still counts as click
    g.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      document.body.classList.add("dragging");
      const start = { x: ev.clientX, y: ev.clientY };
      const orig = { ...pos.get(id)! };
      let movedPx = 0;
      const move = (m: PointerEvent) => {
        const s = (svg.getBoundingClientRect().width / VB) * view.k;
        const dx = m.clientX - start.x;
        const dy = m.clientY - start.y;
        movedPx = Math.max(movedPx, Math.abs(dx) + Math.abs(dy));
        pos.set(id, { x: orig.x + dx / s, y: orig.y + dy / s });
        redraw();
      };
      const up = () => {
        document.body.classList.remove("dragging");
        suppressClick = movedPx > 6;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    world.appendChild(g);
  }

  // ---- story mode: replay the PR commit by commit on this graph.
  // blank canvas → each commit lights its touched nodes in time-band color →
  // neighbors ghost in as they get pulled → complete. Scrub to any point.
  const story = [...page.commits]
    .filter((c) => !isMergeCommit(c) && c.touches.some((t) => comp.entryIds.includes(t) && entry(t)))
    .reverse(); // oldest first — the PR grows forward in time
  if (story.length) {
    const bar = el("div", "storybar");
    const play = el("button", "story-btn", "\u25b6 replay");
    const resetBtn = el("button", "story-btn ghost", "show all");
    const scr = el("div", "story-scrub");
    const fill = el("i", "story-fill");
    scr.appendChild(fill);
    const stepLabel = el("span", "story-step", `${story.length} commit${story.length === 1 ? "" : "s"}`);
    let timer: number | null = null;
    let at = story.length;

    const apply = (): void => {
      const shown = new Map<string, number>(); // entry id → story step that lit it
      for (let i = 0; i < at; i++) {
        for (const t of story[i].touches) {
          if (comp.entryIds.includes(t) && entry(t) && !shown.has(t)) shown.set(t, i);
        }
      }
      const near = new Set<string>();
      for (const e of edges) {
        if (shown.has(e.a) && shown.has(e.b)) continue;
        if (shown.has(e.a)) near.add(e.b);
        else if (shown.has(e.b)) near.add(e.a);
      }
      for (const [id, n] of nodeEls) {
        n.g.classList.toggle("story-off", !shown.has(id) && !near.has(id));
        n.g.classList.toggle("story-near", !shown.has(id) && near.has(id));
        // color = the stratum of the commit that lit the node — the same ramp
        // as the ribbons, dots and matrix, so replay never re-colors history
        const step = shown.get(id);
        const band = step === undefined ? 0 : story[step].stratum;
        n.circle.setAttribute("class",
          [band ? `st${band}` : "neighbor", id === center ? "hub" : ""].filter(Boolean).join(" "));
      }
      for (const e of edgeEls) {
        const on = !e.stub && shown.has(e.a) && shown.has(e.b);
        for (const l of e.els) l.classList.toggle("story-off", !on);
      }
      fill.style.width = `${(at / story.length) * 100}%`;
      stepLabel.textContent =
        at === 0 ? "before this PR"
        : at === story.length ? "complete"
        : `${at}/${story.length} \u00b7 ${story[at - 1].message}`;
      const last = at > 0 ? story[at - 1].touches.filter((t) => comp.entryIds.includes(t) && entry(t)) : [];
      for (const t of last) {
        const n = nodeEls.get(t);
        if (n) {
          n.g.classList.add("pulse");
          window.setTimeout(() => n.g.classList.remove("pulse"), 750);
        }
      }
    };
    const stopTimer = (): void => {
      if (timer) { window.clearInterval(timer); timer = null; }
    };
    play.addEventListener("click", () => {
      stopTimer();
      at = 0;
      apply();
      timer = window.setInterval(() => {
        at++;
        apply();
        if (at >= story.length) stopTimer();
      }, 1150);
    });
    resetBtn.addEventListener("click", () => {
      stopTimer();
      at = story.length;
      apply();
    });
    scr.addEventListener("click", (ev) => {
      stopTimer();
      const r = scr.getBoundingClientRect();
      at = Math.round(((ev.clientX - r.left) / r.width) * story.length);
      apply();
    });
    bar.append(play, scr, stepLabel, resetBtn);
    box.appendChild(bar);
  }

  function showTip(id: string): void {
    const e = entry(id)!;
    selected = id;
    tip.textContent = "";
    const head = el("div", "gtip-name"); head.textContent = e.name;
    const meta = el("div", "gtip-meta");
    meta.textContent = `${e.kind} \u00b7 ${nodeFile(id)} \u00b7 ${nodeRefs(id)} refs`;
    const fact = el("div", `gtip-fact${nodeSeed(id) ? " chg" : ""}`);
    fact.textContent = nodeSeed(id) ? "changed by this PR" : "unchanged · referenced here";
    const sum = el("div", "gtip-sum");
    sum.textContent = e.traces[0]?.relation ?? e.summary;
    const open = el("button", "gtip-open", "open details ↓");
    open.addEventListener("click", () => selectComponent(comp.id, id));
    tip.append(head, meta, fact, sum, open);
    if (e.comments?.length) {
      const cc = el("div", "gtip-meta");
      cc.textContent = `${e.comments.length} review thread${e.comments.length === 1 ? "" : "s"}`;
      tip.appendChild(cc);
    }
    tip.style.display = "block";
    positionTip();
  }

  function hideTip(): void {
    selected = null;
    tip.style.display = "none";
  }

  function positionTip(): void {
    if (!selected) return;
    const p = pos.get(selected);
    if (!p) return;
    const rect = box.getBoundingClientRect();
    const s = rect.width / VB;
    const x = (p.x * view.k + view.x) * s;
    const y = (p.y * view.k + view.y) * s;
    tip.style.left = Math.min(Math.max(x - 95, 4), Math.max(rect.width - 224, 4)) + "px";
    tip.style.top = Math.min(y + 16, Math.max(rect.height - 170, 4)) + "px";
  }

  // smooth wheel zoom, anchored at the cursor
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * VB;
    const sy = ((ev.clientY - rect.top) / rect.height) * VB;
    const f = Math.exp(-ev.deltaY * 0.0016);
    const k2 = Math.min(6, Math.max(0.5, target.k * f));
    const s = k2 / target.k;
    target.x = sx - (sx - target.x) * s;
    target.y = sy - (sy - target.y) * s;
    target.k = k2;
    kick();
  }, { passive: false });

  // pan on background drag; a clean background click hides the card
  svg.addEventListener("pointerdown", (ev) => {
    if ((ev.target as Element).closest(".gp-node")) return;
    ev.preventDefault();
    document.body.classList.add("dragging");
    const start = { x: ev.clientX, y: ev.clientY };
    const orig = { ...target };
    let movedPx = 0;
    const move = (m: PointerEvent) => {
      const s = svg.getBoundingClientRect().width / VB;
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      movedPx = Math.max(movedPx, Math.abs(dx) + Math.abs(dy));
      target.x = orig.x + dx / s;
      target.y = orig.y + dy / s;
      kick();
    };
    const up = () => {
      document.body.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (movedPx < 5) hideTip();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // rAF smoothing: view eases toward target
  let raf = 0;
  function tick(): void {
    view.x += (target.x - view.x) * 0.28;
    view.y += (target.y - view.y) * 0.28;
    view.k += (target.k - view.k) * 0.28;
    applyView();
    positionTip();
    if (Math.abs(target.x - view.x) + Math.abs(target.y - view.y) + Math.abs(target.k - view.k) > 0.0015) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
    }
  }
  function kick(): void {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function redraw(): void {
    for (const e of edgeEls) {
      const a = pos.get(e.a)!;
      const tx = e.stub ? e.stub.x : pos.get(e.b)!.x;
      const ty = e.stub ? e.stub.y : pos.get(e.b)!.y;
      // pull both ends back to the node rim: an arrowhead buried under the
      // target circle reads as no arrowhead at all
      const dx = tx - a.x, dy = ty - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const back = (e.stub ? 6 : radius(e.b) + 6) / len;
      const front = (e.stub && e.into ? 6 : radius(e.a) + 2) / len;
      const x1 = a.x + dx * front, y1 = a.y + dy * front;
      const x2 = tx - dx * back, y2 = ty - dy * back;
      for (const l of e.els) {
        l.setAttribute("x1", String(x1));
        l.setAttribute("y1", String(y1));
        l.setAttribute("x2", String(x2));
        l.setAttribute("y2", String(y2));
      }
    }
    for (const [id, n] of nodeEls) {
      const p = pos.get(id)!;
      n.circle.setAttribute("cx", String(p.x));
      n.circle.setAttribute("cy", String(p.y));
      n.label.setAttribute("x", String(p.x));
      n.label.setAttribute("y", String(labelAbove.has(id) ? p.y - n.r - 6 : p.y + n.r + 11));
    }
    positionTip();
  }

  // first render fills the panel: fit the view to what was actually drawn
  // (nodes, their labels, and any cross-component stubs) instead of trusting
  // the layout to happen to use the whole canvas
  {
    const pad = 26;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const cover = (px: number, py: number, r: number): void => {
      x0 = Math.min(x0, px - r); x1 = Math.max(x1, px + r);
      y0 = Math.min(y0, py - r); y1 = Math.max(y1, py + r);
    };
    for (const [id, p] of pos) cover(p.x, p.y, radius(id) + 12);
    for (const e of edgeEls) if (e.stub) cover(e.stub.x, e.stub.y, 16);
    if (Number.isFinite(x0)) {
      const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
      const k = Math.max(0.6, Math.min(1.9, (VB - 2 * pad) / Math.max(w, h)));
      target.k = view.k = k;
      target.x = view.x = VB / 2 - ((x0 + x1) / 2) * k;
      target.y = view.y = VB / 2 - ((y0 + y1) / 2) * k;
    }
  }

  applyView();
  redraw();
  svg.appendChild(world);
  box.appendChild(svg);
  box.appendChild(tip);

  // the risk line: unchanged callers depending on changed code is the single
  // most review-worthy shape here, so it gets a count and a one-click filter
  const risky = edges.filter((e) => edgeKind(e) === "risk");
  if (risky.length) {
    const rl = el("button", "grisk");
    rl.append(
      el("i", "gl k-risk"),
      el("span", undefined, `${risky.length} unchanged caller${risky.length === 1 ? "" : "s"} depend${risky.length === 1 ? "s" : ""} on changed code`)
    );
    rl.title = "show only these edges";
    rl.addEventListener("click", () => {
      const on = box.classList.toggle("risk-only");
      rl.classList.toggle("on", on);
    });
    box.appendChild(rl);
  }

  const legend = el("div", "glegend");
  const legendItems: { cls: string; label: string }[] = [
    { cls: "k-co", label: "co-changed" },
    { cls: "k-risk", label: "unchanged caller" },
    { cls: "k-out", label: "into unchanged" },
    { cls: "ext", label: "other component" },
    { cls: "sw", label: "changed · color = commit band" },
    { cls: "sw hollow", label: "referenced · unchanged" }
  ];
  for (const it of legendItems) {
    const item = el("span", "glegend-item");
    item.appendChild(el("i", `gl ${it.cls}`.trim()));
    item.appendChild(document.createTextNode(it.label));
    legend.appendChild(item);
  }
  legend.appendChild(el("span", "glegend-note", "arrows point caller → callee"));
  box.appendChild(legend);
  return box;
}
