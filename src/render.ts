import type { Commit, ComponentDoc, DiffLine, Entry, FileDiff, PageData } from "./types.js";
import type { Comment as ReviewComment } from "./types.js";

// ---- rendering -------------------------------------------------------------
// Two lenses over one PR. The toggle switches the rail and the document:
//   by commit    — rail lists commits grouped by day; doc shows the commit
//                  and which components it FEEDS.
//   by component — rail lists derived components; doc shows entries with
//                  traces; each entry shows which commits WROTE it (ribbons).

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function lineNo(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<T extends SVGElement = SVGElement>(tag: string, cls?: string): T {
  const e = document.createElementNS(SVG_NS, tag) as T;
  if (cls) e.setAttribute("class", cls);
  return e;
}

let page: PageData;
let mode: "commits" | "components" = "components";
let currentComponent = "";
let currentCommit: string | null = null;
const expanded = new Set<string>();

// ---- review checkpoint --------------------------------------------------------------
// One localStorage document per PR: the commits that existed when you last hit
// "mark reviewed", plus the entry ids you personally checked off. "New since"
// is a set difference against each line's `by` sha — no git, no API, offline.

interface ReviewState {
  seenCommits: string[];
  reviewedAt: number;
  read: string[];
}

let review: ReviewState | null = null;
let reviewKey = "";
let dataName = "";

function loadReview(): void {
  reviewKey = `strata-review:${page.pr.repo}${page.pr.number}`;
  try {
    const raw = localStorage.getItem(reviewKey);
    review = raw ? (JSON.parse(raw) as ReviewState) : null;
  } catch {
    review = null;
  }
}

function saveReview(): void {
  try { localStorage.setItem(reviewKey, JSON.stringify(review)); } catch { /* storage unavailable */ }
}

function markReviewed(): void {
  review = {
    seenCommits: page.commits.filter((c) => !isMergeCommit(c)).map((c) => c.sha),
    reviewedAt: Date.now(),
    read: review?.read ?? []
  };
  saveReview();
}

function clearReview(): void {
  review = null;
  try { localStorage.removeItem(reviewKey); } catch { /* storage unavailable */ }
}

function toggleRead(id: string): void {
  if (!review) review = { seenCommits: [], reviewedAt: 0, read: [] };
  const i = review.read.indexOf(id);
  if (i >= 0) review.read.splice(i, 1);
  else review.read.push(id);
  saveReview();
}

/** add lines authored by commits you had not seen at checkpoint time */
function newLineCount(): number {
  if (!review) return 0;
  let n = 0;
  for (const e of Object.values(page.entries)) {
    for (const f of e.files ?? []) {
      for (const l of f.lines) {
        if (l.kind === "add" && l.by && !review.seenCommits.includes(l.by)) n++;
      }
    }
  }
  return n;
}

function renderReviewStrip(): HTMLElement | null {
  const real = page.commits.filter((c) => !isMergeCommit(c));
  if (!real.length) return null;
  const s = el("div", "review-strip");
  const mark = el("button", "strip-btn", "mark reviewed");
  mark.addEventListener("click", () => { markReviewed(); refresh(); });
  const reset = el("button", "strip-btn ghost", "reset");
  reset.addEventListener("click", () => { clearReview(); refresh(); });

  if (!review) {
    s.appendChild(el("span", undefined, `not yet reviewed · ${real.length} commit${real.length === 1 ? "" : "s"}`));
    s.appendChild(mark);
    return s;
  }

  const known = review.seenCommits.filter((sha) => real.some((c) => c.sha === sha)).length;
  const rewritten = review.seenCommits.length > 0 && known / review.seenCommits.length < 0.3;
  if (rewritten) {
    s.classList.add("warn");
    s.appendChild(el("span", undefined, "branch rewritten since your review"));
    s.append(mark, reset);
    return s;
  }

  const d = new Date(review.reviewedAt);
  const when = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const fresh = real.filter((c) => !review!.seenCommits.includes(c.sha));
  if (!fresh.length) {
    s.appendChild(el("span", undefined, `reviewed ${when} · up to date`));
    s.appendChild(reset);
  } else {
    s.classList.add("has-new");
    s.appendChild(el("span", undefined,
      `reviewed ${when} · ${fresh.length} commit${fresh.length === 1 ? "" : "s"} · ${newLineCount()} new lines since`));
    s.append(mark, reset);
  }
  return s;
}

// ---- lookups ----------------------------------------------------------------

function component(id: string): ComponentDoc | undefined {
  return page.components.find((c) => c.id === id);
}

function entry(id: string): Entry | undefined {
  return page.entries[id];
}

function commit(id: string): Commit | undefined {
  return page.commits.find((c) => c.id === id);
}

/** commits that touched an entry, oldest first */
function commitsOf(entryId: string): Commit[] {
  return page.commits.filter((c) => c.touches.includes(entryId));
}

/** the commit that introduced this entry: oldest band, and within it the
    earliest commit in the (newest-first) page order */
function introducerOf(entryId: string): Commit | undefined {
  const cs = commitsOf(entryId).filter((c) => !isMergeCommit(c));
  if (!cs.length) return undefined;
  const min = Math.min(...cs.map((c) => c.stratum));
  const band = cs.filter((c) => c.stratum === min);
  return band[band.length - 1];
}

// ---- navigation --------------------------------------------------------------

function setMode(m: "commits" | "components"): void {
  mode = m;
  refresh();
}

function selectComponent(id: string, targetEntry?: string): void {
  mode = "components";
  currentComponent = id;
  if (targetEntry) expanded.add(targetEntry);
  refresh();
  if (targetEntry) {
    const node = document.getElementById(`entry-${targetEntry}`);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
      node.classList.add("flash");
      window.setTimeout(() => node.classList.remove("flash"), 1400);
    }
  }
}

function selectCommit(id: string): void {
  mode = "commits";
  currentCommit = id;
  refresh();
  document.getElementById("doc")?.scrollIntoView({ block: "start" });
}

function fillStrip(): void {
  const slot = document.querySelector(".strip-slot");
  if (!slot) return;
  slot.innerHTML = "";
  const strip = renderReviewStrip();
  if (strip) slot.appendChild(strip);
}

function refresh(): void {
  fillStrip();
  const layout = document.querySelector(".layout");
  if (!layout) return;
  layout.innerHTML = "";
  layout.appendChild(renderRail());
  layout.appendChild(mode === "commits" ? renderCommitDoc() : renderComponentDoc());
  layout.appendChild(renderGraphPanel());
  const toggle = document.querySelector(".mode-toggle");
  toggle?.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-mode") === mode);
  });
}

// ---- time helpers -----------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function commitBySha(sha: string): Commit | undefined {
  return sha ? page.commits.find((c) => c.sha === sha) : undefined;
}

/** "2024-06-03 14:02" → "Jun 3 · 14:02"; falls back to the day+time fields */
function whenLabel(ts: string | undefined, day: string, time: string): string {
  const m = ts?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  if (!m) return `${day} ${time}`.trim();
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])} \u00b7 ${m[4]}`;
}

/** compact span: same day → "Jun 3 · 14:02–16:20" (single stamp when the sweep
    spans one minute), else "Jun 3 14:02 → Jun 5 09:12" */
function whenRange(from: string | undefined, to: string | undefined): string {
  if (!from) return "";
  const fm = from.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  const tm = (to ?? from).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  if (!fm || !tm) return "";
  if (fm[1] === tm[1] && fm[2] === tm[2] && fm[3] === tm[3]) {
    if (fm[4] === tm[4]) return `${MONTHS[Number(fm[2]) - 1]} ${Number(fm[3])} \u00b7 ${fm[4]}`;
    return `${MONTHS[Number(fm[2]) - 1]} ${Number(fm[3])} \u00b7 ${fm[4]}\u2013${tm[4]}`;
  }
  return `${MONTHS[Number(fm[2]) - 1]} ${Number(fm[3])} ${fm[4]} \u2192 ${MONTHS[Number(tm[2]) - 1]} ${Number(tm[3])} ${tm[4]}`;
}

// ---- diff ----------------------------------------------------------------------

function renderLine(l: DiffLine): HTMLElement {
  // lines you had already seen at your last checkpoint render dimmed
  const seen = !!(review && l.by && review.seenCommits.includes(l.by));
  const row = el("div", `ln ${l.kind}${l.stratum ? ` s${l.stratum}` : ""}${seen ? " seen" : ""}`);
  // one quiet tick per attributed line: color = when the line was written.
  // Unattributed lines (context, pre-PR deletions) keep the gutter empty.
  // Merge-resolution lines get a hatched slate tick. Hover opens the when-card.
  const ribbon = el("span", `ribbon${l.stratum ? ` s${l.stratum}` : l.conflict ? " cf" : ""}`);
  if (l.stratum) {
    const c = commitBySha(l.by ?? "");
    ribbon.addEventListener("mouseenter", () => showRibbonTip(ribbon, c, l.stratum!, false));
    ribbon.addEventListener("mouseleave", hideRibbonTip);
  } else if (l.conflict) {
    const c = commitBySha(l.by ?? "");
    ribbon.addEventListener("mouseenter", () => showRibbonTip(ribbon, c, 0, true));
    ribbon.addEventListener("mouseleave", hideRibbonTip);
  }
  row.appendChild(ribbon);
  row.append(
    el("span", "no", lineNo(l.old)),
    el("span", "no", lineNo(l.new)),
    el("code", undefined, l.text)
  );
  if (l.kind === "move") row.appendChild(el("span", "mark moved", "moved"));
  return row;
}

// ---- the hover card -----------------------------------------------------------------
// One floating dark card shared by every hover surface (diff ticks, matrix
// cells): quiet, positioned next to its anchor, clamped to the viewport.

let hcard: HTMLDivElement | null = null;

function showHoverCard(anchor: HTMLElement, build: (card: HTMLElement) => void): void {
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

function hideHoverCard(): void {
  if (hcard) hcard.style.display = "none";
}

/** the diff tick's hover card: when the line was written, by whom, in which commit */
function showRibbonTip(ribbon: HTMLElement, c: Commit | undefined, band: number, conflict = false): void {
  showHoverCard(ribbon, (card) => {
    const when = el("span", "hc-when");
    when.appendChild(el("i", band ? `tk-tick s${band}` : "tk-tick cf"));
    when.appendChild(el("b", undefined,
      conflict ? `merge resolution${c ? ` · ${whenLabel(c.ts, c.day, c.time)}` : ""}`
      : c ? `written ${whenLabel(c.ts, c.day, c.time)}` : `time band ${band}/4`));
    card.appendChild(when);
    if (c) {
      card.appendChild(el("div", "hc-who", c.author));
      card.appendChild(el("div", "hc-msg", c.message));
    }
  });
}

function hideRibbonTip(): void {
  hideHoverCard();
}

function renderFile(f: FileDiff, comments?: ReviewComment[]): HTMLElement {
  const box = el("div", "file");
  const head = el("div", "file-head");
  head.append(el("span", "path", f.path), el("span", "delta", f.delta));
  const body = el("div", "diff");
  // GitHub-style: each review thread renders inline right after its anchor line.
  // Anchors are "path:line" (line = new-file line number).
  const pending = new Map<number, ReviewComment[]>();
  const loose: ReviewComment[] = [];
  for (const c of comments ?? []) {
    const m = c.anchor?.match(/:(\d+)\s*$/);
    if (m) {
      const ln = Number(m[1]);
      if (!pending.has(ln)) pending.set(ln, []);
      pending.get(ln)!.push(c);
    } else loose.push(c);
  }
  for (const l of f.lines) {
    body.appendChild(renderLine(l));
    const ln = l.new ?? l.old;
    if (ln === undefined) continue;
    // place the thread at the closest diff row at-or-before its anchor line
    let best: number | undefined;
    for (const p of pending.keys()) if (p <= ln && (best === undefined || p > best)) best = p;
    if (best !== undefined) {
      for (const c of pending.get(best)!) body.appendChild(commentThread(c, staleState(c, l)));
      pending.delete(best);
    }
  }
  // threads whose anchor line isn't in the visible diff → keep them at the end
  for (const cs of pending.values()) for (const c of cs) body.appendChild(commentThread(c, c.created ? "gone" : undefined));
  for (const c of loose) body.appendChild(commentThread(c));
  box.append(head, body);
  return box;
}

/** has the anchored line been rewritten since the comment was posted? */
function staleState(c: ReviewComment, l: DiffLine | undefined): "stale" | "gone" | undefined {
  if (!c.created) return undefined; // no timestamp on the comment → no judgment
  const at = l?.by ? commitBySha(l.by)?.at : undefined;
  if (!at) return undefined; // row carries no attribution (context) → no judgment
  return at > Date.parse(c.created) / 1000 ? "stale" : undefined;
}

function commentThread(c: ReviewComment, state?: "stale" | "gone"): HTMLElement {
  const wrap = el("div", `inline-thread${state === "stale" ? " stale" : state === "gone" ? " gone" : ""}`);
  // collapsed by default: one header line — avatar + who commented (+ message count).
  // Click the card itself to expand/collapse the full thread.
  const n = 1 + (c.replies?.length ?? 0);
  // collapsed header shows EVERYONE in the thread: avatar + name per person
  const authors = [c.author, ...(c.replies ?? []).map((r) => r.author)]
    .filter((a, i, arr) => arr.indexOf(a) === i);
  const head = el("button", "it-head");
  for (const a of authors) {
    const w = el("span", "it-who");
    const av = el("span", `hist-av sm ${authorColor(a)}`, a.slice(0, 1).toUpperCase());
    av.title = a;
    w.append(av, el("b", undefined, a));
    head.appendChild(w);
  }
  let stalePanel: HTMLElement | null = null;
  if (state === "stale" || state === "gone") {
    const expandable = !!(state === "stale" && c.stale?.before !== undefined && c.stale.after !== undefined);
    const chip = el("button", `stale-chip${expandable ? " expandable" : ""}`,
      state === "stale" ? (expandable ? "rewritten since \u25be" : "rewritten since") : "anchor gone");
    if (expandable) {
      // expandable inside the card: what the reviewer saw vs what the line says now
      stalePanel = el("div", "stale-diff");
      const before = el("div", "sd-row before");
      before.appendChild(el("b", undefined, "when commented"));
      before.appendChild(el("code", undefined, c.stale!.before || "(empty)"));
      const after = el("div", "sd-row after");
      const writer = commitBySha(c.stale!.in ?? "");
      after.appendChild(el("b", undefined, `now \u00b7 ${whenLabel(writer?.ts, writer?.day ?? "", writer?.time ?? "")}`));
      after.appendChild(el("code", undefined, c.stale!.after || "(empty)"));
      stalePanel.append(before, after);
      if (writer) {
        const note = el("div", "sd-note");
        note.textContent = `rewritten in ${writer.sha} — ${writer.message}`;
        stalePanel.appendChild(note);
      }
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        wrap.classList.toggle("stale-open");
      });
    } else {
      chip.addEventListener("mouseenter", () => showHoverCard(chip, (card) => {
        card.appendChild(el("div", "hc-msg", state === "stale"
          ? "the line this thread anchors to was rewritten after the comment was posted"
          : "the line this thread anchors to is no longer part of the diff"));
      }));
      chip.addEventListener("mouseleave", hideHoverCard);
    }
    head.appendChild(chip);
  }
  if (n > 1) head.appendChild(el("span", "it-count", `${n} messages`));
  const bodyWrap = el("div", "it-body");
  bodyWrap.appendChild(renderComment(c.author, c.body, c.anchor, c.resolved));
  for (const r of c.replies ?? []) {
    bodyWrap.appendChild(renderComment(r.author, r.body, r.anchor, r.resolved, true));
  }
  head.addEventListener("click", () => {
    const open = wrap.classList.toggle("open");
    head.setAttribute("aria-expanded", String(open));
  });
  if (stalePanel) wrap.append(head, stalePanel, bodyWrap);
  else wrap.append(head, bodyWrap);
  return wrap;
}

// ---- shared bits -----------------------------------------------------------------

function renderComment(author: string, body: string, anchor?: string, resolved?: boolean, reply?: boolean): HTMLElement {
  const item = el("div", `comment${reply ? " reply" : ""}`);
  const av = el("span", `hist-av sm ${authorColor(author)}`, author.slice(0, 1).toUpperCase());
  av.title = author;
  const main = el("div", "c-main");
  const meta = el("div", "meta");
  meta.appendChild(el("b", undefined, author));
  if (anchor) meta.appendChild(el("span", "anchor", anchor));
  if (resolved) meta.appendChild(el("span", "resolved", "resolved"));
  main.append(meta, el("p", undefined, body));
  item.append(av, main);
  return item;
}

function renderTraceRows(entry: Entry, drawer?: HTMLElement): HTMLElement {
  const box = el("div", "trace-rows");
  for (const t of entry.traces) {
    const row = el("div", `trace${t.negative ? " neg" : ""}`);
    row.appendChild(el("span", "t-rel", t.relation));
    if (t.component && t.object) {
      const jump = el("button", "t-jump");
      jump.textContent = `\u2192 ${component(t.component)?.name ?? t.component}`;
      jump.addEventListener("click", () => selectComponent(t.component!, t.object!));
      row.appendChild(jump);
    } else if (t.file && drawer) {
      // a fact pointing at a file that is not an entry (the covering test):
      // open that file's diff in the drawer under the Impact section
      const name = t.file.split("/").pop()!;
      const jump = el("button", "t-jump");
      const closedLabel = `\u2192 open ${name}`;
      jump.textContent = closedLabel;
      jump.addEventListener("click", () => {
        const open = drawer.classList.toggle("open");
        jump.textContent = open ? `close ${name}` : closedLabel;
        if (open) {
          drawer.textContent = "";
          const fd = page.extraFiles?.[t.file!];
          if (fd) drawer.appendChild(renderFile(fd));
          else drawer.appendChild(el("p", "no-diff", `no diff for ${t.file}`));
          drawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
      row.appendChild(jump);
    }
    box.appendChild(row);
  }
  return box;
}

/** small colored squares: which commits wrote this entry */
function commitDots(entryId: string): HTMLElement {
  const dots = el("span", "commit-dots");
  for (const c of commitsOf(entryId)) {
    const d = el("i", `s${c.stratum}`);
    d.title = `written ${whenLabel(c.ts, c.day, c.time)} \u00b7 ${c.author}\n${c.message}`;
    dots.appendChild(d);
  }
  return dots;
}

// ---- the time key ------------------------------------------------------------------
// One dated swatch per stratum, oldest → newest, shown once in the history
// panel. The same ramp colors ribbons, commit dots, graph nodes and the
// matrix — one time vocabulary for the whole page; the ribbons themselves
// carry the per-line "when" on hover.

/** time span covered by each stratum among these commits (empty if unknown) */
function bandsFromCommits(cs: Commit[]): Map<number, { from: string; to: string }> {
  const bands = new Map<number, { from: string; to: string }>();
  for (const c of cs) {
    if (!c.ts) return new Map(); // no timestamps → no time key
    const b = bands.get(c.stratum) ?? { from: c.ts, to: c.ts };
    b.from = b.from < c.ts ? b.from : c.ts;
    b.to = b.to > c.ts ? b.to : c.ts;
    bands.set(c.stratum, b);
  }
  return bands;
}

/** the time key: dated swatches, oldest → newest */
function timeKey(bands: Map<number, { from: string; to: string }>): HTMLElement {
  const key = el("div", "time-key");
  for (const band of [...bands.keys()].sort((a, b) => a - b)) {
    const r = bands.get(band)!;
    const item = el("span", "tk");
    const label = whenRange(r.from, r.to) || `band ${band}`;
    item.title = `band ${band}/4 \u00b7 written ${label}`;
    item.append(el("i", `tk-tick s${band}`), el("span", undefined, label));
    key.appendChild(item);
  }
  return key;
}

// ---- lens: by component -----------------------------------------------------------

function renderRail(): HTMLElement {
  const rail = el("aside", "rail");

  if (mode === "components") {
    rail.appendChild(el("h3", "rail-h", "Components"));
    const list = el("div", "comps");
    for (const c of page.components) {
      const btn = el("button", `comp${c.id === currentComponent ? " active" : ""}`);
      const stats = review
        ? `${c.stats} · ${c.entryIds.filter((id) => review!.read.includes(id)).length}/${c.entryIds.length} read`
        : c.stats;
      btn.append(
        el("span", "comp-path", c.name),
        el("span", "comp-stats", stats)
      );
      btn.addEventListener("click", () => selectComponent(c.id));
      list.appendChild(btn);
    }
    rail.appendChild(list);
  } else {
    rail.appendChild(el("h3", "rail-h", "Commits \u00b7 by date"));
    const list = el("div", "comps");
    let lastDay = "";
    for (const c of page.commits.filter((x) => !isMergeCommit(x))) {
      if (c.day !== lastDay) {
        list.appendChild(el("div", "day-h", c.day));
        lastDay = c.day;
      }
      const btn = el("button", `comp commit${c.id === currentCommit ? " active" : ""}`);
      btn.append(
        el("span", "comp-path", c.message),
        el("span", "comp-stats", `${c.time} \u00b7 ${c.sha}`)
      );
      btn.addEventListener("click", () => selectCommit(c.id));
      list.appendChild(btn);
    }
    rail.appendChild(list);
  }

  return rail;
}

function renderComponentDoc(): HTMLElement {
  const comp = component(currentComponent) ?? page.components[0];
  const main = el("main", "doc");
  main.id = "doc";

  const head = el("header", "doc-head");
  head.append(
    el("h1", undefined, comp.name),
    el("p", "doc-meta", comp.stats)
  );
  const origin = el("p", "origin", comp.origin);
  head.appendChild(origin);
  main.appendChild(head);

  const list = el("div", "entries");
  for (const id of comp.entryIds) {
    const e = entry(id);
    if (e) list.appendChild(renderEntry(e));
  }
  main.appendChild(list);
  return main;
}

function renderEntry(e: Entry): HTMLElement {
  const art = el("article", `entry${e.seed ? "" : " fill"}`);
  art.id = `entry-${e.id}`;

  // the commit that introduced this object drives the card's band identity.
  // fill-only neighbors stay clean: they're unchanged context, no commit claims them.
  const intro = e.seed ? introducerOf(e.id) : undefined;
  if (intro) art.style.setProperty("--band", `var(--s${intro.stratum})`);

  // folder tab: the introducing commit's sha, stamped on the deposit line —
  // or a torn "unchanged" stub for fill-only context objects
  const tab = el("span", "entry-tab");
  if (intro) {
    tab.title = `${intro.message}\n${intro.day} ${intro.time} · ${intro.author}`;
    tab.append(el("i", `intro-dot s${intro.stratum}`), el("span", undefined, intro.sha));
  } else {
    tab.textContent = "unchanged context";
  }
  art.appendChild(tab);

  const head = el("header", "entry-head");
  const title = el("div", "entry-title");
  const nameRow = el("div", "name-row");
  // the reviewer's read checkmark — independent of the time checkpoint
  const isRead = review?.read.includes(e.id) ?? false;
  const tick = el("button", `read-tick${isRead ? " on" : ""}`);
  tick.title = isRead ? "marked as read — click to unmark" : "mark as read";
  tick.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleRead(e.id);
    refresh();
  });
  nameRow.appendChild(tick);
  nameRow.append(
    el("code", "name", e.name),
    el("i", "row-leader"),
    el("span", "kind", e.kind)
  );
  if (e.comments?.length) {
    const cb = el("span", "cmt-badge", `💬 ${e.comments.length}`);
    cb.title = "review threads — expand a card in the diff";
    nameRow.append(cb);
  }
  if (review) {
    let newLines = 0;
    for (const f of e.files) {
      for (const l of f.lines) {
        if (l.kind === "add" && l.by && !review.seenCommits.includes(l.by)) newLines++;
      }
    }
    if (newLines && !isRead) {
      const nc = el("span", "new-chip", `+${newLines} new`);
      nc.title = "written since your last checkpoint";
      nameRow.append(nc);
    }
  }
  title.append(nameRow, el("p", "summary", e.summary));
  const gaps = e.traces.filter((t) => t.negative).length;
  const badge = el("span", "trace-badge",
    `${e.traces.length} fact${e.traces.length === 1 ? "" : "s"}${gaps ? ` \u00b7 ${gaps} gap${gaps > 1 ? "s" : ""}` : ""}`
  );
  head.append(title, badge);
  // promoted fact: nothing reaches this symbol from any test file
  if (e.seed && e.traces.some((t) => t.relation === "no direct test references")) {
    const uc = el("span", "untested-chip", "untested");
    uc.addEventListener("mouseenter", () => showHoverCard(uc, (card) => {
      card.appendChild(el("div", "hc-msg", "no test file references this symbol"));
    }));
    uc.addEventListener("mouseleave", hideHoverCard);
    head.appendChild(uc);
  }
  art.appendChild(head);

  // the introducing commit's message — hooked to its tab stamp
  if (intro) {
    const cl = el("div", "intro-commit");
    cl.title = `${intro.message}\n${intro.day} ${intro.time} · ${intro.author} · band ${intro.stratum}/4`;
    cl.append(
      el("span", "intro-hook", "└"),
      el("code", "intro-msg", intro.message.length > 52 ? intro.message.slice(0, 51) + "…" : intro.message)
    );
    art.appendChild(cl);
  }

  if (expanded.has(e.id)) {
    const body = el("div", "entry-body");

    // -- changes --------------------------------------------------------------
    const chg = el("section", "sec");
    chg.appendChild(el("h4", "sec-h", "Changes"));
    for (const f of e.files) chg.appendChild(renderFile(f, e.comments));
    if (!e.files.length) {
      chg.appendChild(el("p", "no-diff", "no diff — referenced by changed objects"));
    }
    const written = commitsOf(e.id);
    if (written.length) {
      const line = el("p", "written");
      line.append(
        el("span", "written-label", `written by ${written.length} commit${written.length > 1 ? "s" : ""} `),
        commitDots(e.id)
      );
      chg.appendChild(line);
    }
    body.appendChild(chg);
    // -- traces ----------------------------------------------------------------
    if (e.traces.length) {
      const tr = el("section", "sec");
      tr.appendChild(el("h4", "sec-h", "Impact"));
      const drawer = el("div", "test-drawer");
      tr.appendChild(renderTraceRows(e, drawer));
      tr.appendChild(drawer);
      body.appendChild(tr);
    }
    // footer: mark the whole object as read without collapsing back to the top
    const foot = el("div", "entry-foot");
    const readNow = review?.read.includes(e.id) ?? false;
    const rb = el("button", `foot-read${readNow ? " read" : ""}`,
      readNow ? "\u2713 marked as read — unmark" : "\u2713 mark as read");
    rb.title = "attest that you have read this object";
    rb.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleRead(e.id);
      refresh();
    });
    foot.appendChild(rb);
    body.appendChild(foot);
    art.appendChild(body);
  }

  head.addEventListener("click", () => {
    if (expanded.has(e.id)) expanded.delete(e.id);
    else expanded.add(e.id);
    refresh();
  });

  return art;
}

// ---- lens: by commit --------------------------------------------------------------

/** contributions: components × authors. A cell counts the commits that person
    made touching the component; its shade is how recent the newest of them is.
    Hovering a cell opens the commit list; clicking it opens the component. */
function renderMatrix(): HTMLElement {
  const wrap = el("div", "matrix-wrap");
  const comps = page.components;
  const counts = new Map<string, number>();
  for (const c of page.commits) {
    if (isMergeCommit(c)) continue; // merges change no files — same filter as the history
    counts.set(c.author, (counts.get(c.author) ?? 0) + 1);
  }
  const people = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  if (!comps.length || !people.length) {
    wrap.appendChild(el("p", "no-diff", "nothing to correlate yet"));
    return wrap;
  }
  const table = el("table", "matrix vertical");
  const hr = el("tr", "matrix-hr");
  hr.appendChild(el("th", undefined, ""));
  for (const p of people) {
    const th = el("th");
    const av = el("span", `hist-av sm ${authorColor(p)}`, p.slice(0, 1).toUpperCase());
    av.addEventListener("mouseenter", () =>
      showHoverCard(av, (card) => {
        card.appendChild(el("div", "hc-name", p));
        card.appendChild(el("div", "hc-who", `${counts.get(p)} commit${counts.get(p) === 1 ? "" : "s"} in this PR`));
      }));
    av.addEventListener("mouseleave", hideHoverCard);
    th.appendChild(av);
    hr.appendChild(th);
  }
  table.appendChild(hr);
  for (const c of comps) {
    const tr = el("tr");
    const td0 = el("td", "matrix-c");
    td0.textContent = c.name.length > 17 ? c.name.slice(0, 16) + "…" : c.name;
    td0.title = c.name;
    td0.addEventListener("click", () => selectComponent(c.id));
    tr.appendChild(td0);
    for (const p of people) {
      const cs = page.commits.filter((x) => x.author === p && !isMergeCommit(x) && x.touches.some((t) => c.entryIds.includes(t)));
      const td = el("td");
      if (cs.length) {
        const newest = Math.max(...cs.map((x) => x.stratum));
        td.className = `on s${newest}`;
        td.textContent = String(cs.length);
        td.addEventListener("mouseenter", () =>
          showHoverCard(td, (card) => {
            const head = el("div", "hc-when");
            head.appendChild(el("b", undefined, p));
            head.appendChild(el("span", "hc-obj", `\u2192 ${c.name}`));
            card.appendChild(head);
            const sorted = [...cs].sort((a, b) => ((a.ts ?? a.time) < (b.ts ?? b.time) ? 1 : -1));
            for (const x of sorted.slice(0, 5)) {
              const row = el("div", "hc-row");
              row.appendChild(el("i", `tk-tick s${x.stratum}`));
              row.appendChild(el("span", "t", whenLabel(x.ts, x.day, x.time)));
              row.appendChild(el("span", "m", x.message));
              card.appendChild(row);
            }
            if (sorted.length > 5) card.appendChild(el("div", "hc-more", `+${sorted.length - 5} more`));
          }));
        td.addEventListener("mouseleave", hideHoverCard);
        td.addEventListener("click", () => selectComponent(c.id));
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

function ovFact(n: string, label: string): HTMLElement {
  const f = el("div", "ov-fact");
  f.append(el("b", undefined, n), el("span", undefined, " " + label));
  return f;
}

function renderCommitDoc(): HTMLElement {
  const main = el("main", "doc");
  main.id = "doc";

  if (!currentCommit) {
    // overview: the PR at a glance — detail lives in the history panel
    main.appendChild(el("h3", "mat-h", "Overview"));
    const real = page.commits.filter((c) => !isMergeCommit(c));
    const authors = new Set(real.map((c) => c.author));
    const withComments = Object.values(page.entries).filter((e) => e.comments?.length).length;
    let conflicts = 0;
    for (const e of Object.values(page.entries)) {
      for (const f of e.files ?? []) {
        for (const l of f.lines) if (l.conflict) conflicts++;
      }
    }
    const sum = el("div", "overview");
    sum.appendChild(el("p", "ov-banner", page.banner));
    const facts = el("div", "ov-facts");
    facts.append(
      ovFact(String(real.length), "commits"),
      ovFact(String(authors.size), "contributors"),
      ovFact(String(page.components.length), "components"),
      ovFact(String(withComments), withComments === 1 ? "file with review notes" : "files with review notes")
    );
    if (conflicts) facts.append(ovFact(String(conflicts), "lines from merge resolution"));
    sum.appendChild(facts);
    main.appendChild(sum);
    main.appendChild(el("p", "matrix-note", "select a commit from the history to view its changes"));
    return main;
  }

  const c = commit(currentCommit)!;
  const head = el("header", "doc-head");
  head.append(
    el("h1", undefined, c.message),
    el("p", "doc-meta", `${c.day} ${c.time} \u00b7 ${c.sha} \u00b7 ${c.author ?? page.pr.author}`)
  );
  main.appendChild(head);

  // FEEDS: which derived components absorb this commit's changes
  const fedIds = [...new Set(page.components.filter((comp) =>
    comp.entryIds.some((eid) => c.touches.includes(eid))
  ).map((comp) => comp.id))];

  if (fedIds.length) {
    const feeds = el("div", "feeds");
    feeds.appendChild(el("h4", undefined, "Affects components"));
    for (const fid of fedIds) {
      const comp = component(fid)!;
      const touched = comp.entryIds.filter((eid) => c.touches.includes(eid));
      const row = el("div", "feed-row");
      const btn = el("button", "t-jump");
      btn.textContent = `\u2192 ${comp.name} (${touched.length})`;
      btn.addEventListener("click", () => selectComponent(fid, touched[0]));
      row.append(
        el("span", "t-rel", touched.map((eid) => entry(eid)?.name ?? eid).join(", ")),
        btn
      );
      feeds.appendChild(row);
    }
    main.appendChild(feeds);
  }

  for (const f of c.files) main.appendChild(renderFile(f));

  // sibling commits nav (skip merge commits)
  const seq = page.commits.filter((x) => !isMergeCommit(x));
  const idx = seq.findIndex((x) => x.id === c.id);
  const nav = el("div", "commit-nav");
  if (idx > 0) {
    const prev = el("button", "t-jump", `\u2190 ${seq[idx - 1].message}`);
    prev.addEventListener("click", () => selectCommit(seq[idx - 1].id));
    nav.appendChild(prev);
  }
  if (idx < seq.length - 1 && idx >= 0) {
    const next = el("button", "t-jump", `${seq[idx + 1].message} \u2192`);
    next.addEventListener("click", () => selectCommit(seq[idx + 1].id));
    nav.appendChild(next);
  }
  if (nav.children.length) main.appendChild(nav);

  return main;
}

// ---- graph panel ------------------------------------------------------------
// The component's local view of the dependency graph: changed objects as
// nodes, the edges the flood fill walked, external refs and gaps as stubs.

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

function nodeSeed(id: string): boolean {
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

function nodeFile(id: string): string {
  const e = entry(id);
  if (!e) return "";
  const parts = e.id.split("#");
  if (parts.length >= 4) return parts.slice(0, parts.length - 3).join("#");
  return e.files[0]?.path ?? e.summary;
}

function renderComponentGraph(comp: ComponentDoc): HTMLElement {
  const VB = 460; // world/viewBox size (square) — bigger canvas, zoom/pan inside it
  const box = el("div", "graphbox");
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `0 0 ${VB} ${VB}`);
  svg.setAttribute("class", "gp-svg");

  const ids = comp.entryIds.filter((id) => entry(id));
  const edges = internalEdges(comp);

  // starting layout: highest-degree node centered, rest on a ring; drag from there
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  const center = [...ids].sort((x, y) => (deg.get(y) ?? 0) - (deg.get(x) ?? 0))[0] ?? ids[0];

  const pos = new Map<string, { x: number; y: number }>();
  pos.set(center, { x: VB / 2, y: VB / 2 });
  const ring = ids.filter((id) => id !== center);
  const R = 150;
  ring.forEach((id, i) => {
    const a = (i / Math.max(ring.length, 1)) * Math.PI * 2 - Math.PI / 2;
    pos.set(id, { x: VB / 2 + R * Math.cos(a), y: VB / 2 + R * Math.sin(a) });
  });

  // cross-component edges: which other components do our entries reference?
  // deduped per target component, count-labeled, clickable to jump across
  const cross = new Map<string, Set<string>>();
  const noteCross = (from: string, target: string): void => {
    if (!target || target === comp.id) return;
    if (!cross.has(target)) cross.set(target, new Set());
    cross.get(target)!.add(from);
  };
  for (const id of ids) {
    for (const t of entry(id)!.traces) {
      if (t.component) noteCross(id, t.component);
    }
  }
  for (const e of page.edges ?? []) {
    const aIn = ids.includes(e.a), bIn = ids.includes(e.b);
    if (aIn === bIn) continue;
    const outside = aIn ? e.b : e.a;
    const tc = page.components.find((c) => c.entryIds.includes(outside));
    if (tc) noteCross(aIn ? e.a : e.b, tc.id);
  }
  const crossList = [...cross.entries()];
  const RS = 212;
  crossList.forEach(([cid, froms], i) => {
    const a = crossList.length === 1 ? -Math.PI / 2 : (i / crossList.length) * Math.PI * 2 - Math.PI / 2 + Math.PI / crossList.length;
    const sx = VB / 2 + RS * Math.cos(a);
    const sy = VB / 2 + RS * Math.sin(a);
    for (const from of froms) {
      const line = svgEl<SVGLineElement>("line", "gp-edge ext");
      const t = svgEl("title"); t.textContent = component(cid)?.name ?? cid;
      line.appendChild(t);
      world.appendChild(line);
      edgeEls.push({ el: line, a: from, b: from, stub: { x: sx, y: sy } });
    }
    const dot = svgEl<SVGCircleElement>("circle", "gp-stub");
    dot.setAttribute("cx", String(sx)); dot.setAttribute("cy", String(sy)); dot.setAttribute("r", "5");
    const dt = svgEl("title"); dt.textContent = component(cid)?.name ?? cid;
    dot.appendChild(dt);
    world.appendChild(dot);
    const label = svgEl<SVGTextElement>("text", "gp-stub-label clickable");
    label.textContent = `${component(cid)?.name ?? cid} \u00d7${froms.size}`;
    label.setAttribute("x", String(sx));
    label.setAttribute("y", String(sy - 10));
    label.setAttribute("text-anchor", "middle");
    const jump = () => selectComponent(cid);
    label.addEventListener("click", jump);
    dot.addEventListener("click", jump);
    world.appendChild(label);
  });

  const radius = (id: string): number => 5 + Math.log2(1 + nodeRefs(id)) * 2.8;

  // everything lives in a world group; zoom/pan move the group, never the nodes
  const world = svgEl<SVGGElement>("g", "gp-world");
  const view = { k: 1, x: 0, y: 0 };
  const target = { k: 1, x: 0, y: 0 };
  const applyView = (): void => {
    world.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
  };

  const edgeEls: { el: SVGLineElement; a: string; b: string; stub?: { x: number; y: number } }[] = [];

  for (const e of edges) {
    const line = svgEl<SVGLineElement>("line", "gp-edge");
    const t = svgEl("title"); t.textContent = e.rel;
    line.appendChild(t);
    world.appendChild(line);
    edgeEls.push({ el: line, a: e.a, b: e.b });
  }

  // click card (replaces hover)
  const tip = el("div", "gtip");
  tip.style.display = "none";
  let selected: string | null = null;

  const nodeEls = new Map<string, { circle: SVGCircleElement; label: SVGTextElement; r: number; g: SVGGElement }>();

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
        e.el.classList.toggle("story-off", !on);
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
      cc.textContent = `💬 ${e.comments.length} review thread${e.comments.length === 1 ? "" : "s"}`;
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
      e.el.setAttribute("x1", String(a.x));
      e.el.setAttribute("y1", String(a.y));
      const bx = e.stub ? e.stub.x : pos.get(e.b)!.x;
      const by = e.stub ? e.stub.y : pos.get(e.b)!.y;
      e.el.setAttribute("x2", String(bx));
      e.el.setAttribute("y2", String(by));
    }
    for (const [id, n] of nodeEls) {
      const p = pos.get(id)!;
      n.circle.setAttribute("cx", String(p.x));
      n.circle.setAttribute("cy", String(p.y));
      n.label.setAttribute("x", String(p.x));
      n.label.setAttribute("y", String(p.y + n.r + 11));
    }
    positionTip();
  }

  applyView();
  redraw();
  svg.appendChild(world);
  box.appendChild(svg);
  box.appendChild(tip);

  const legend = el("div", "glegend");
  const legendItems: { cls: string; label: string }[] = [
    { cls: "", label: "def\u2212use edge" },
    { cls: "ext", label: "external ref" },
    { cls: "sw", label: "changed · color = commit band" },
    { cls: "sw hollow", label: "referenced · unchanged" }
  ];
  for (const it of legendItems) {
    const item = el("span", "glegend-item");
    item.appendChild(el("i", `gl ${it.cls}`.trim()));
    item.appendChild(document.createTextNode(it.label));
    legend.appendChild(item);
  }
  box.appendChild(legend);
  box.appendChild(el("div", "ghint", "scroll = zoom \u00b7 drag background = pan \u00b7 drag node = move \u00b7 click node = details"));
  return box;
}

// commit history: a github-style list, newest → oldest, stratum color = time band,
// avatar + contributor chips for the people dimension. Merge commits are excluded
// (they change no files themselves — pure plumbing).
function isMergeCommit(c: Commit): boolean {
  return /^Merge (pull request|branch|remote-tracking)/.test(c.message);
}

function authorColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `av${h % 6}`;
}

function renderCommitHistory(): HTMLElement {
  const box = el("div", "histbox");
  const commits = page.commits.filter((c) => !isMergeCommit(c));
  if (!commits.length) {
    box.appendChild(el("p", "no-diff", "no commits in range"));
    return box;
  }

  const list = el("div", "hist");
  let lastDay = "";
  for (const c of commits) {
    if (c.day !== lastDay) {
      const dh = el("div", "hist-day");
      dh.append(el("span", "hist-day-t", c.day), el("span", "hist-day-line"));
      list.appendChild(dh);
      lastDay = c.day;
    }
    const row = el("button", `hist-row${currentCommit === c.id ? " sel" : ""}`);
    const dot = el("i", `hist-dot s${c.stratum}`);
    dot.title = `time band ${c.stratum}/4 \u00b7 1 = oldest`;
    const av = el("span", `hist-av ${authorColor(c.author)}`, c.author.slice(0, 1).toUpperCase());
    av.title = c.author;
    const bodyCol = el("span", "hist-body");
    bodyCol.append(
      el("span", "hist-msg", c.message.length > 36 ? c.message.slice(0, 35) + "\u2026" : c.message),
      el("span", "hist-meta", `${c.author} \u00b7 ${c.time} \u00b7 ${c.sha}`)
    );
    row.append(dot, av, bodyCol);
    row.addEventListener("click", () => selectCommit(c.id));
    list.appendChild(row);
  }
  box.appendChild(list);

  // who built what — the people × components map, merged into the history so it
  // never goes away. Hovering a row lights that person's commits above it.
  const whoBox = el("div", "hist-matrix");
  whoBox.appendChild(el("span", "hist-people-h", "Contributions"));
  whoBox.appendChild(renderMatrix());
  whoBox.appendChild(el("p", "matrix-note", "components × authors · cell shade = recency of the newest commit · click a cell to open"));
  box.appendChild(whoBox);

  // the time ramp with real dates — the same key shown over every diff
  const bands = bandsFromCommits(page.commits.filter((c) => !isMergeCommit(c)));
  if (bands.size) {
    const legend = el("div", "glegend");
    legend.appendChild(el("span", "glegend-cap", "oldest"));
    legend.appendChild(timeKey(bands));
    legend.appendChild(el("span", "glegend-cap", "newest"));
    box.appendChild(legend);
  }
  return box;
}

function renderGraphPanel(): HTMLElement {
  const side = el("aside", "side");
  if (mode === "components") {
    const comp = component(currentComponent) ?? page.components[0];
    side.appendChild(el("h3", "rail-h", "Dependency graph"));
    side.appendChild(renderComponentGraph(comp));
  } else {
    side.appendChild(el("h3", "rail-h", "History"));
    side.appendChild(renderCommitHistory());
  }
  return side;
}
// ---- export --------------------------------------------------------------------------
// Selected review threads leave as one GitHub review: POST /api/export resolves
// the token server-side, and every export stamps the thread ids it carried in
// the review body, so re-exports skip already-pushed threads instead of duping.

function collectThreads(): { e: Entry; c: ReviewComment }[] {
  const out: { e: Entry; c: ReviewComment }[] = [];
  for (const e of Object.values(page.entries)) {
    for (const c of e.comments ?? []) out.push({ e, c });
  }
  return out;
}

function exportMarkdown(picked: { e: Entry; c: ReviewComment }[]): string {
  const lines: string[] = [];
  for (const { c } of picked) {
    lines.push(`**${c.anchor ?? "(no anchor)"} — ${c.author}**`);
    lines.push(c.body);
    for (const r of c.replies ?? []) lines.push(`> ${r.author}: ${r.body}`);
    lines.push("");
  }
  return lines.join("\n");
}

function openExportCard(): void {
  const threads = collectThreads();
  const overlay = el("div", "overlay");
  const card = el("div", "export-card");
  card.appendChild(el("h3", "exp-h", "Export review"));
  card.appendChild(el("p", "exp-note",
    `${threads.length} thread${threads.length === 1 ? "" : "s"} · pushed as one GitHub review${page.head ? ` on head ${page.head.slice(0, 7)}` : ""}`));
  const checks: HTMLInputElement[] = [];
  for (const { c } of threads) {
    const row = el("label", "exp-row");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    checks.push(box);
    row.appendChild(box);
    const txt = el("span", "exp-txt");
    txt.append(
      el("b", undefined, c.anchor ?? ""),
      document.createTextNode(` — ${c.author}: ${c.body.length > 90 ? c.body.slice(0, 89) + "…" : c.body}`)
    );
    row.appendChild(txt);
    card.appendChild(row);
  }
  const actions = el("div", "exp-actions");
  const copy = el("button", "strip-btn ghost", "copy as markdown");
  copy.addEventListener("click", () => {
    const picked = threads.filter((_, i) => checks[i].checked);
    void navigator.clipboard?.writeText(exportMarkdown(picked));
    copy.textContent = "copied";
    window.setTimeout(() => { copy.textContent = "copy as markdown"; }, 1200);
  });
  const submit = el("button", "strip-btn", "submit to github");
  submit.addEventListener("click", () => {
    const picked = threads.filter((_, i) => checks[i].checked);
    if (!picked.length || !dataName) return;
    submit.textContent = "sending…";
    submit.setAttribute("disabled", "true");
    fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pr: dataName,
        head: page.head,
        comments: picked.map(({ c }) => ({
          id: String(c.id ?? c.anchor ?? ""),
          path: (c.anchor ?? "").replace(/:\d+\s*$/, ""),
          line: Number(c.anchor?.match(/:(\d+)\s*$/)?.[1] ?? 0) || undefined,
          body: c.body
        }))
      })
    })
      .then((r) => r.json())
      .then((out) => {
        overlay.remove();
        window.alert(out.error ? `export failed: ${out.error}` : out.message ?? `exported ${out.exported} comment${out.exported === 1 ? "" : "s"}`);
      })
      .catch(() => {
        submit.textContent = "submit to github";
        submit.removeAttribute("disabled");
      });
  });
  const cancel = el("button", "strip-btn ghost", "cancel");
  cancel.addEventListener("click", () => overlay.remove());
  actions.append(copy, submit, cancel);
  card.appendChild(actions);
  overlay.appendChild(card);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ---- page --------------------------------------------------------------------------

function renderTopbar(): HTMLElement {
  const bar = el("header", "topbar");
  bar.appendChild(el("span", "wordmark", "strata"));
  bar.appendChild(el("span", "wordmark-sub", "pull request review"));
  bar.appendChild(el("span", "spacer"));
  const addr = el("input", "pr-url") as HTMLInputElement;
  addr.type = "text";
  addr.placeholder = "paste a github PR url and press enter";
  addr.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && addr.value.trim()) {
      addr.classList.add("busy");
      addr.disabled = true;
      fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: addr.value.trim() })
      })
        .then((r) => r.json())
        .then((out) => {
          if (out.error) {
            alert(out.error);
            addr.disabled = false;
            addr.classList.remove("busy");
          } else {
            location.href = `/?pr=${out.pr}`;
          }
        })
        .catch(() => {
          addr.disabled = false;
          addr.classList.remove("busy");
        });
    }
  });
  bar.appendChild(addr);
  const threads = collectThreads();
  if (dataName && threads.length) {
    const exp = el("button", "theme-toggle", `export · ${threads.length}`);
    exp.title = "push review threads to github as one review";
    exp.addEventListener("click", () => openExportCard());
    bar.appendChild(exp);
  }
  const themeBtn = el("button", "theme-toggle");
  const themeLabel = (): string => (document.documentElement.dataset.theme === "light" ? "dark" : "light");
  themeBtn.textContent = themeLabel();
  themeBtn.title = `switch to the ${themeLabel()} theme`;
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("strata-theme", next); } catch { /* storage unavailable */ }
    themeBtn.textContent = themeLabel();
    themeBtn.title = `switch to the ${themeLabel()} theme`;
  });
  bar.appendChild(themeBtn);
  const ref = el("span", "pr-ref");
  ref.append(
    el("b", undefined, `${page.pr.repo} ${page.pr.number}`),
    document.createTextNode(` \u00b7 ${page.pr.title}`)
  );
  bar.appendChild(ref);
  return bar;
}

function renderToggle(): HTMLElement {
  const wrap = el("div", "toggle-row");
  const t = el("div", "mode-toggle");
  const byCommit = el("button", undefined, "By commit");
  byCommit.setAttribute("data-mode", "commits");
  const byComp = el("button", undefined, "By component");
  byComp.setAttribute("data-mode", "components");
  byCommit.addEventListener("click", () => setMode("commits"));
  byComp.addEventListener("click", () => setMode("components"));
  t.append(byCommit, byComp);
  wrap.appendChild(t);
  return wrap;
}

export function render(p: PageData, prName?: string, bannerOverride?: string): void {
  page = p;
  dataName = prName ?? "";
  currentComponent = p.initialComponent;
  loadReview();

  document.body.textContent = "";
  document.body.appendChild(renderTopbar());
  document.body.appendChild(renderToggle());
  const bannerText = bannerOverride ?? p.banner;
  document.body.appendChild(el("div", `banner${bannerText.startsWith("\u26a0") ? " warn" : ""}`, bannerText));
  document.body.appendChild(el("div", "strip-slot"));

  const layout = el("div", "layout");
  layout.appendChild(renderRail());
  layout.appendChild(mode === "commits" ? renderCommitDoc() : renderComponentDoc());
  layout.appendChild(renderGraphPanel());
  document.body.appendChild(layout);
  fillStrip();
}
