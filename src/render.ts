import type { Commit, ComponentDoc, DiffLine, Entry, FileDiff, GraphEdge, PageData } from "./types.js";
import type { Comment as ReviewComment, DraftComment } from "./types.js";

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
let onHome = false;
let mode: "commits" | "components" | "files" = "components";
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

function setMode(m: "commits" | "components" | "files"): void {
  mode = m;
  refresh();
}

function selectComponent(id: string, targetEntry?: string): void {
  mode = "components";
  currentComponent = id;
  if (targetEntry) {
    expanded.clear();
    expanded.add(targetEntry);
    currentEntry = targetEntry;
  }
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

function fillExport(): void {
  const slot = document.querySelector(".export-slot");
  if (!slot) return;
  slot.innerHTML = "";
  const threads = collectThreads();
  const mine = unsentDrafts().length;
  if (!dataName || !threads.length) return;
  const exp = el("button", `theme-toggle${mine ? " has-notes" : ""}`,
    mine ? `${mine} note${mine === 1 ? "" : "s"} to push` : `export · ${threads.length}`);
  exp.title = "push your notes and review threads to github as one review";
  exp.addEventListener("click", () => openExportCard());
  slot.appendChild(exp);
}

function fillObjBar(): void {
  const slot = document.querySelector(".objbar-slot");
  if (!slot) return;
  slot.innerHTML = "";
  if (mode === "components" && page.components.length) slot.appendChild(renderObjectBar());
  else if (mode === "files" && changedFiles().length) slot.appendChild(renderFileBar());
}

function fillStrip(): void {
  const slot = document.querySelector(".strip-slot");
  if (!slot) return;
  slot.innerHTML = "";
  const strip = renderReviewStrip();
  if (strip) slot.appendChild(strip);
}

function docForMode(): HTMLElement {
  if (mode === "commits") return renderCommitDoc();
  if (mode === "files") return renderFileDoc();
  return renderComponentDoc();
}

function refresh(): void {
  fillStrip();
  fillObjBar();
  fillExport();
  const layout = document.querySelector(".layout");
  if (!layout) return;
  layout.innerHTML = "";
  layout.appendChild(renderRail());
  layout.appendChild(docForMode());
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

function renderLine(l: DiffLine, path?: string): HTMLElement {
  // lines you had already seen at your last checkpoint render dimmed
  const seen = !!(review && l.by && review.seenCommits.includes(l.by));
  const row = el("div", `ln ${l.kind}${l.stratum ? ` s${l.stratum}` : ""}${seen ? " seen" : ""}`);
  // one quiet tick per attributed line: color = when the line was written.
  // Unattributed lines (context, pre-PR deletions) keep the gutter empty.
  // Merge-resolution lines get a hatched slate tick. Hover opens the when-card.
  const ribbon = el("span", `ribbon${l.stratum ? ` s${l.stratum}` : l.conflict ? " cf" : ""}`);
  if (l.stratum) {
    const c = commitBySha(l.by ?? "");
    // deletions carry the commit that REMOVED the line, so the card says so
    ribbon.addEventListener("mouseenter", () => showRibbonTip(ribbon, c, l.stratum!, false, l.kind === "del"));
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
    el("span", "sign", l.kind === "add" ? "+" : l.kind === "del" ? "\u2212" : ""),
    el("code", undefined, l.text)
  );
  const actions = el("span", "ln-actions");
  if (l.kind === "move") actions.appendChild(el("span", "mark moved", "moved"));
  // any line can carry a note: added and context lines anchor to the new file,
  // deleted lines to the old one, which is the side GitHub wants for them
  const side: "RIGHT" | "LEFT" = l.kind === "del" ? "LEFT" : "RIGHT";
  const at = side === "LEFT" ? l.old : l.new;
  if (path && at !== undefined) {
    const add = el("button", "ln-note", "＋");
    add.title = `comment on line ${at}`;
    add.setAttribute("aria-label", "add a review note on this line");
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openComposer(row, path, at, side);
    });
    actions.appendChild(add);
  }
  row.appendChild(actions);
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
function showRibbonTip(ribbon: HTMLElement, c: Commit | undefined, band: number, conflict = false, removed = false): void {
  showHoverCard(ribbon, (card) => {
    const when = el("span", "hc-when");
    when.appendChild(el("i", band ? `tk-tick s${band}` : "tk-tick cf"));
    when.appendChild(el("b", undefined,
      conflict ? `merge resolution${c ? ` · ${whenLabel(c.ts, c.day, c.time)}` : ""}`
      : c ? `${removed ? "removed" : "written"} ${whenLabel(c.ts, c.day, c.time)}` : `time band ${band}/4`));
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
  // the path is a way into the file lens: the whole file, in line order
  const path = el("button", "path", f.path);
  path.title = "open this file in the file lens";
  path.addEventListener("click", (ev) => { ev.stopPropagation(); selectFile(f.path); });
  head.append(path, el("span", "delta", f.delta));
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
    const row = renderLine(l, f.path);
    body.appendChild(row);
    // your own notes sit under their line, like a thread would
    for (const d of draftsAt(f.path, l.kind === "del" ? l.old : l.new, l.kind === "del" ? "LEFT" : "RIGHT")) {
      body.appendChild(renderDraft(d));
    }
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

// ---- review notes you write here ---------------------------------------------
// Comments authored in strata live in localStorage until you push them: one
// document per PR, keyed the same way as the review checkpoint. They render
// inline in the diff exactly where a GitHub thread would, and leave through the
// same export as the threads that came back from GitHub.

let drafts: DraftComment[] = [];
let draftKey = "";

function loadDrafts(): void {
  draftKey = `strata-notes:${page.pr.repo}${page.pr.number}`;
  try {
    const raw = localStorage.getItem(draftKey);
    drafts = raw ? (JSON.parse(raw) as DraftComment[]) : [];
  } catch {
    drafts = [];
  }
}

function saveDrafts(): void {
  try { localStorage.setItem(draftKey, JSON.stringify(drafts)); } catch { /* storage unavailable */ }
}

function draftsAt(path: string, line: number | undefined, side: "RIGHT" | "LEFT"): DraftComment[] {
  if (line === undefined) return [];
  return drafts.filter((d) => d.path === path && d.line === line && d.side === side);
}

/** unsent notes are what the export button counts */
function unsentDrafts(): DraftComment[] {
  return drafts.filter((d) => !d.exportedAt);
}

function addDraft(path: string, line: number, side: "RIGHT" | "LEFT", body: string): void {
  drafts.push({
    id: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    path, line, side, body,
    created: new Date().toISOString(),
    author: "you"
  });
  saveDrafts();
}

function removeDraft(id: string): void {
  drafts = drafts.filter((d) => d.id !== id);
  saveDrafts();
}

/** the composer: a textarea under the line, Cmd/Ctrl+Enter to save */
function openComposer(after: HTMLElement, path: string, line: number, side: "RIGHT" | "LEFT", existing?: DraftComment): void {
  after.parentElement?.querySelector(".composer")?.remove();
  const box = el("div", "composer");
  const ta = el("textarea", "composer-in") as HTMLTextAreaElement;
  ta.placeholder = `note on ${path.split("/").pop()}:${line}${side === "LEFT" ? " (removed line)" : ""}`;
  ta.value = existing?.body ?? "";
  ta.rows = 3;
  const actions = el("div", "composer-actions");
  const hint = el("span", "composer-hint", "⌘/Ctrl + Enter to save");
  const cancel = el("button", "strip-btn ghost", "cancel");
  const save = el("button", "strip-btn", existing ? "update note" : "add note");
  const commit = (): void => {
    const body = ta.value.trim();
    if (!body) return;
    if (existing) {
      existing.body = body;
      saveDrafts();
    } else {
      addDraft(path, line, side, body);
    }
    refresh();
  };
  cancel.addEventListener("click", () => box.remove());
  save.addEventListener("click", commit);
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit(); }
    if (ev.key === "Escape") { ev.stopPropagation(); box.remove(); }
  });
  actions.append(hint, cancel, save);
  box.append(ta, actions);
  after.insertAdjacentElement("afterend", box);
  ta.focus();
}

/** a note of your own, rendered where a GitHub thread would sit */
function renderDraft(d: DraftComment): HTMLElement {
  const wrap = el("div", `note${d.exportedAt ? " sent" : ""}`);
  const head = el("div", "note-head");
  head.append(
    el("span", `hist-av sm ${authorColor(d.author)}`, d.author.slice(0, 1).toUpperCase()),
    el("b", undefined, d.author),
    el("span", "note-anchor", `${d.path.split("/").pop()}:${d.line}${d.side === "LEFT" ? " · removed" : ""}`),
    el("span", `note-chip${d.exportedAt ? " sent" : ""}`, d.exportedAt ? "on github" : "not sent yet")
  );
  const tools = el("div", "note-tools");
  const edit = el("button", "note-tool", "edit");
  edit.addEventListener("click", () => openComposer(wrap, d.path, d.line, d.side, d));
  const del = el("button", "note-tool", "delete");
  del.addEventListener("click", () => { removeDraft(d.id); refresh(); });
  tools.append(edit, del);
  head.appendChild(tools);
  wrap.append(head, el("p", "note-body", d.body));
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

/** added/deleted line counts for a set of file diffs */
function deltaOf(files: FileDiff[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of files) {
    for (const l of f.lines) {
      if (l.kind === "add") add++;
      else if (l.kind === "del") del++;
    }
  }
  return { add, del };
}

/** +/− chip in the review's own colors */
function deltaChip(add: number, del: number): HTMLElement {
  const chip = el("span", "delta-chip");
  if (add) chip.appendChild(el("b", "plus", `+${add}`));
  if (del) chip.appendChild(el("b", "minus", `\u2212${del}`));
  return chip;
}

// ---- menu button -------------------------------------------------------------
// A native <select> cannot color half an option, and "+145 −3" is worth
// coloring. So the bar uses a small popup menu instead: a button that opens a
// list of rows we build ourselves, closing on pick, outside click or Escape.

interface MenuItem {
  id: string;
  label: string;
  /** right-hand detail, rendered by the caller (a delta chip, a kind) */
  detail?: () => HTMLElement;
  mark?: string;
  current?: boolean;
}

let openMenu: HTMLElement | null = null;

function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

document.addEventListener("click", (ev) => {
  if (openMenu && !(ev.target as Element)?.closest(".menu, .menu-btn")) closeMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeMenu();
});

function menuButton(
  cls: string,
  label: () => HTMLElement,
  items: MenuItem[],
  pick: (id: string) => void
): HTMLElement {
  const wrap = el("div", `menu-wrap ${cls}`);
  const btn = el("button", "menu-btn");
  btn.appendChild(label());
  btn.appendChild(el("span", "menu-caret", "▾"));
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const mine = openMenu?.parentElement === wrap;
    closeMenu();
    if (mine) return;
    const menu = el("div", "menu");
    for (const it of items) {
      const row = el("button", `menu-row${it.current ? " current" : ""}`);
      row.appendChild(el("span", "menu-mark", it.mark ?? ""));
      row.appendChild(el("span", "menu-label", it.label));
      if (it.detail) row.appendChild(it.detail());
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenu();
        pick(it.id);
      });
      menu.appendChild(row);
    }
    wrap.appendChild(menu);
    openMenu = menu;
    menu.querySelector(".menu-row.current")?.scrollIntoView({ block: "nearest" });
  });
  wrap.appendChild(btn);
  return wrap;
}

/** "+9 −5" in green and red, or the object's kind when nothing changed */
function deltaDetail(e: Entry): HTMLElement {
  const d = deltaOf(e.files);
  if (!d.add && !d.del) return el("span", "menu-kind", e.kind);
  return deltaChip(d.add, d.del);
}

// ---- lens: by component -----------------------------------------------------------

function renderRail(): HTMLElement {
  const rail = el("aside", "rail");

  if (mode === "files") {
    rail.appendChild(el("h3", "rail-h", `Files · ${changedFiles().length}`));
    rail.appendChild(renderFileRail());
    return rail;
  }

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

// ---- object navigation -------------------------------------------------------
// A component is read one object at a time: expanding pins that object under
// the sticky bar, and the bar drives which object that is. Unchanged context
// objects stay in the list as one-line rows — they have no diff, so they cost
// a row, not a screen.

let currentEntry = "";

function objectsOf(comp: ComponentDoc): string[] {
  return comp.entryIds.filter((id) => entry(id));
}

/** which component we have already opened an object for — landing on a
    component opens its first changed object, but only once, so collapsing
    with Escape (or by clicking) stays collapsed */
let openedFor = "";

function ensureCurrent(comp: ComponentDoc): void {
  const list = objectsOf(comp);
  if (!list.length) { currentEntry = ""; return; }
  const openHere = list.find((id) => expanded.has(id));
  if (openHere) { currentEntry = openHere; openedFor = comp.id; return; }
  if (!list.includes(currentEntry)) currentEntry = list.find((id) => entry(id)!.seed) ?? list[0];
  if (openedFor !== comp.id) {
    openedFor = comp.id;
    expanded.clear();
    expanded.add(currentEntry);
  }
}

/** open one object, closing whatever was open, and pin it under the bar */
function openEntry(id: string, scroll = true): void {
  expanded.clear();
  expanded.add(id);
  currentEntry = id;
  refresh();
  if (scroll) scrollToEntry(id);
}

function scrollToEntry(id: string): void {
  const node = document.getElementById(`entry-${id}`);
  // scroll-margin-top on .entry keeps the card clear of the sticky bar
  node?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeEntry(): void {
  expanded.clear();
  refresh();
}

/** step through every object in the component, in document order */
function stepEntry(delta: number): void {
  const comp = component(currentComponent) ?? page.components[0];
  const list = objectsOf(comp);
  if (!list.length) return;
  const at = list.indexOf(currentEntry);
  const next = list[Math.min(list.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))];
  if (next) openEntry(next);
}

/** the next changed object you have not ticked off, wrapping around */
function nextUnread(): void {
  const comp = component(currentComponent) ?? page.components[0];
  const list = objectsOf(comp).filter((id) => entry(id)!.seed);
  const read = new Set(review?.read ?? []);
  const at = list.indexOf(currentEntry);
  const rotated = [...list.slice(at + 1), ...list.slice(0, at + 1)];
  const next = rotated.find((id) => !read.has(id));
  if (next) openEntry(next);
}

let keysWired = false;

/** j/k walk the component, n jumps to the next unread object, Esc collapses */
function wireKeys(): void {
  if (keysWired) return;
  keysWired = true;
  document.addEventListener("keydown", (ev) => {
    if (onHome || (mode !== "components" && mode !== "files")) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) || t.isContentEditable)) return;
    if (mode === "files") {
      const files = changedFiles();
      const at = files.findIndex((f) => f.path === currentFile);
      if (ev.key === "j" || ev.key === "k") {
        const next = files[Math.min(files.length - 1, Math.max(0, at + (ev.key === "j" ? 1 : -1)))];
        if (next) selectFile(next.path);
        ev.preventDefault();
      }
      return;
    }
    switch (ev.key) {
      case "j": stepEntry(1); break;
      case "k": stepEntry(-1); break;
      case "n": nextUnread(); break;
      case "Escape": if (!openMenu) closeEntry(); break;
      case "Enter": case "o": {
        if (currentEntry && expanded.has(currentEntry)) closeEntry();
        else if (currentEntry) openEntry(currentEntry);
        break;
      }
      default: return;
    }
    ev.preventDefault();
  });
}

/** the sticky bar: which component, which object, and the way to the next one */
function renderFileBar(): HTMLElement {
  const files = changedFiles();
  if (!files.some((f) => f.path === currentFile)) currentFile = files[0]?.path ?? "";
  const at = Math.max(0, files.findIndex((f) => f.path === currentFile));
  const bar = el("div", "objbar");

  const step = (d: number): void => {
    const next = files[Math.min(files.length - 1, Math.max(0, at + d))];
    if (next) selectFile(next.path);
  };
  bar.appendChild(menuButton(
    "comp",
    () => {
      const lab = el("span", "menu-lab");
      lab.append(el("b", undefined, currentFile.split("/").pop() ?? "—"),
        el("span", "menu-sub", `${files.length} files`));
      return lab;
    },
    files.map((f) => {
      const st = fileStats(f);
      return {
        id: f.path,
        label: f.path,
        mark: st.objects.length ? "●" : "",
        current: f.path === currentFile,
        detail: () => (st.add || st.del ? deltaChip(st.add, st.del) : el("span", "menu-kind", "no change"))
      };
    }),
    (id) => selectFile(id)
  ));
  bar.appendChild(el("div", "ob-sep"));

  const nav = el("div", "ob-nav");
  const prev = el("button", "ob-step", "◂");
  prev.title = "previous file (k)";
  prev.disabled = at <= 0;
  prev.addEventListener("click", () => step(-1));
  const next = el("button", "ob-step", "▸");
  next.title = "next file (j)";
  next.disabled = at >= files.length - 1;
  next.addEventListener("click", () => step(1));
  nav.append(prev, el("span", "ob-count", `${at + 1} / ${files.length}`), next);
  bar.appendChild(nav);

  const f = fileByPath(currentFile);
  if (f) {
    const st = fileStats(f);
    const chip = el("span", "ob-file-meta");
    chip.appendChild(deltaChip(st.add, st.del));
    bar.appendChild(chip);
    if (!st.objects.length) bar.appendChild(el("span", "conn-chip un", "no object covers this file"));
  }

  const keys = el("span", "ob-keys");
  const kbd = (k: string): HTMLElement => el("kbd", undefined, k);
  keys.append(kbd("j"), kbd("k"), document.createTextNode(" walk files"));
  bar.appendChild(keys);
  return bar;
}

function renderObjectBar(): HTMLElement {
  const comp = component(currentComponent) ?? page.components[0];
  ensureCurrent(comp);
  const list = objectsOf(comp);
  const at = Math.max(0, list.indexOf(currentEntry));

  const bar = el("div", "objbar");

  bar.appendChild(menuButton(
    "comp",
    () => {
      const lab = el("span", "menu-lab");
      lab.append(el("b", undefined, comp.name), el("span", "menu-sub", `${comp.entryIds.length}`));
      return lab;
    },
    page.components.map((c) => ({
      id: c.id,
      label: c.name,
      mark: c.id === comp.id ? "•" : "",
      current: c.id === comp.id,
      detail: () => el("span", "menu-kind", `${c.entryIds.length} objects`)
    })),
    (id) => { currentEntry = ""; selectComponent(id); }
  ));

  bar.appendChild(el("div", "ob-sep"));

  const nav = el("div", "ob-nav");
  const prev = el("button", "ob-step", "◂");
  prev.title = "previous object (k)";
  prev.disabled = at <= 0;
  prev.addEventListener("click", () => stepEntry(-1));
  const count = el("span", "ob-count", `${at + 1} / ${list.length}`);
  const next = el("button", "ob-step", "▸");
  next.title = "next object (j)";
  next.disabled = at >= list.length - 1;
  next.addEventListener("click", () => stepEntry(1));
  nav.append(prev, count, next);
  bar.appendChild(nav);

  const here = entry(currentEntry);
  bar.appendChild(menuButton(
    "obj",
    () => {
      const lab = el("span", "menu-lab");
      lab.appendChild(el("b", undefined, here?.name ?? "—"));
      if (here) lab.appendChild(deltaDetail(here));
      return lab;
    },
    list.map((id) => {
      const e = entry(id)!;
      return {
        id,
        label: e.name,
        mark: review?.read.includes(id) ? "✓" : e.seed ? "●" : "",
        current: id === currentEntry,
        detail: () => deltaDetail(e)
      };
    }),
    (id) => openEntry(id)
  ));

  // the current object's identity and read state, kept out of the scroll
  bar.appendChild(el("div", "ob-sep"));

  const cur = entry(currentEntry);
  if (cur) {
    const isRead = review?.read.includes(cur.id) ?? false;
    const tick = el("button", `ob-tick${isRead ? " on" : ""}`, isRead ? "✓ read" : "mark read");
    tick.title = "mark this object as read";
    tick.addEventListener("click", () => { toggleRead(cur.id); refresh(); });
    bar.appendChild(tick);
    const unread = objectsOf(comp).filter((id) => entry(id)!.seed && !(review?.read ?? []).includes(id)).length;
    if (unread) {
      const nb = el("button", "ob-next", `next unread · ${unread}`);
      nb.title = "jump to the next changed object you have not read (n)";
      nb.addEventListener("click", () => nextUnread());
      bar.appendChild(nb);
    }
  }

  const keys = el("span", "ob-keys");
  const kbd = (k: string): HTMLElement => el("kbd", undefined, k);
  keys.append(kbd("j"), kbd("k"), document.createTextNode(" walk "), kbd("n"), document.createTextNode(" next unread"));
  bar.appendChild(keys);
  return bar;
}

// ---- what no object owns -----------------------------------------------------
// Each object shows the lines inside its own span, which leaves the rest of a
// changed file — imports, top-level statements, the bodies of test callbacks —
// belonging to nothing. Those lines are still part of the PR, so the component
// ends with them rather than quietly dropping them.

function lineKey(l: DiffLine): string {
  return `${l.kind}|${l.old ?? ""}|${l.new ?? ""}`;
}

/** the changed lines in this component's files that no object claimed */
function unclaimedFiles(comp: ComponentDoc): FileDiff[] {
  const claimed = new Map<string, Set<string>>();
  const paths = new Set<string>();
  for (const id of comp.entryIds) {
    for (const f of entry(id)?.files ?? []) {
      paths.add(f.path);
      if (!claimed.has(f.path)) claimed.set(f.path, new Set());
      for (const l of f.lines) claimed.get(f.path)!.add(lineKey(l));
    }
  }
  const out: FileDiff[] = [];
  for (const f of page.files ?? []) {
    if (!paths.has(f.path)) continue;
    const mine = claimed.get(f.path) ?? new Set<string>();
    const changed = f.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.kind !== "ctx" && !mine.has(lineKey(l)));
    if (!changed.length) continue;
    // keep two lines of context around each surviving change so it reads
    const keep = new Set<number>();
    for (const { i } of changed) for (let k = i - 2; k <= i + 2; k++) keep.add(k);
    const lines = f.lines.filter((_, i) => keep.has(i));
    const add = lines.filter((l) => l.kind === "add").length;
    const del = lines.filter((l) => l.kind === "del").length;
    out.push({ path: f.path, delta: `+${add} −${del}`, lines });
  }
  return out;
}

function renderLeftovers(comp: ComponentDoc): HTMLElement | null {
  const files = unclaimedFiles(comp);
  if (!files.length) return null;
  const n = files.reduce((s, f) => s + f.lines.filter((l) => l.kind !== "ctx").length, 0);

  const art = el("article", "entry compact leftovers");
  const head = el("header", "entry-head");
  const title = el("div", "entry-title");
  const nameRow = el("div", "name-row");
  nameRow.append(
    el("span", "row-chev", "›"),
    el("code", "name", "outside any object"),
    el("i", "row-leader"),
    el("span", "kind", `${files.length} file${files.length === 1 ? "" : "s"}`),
    el("span", "row-meta", `${n} changed line${n === 1 ? "" : "s"}`)
  );
  title.append(nameRow);
  head.appendChild(title);
  art.appendChild(head);

  let open = false;
  head.addEventListener("click", () => {
    open = !open;
    art.classList.toggle("compact", !open);
    art.classList.toggle("open", open);
    const body = art.querySelector(".entry-body");
    if (body) { body.remove(); return; }
    const wrap = el("div", "entry-body");
    const sec = el("section", "sec");
    sec.appendChild(el("h4", "sec-h", "Changed, but part of no symbol"));
    sec.appendChild(el("p", "conn-sum",
      "imports, top-level statements and the bodies of test callbacks are not objects the graph can reach — they are shown here so the component's diff is complete"));
    for (const f of files) sec.appendChild(renderFile(f));
    wrap.appendChild(sec);
    art.appendChild(wrap);
  });
  return art;
}

// ---- lens: by file -----------------------------------------------------------
// The component lens is a lens: it shows what the def−use fill reaches, and on a
// real PR that is about half the changed lines — docs, untyped sources and files
// whose changes sit outside every top-level symbol never appear. This lens is
// the completeness backstop: every changed file, in line order, with each region
// labeled by the object that owns it so the two lenses reinforce each other
// instead of repeating each other.

let currentFile = "";

/** every changed file, in the one order the rail, the bar and j/k all use */
function changedFiles(): FileDiff[] {
  return [...(page.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
}

function fileByPath(p: string): FileDiff | undefined {
  return changedFiles().find((f) => f.path === p);
}

function selectFile(path: string): void {
  mode = "files";
  currentFile = path;
  refresh();
  document.getElementById("doc")?.scrollIntoView({ block: "start" });
}

/** line key → the entry whose span claimed it, for every object in the PR */
function ownerOfLines(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, e] of Object.entries(page.entries)) {
    for (const f of e.files ?? []) {
      if (f.path !== path) continue;
      for (const l of f.lines) out.set(lineKey(l), id);
    }
  }
  return out;
}

/** every thread on this file: the ones objects claimed, plus the orphans */
function threadsOnFile(path: string): ReviewComment[] {
  const out: ReviewComment[] = [];
  for (const e of Object.values(page.entries)) {
    if (e.files?.[0]?.path !== path) continue;
    for (const c of e.comments ?? []) out.push(c);
  }
  for (const c of page.fileComments?.[path] ?? []) out.push(c);
  return out;
}

function fileStats(f: FileDiff): { add: number; del: number; bands: number[]; objects: string[] } {
  const d = deltaOf([f]);
  const bands = [...new Set(f.lines.map((l) => l.stratum).filter(Boolean) as number[])].sort((a, b) => a - b);
  const objects = Object.entries(page.entries)
    .filter(([, e]) => e.files?.[0]?.path === f.path)
    .map(([id]) => id);
  return { ...d, bands, objects };
}

/** the file, in line order, cut into runs by which object owns each line */
function renderFileDoc(): HTMLElement {
  const main = el("main", "doc");
  main.id = "doc";
  const files = changedFiles();
  if (!files.length) {
    main.appendChild(el("p", "no-diff", "this dataset carries no file diffs"));
    return main;
  }
  if (!files.some((f) => f.path === currentFile)) currentFile = files[0].path;
  const f = fileByPath(currentFile)!;
  const st = fileStats(f);

  const head = el("header", "doc-head");
  const h1 = el("h1", undefined, f.path.split("/").pop()!);
  const meta = el("p", "doc-meta");
  const dir = f.path.split("/").slice(0, -1).join("/");
  if (dir) meta.append(el("span", undefined, dir + "/"), el("span", undefined, " · "));
  meta.appendChild(deltaChip(st.add, st.del));
  for (const b of st.bands) meta.appendChild(el("i", `ft-band s${b}`));
  head.append(h1, meta);
  head.appendChild(el("p", "origin",
    st.objects.length
      ? `${st.objects.length} object${st.objects.length === 1 ? "" : "s"} in this file · every changed line below, in order`
      : "no indexed symbol covers this file — the object lens cannot reach it, so this is the only place its changes appear"));
  main.appendChild(head);

  const owner = ownerOfLines(f.path);
  const threads = threadsOnFile(f.path);
  const placed = new Set<ReviewComment>();
  const box = el("div", "file filelens");
  const body = el("div", "diff");

  // group consecutive lines by owner so each run can name what it belongs to
  let runOwner: string | null | undefined;
  let run: HTMLElement | null = null;
  const startRun = (id: string | null): void => {
    runOwner = id;
    const label = el("div", "run-head");
    if (id) {
      const e = entry(id)!;
      const jump = el("button", "run-jump");
      jump.append(el("span", "run-in", "in "), el("code", undefined, e.name), el("span", "run-kind", e.kind));
      jump.title = "open this object in the component lens";
      jump.addEventListener("click", () => {
        const c = componentOf(id);
        if (c) selectComponent(c.id, id);
      });
      label.appendChild(jump);
      const comp = componentOf(id);
      if (comp) label.appendChild(el("span", "run-comp", comp.name));
    } else {
      label.appendChild(el("span", "run-none", "no object — imports, top-level statements or a nested body"));
    }
    body.appendChild(label);
    run = el("div", "run");
    body.appendChild(run);
  };

  for (const l of f.lines) {
    const id = owner.get(lineKey(l)) ?? null;
    if (run === null || id !== runOwner) startRun(id);
    run!.appendChild(renderLine(l, f.path));
    for (const d of draftsAt(f.path, l.kind === "del" ? l.old : l.new, l.kind === "del" ? "LEFT" : "RIGHT")) {
      run!.appendChild(renderDraft(d));
    }
    // a thread anchored at this line renders here, whether an object owns it or not
    const at = l.new ?? l.old;
    for (const c of threads) {
      if (placed.has(c)) continue;
      if (Number(c.anchor?.match(/:(\d+)\s*$/)?.[1]) === at) {
        placed.add(c);
        run!.appendChild(commentThread(c, staleState(c, l)));
      }
    }
  }
  // a thread whose anchor line is not in the diff still belongs to this file
  const stranded = threads.filter((c) => !placed.has(c));
  if (stranded.length) {
    body.appendChild(el("div", "run-head")).appendChild(
      el("span", "run-none", `${stranded.length} thread${stranded.length === 1 ? "" : "s"} anchored outside the diff`));
    const run2 = el("div", "run");
    for (const c of stranded) run2.appendChild(commentThread(c, "gone"));
    body.appendChild(run2);
  }
  box.append(el("div", "file-head", ""), body);
  (box.firstChild as HTMLElement).append(el("span", "path", f.path), el("span", "delta", f.delta));
  main.appendChild(box);
  return main;
}

/** the rail in this lens: every changed file, grouped by directory */
function renderFileRail(): HTMLElement {
  const list = el("div", "comps");
  const files = changedFiles();
  let lastDir = "";
  for (const f of files) {
    const dir = f.path.split("/").slice(0, -1).join("/");
    if (dir !== lastDir) {
      list.appendChild(el("div", "day-h", dir || "/"));
      lastDir = dir;
    }
    const st = fileStats(f);
    const btn = el("button", `comp${f.path === currentFile ? " active" : ""}`);
    const name = el("span", "comp-path", f.path.split("/").pop()!);
    name.title = f.path;
    const stats = el("span", "comp-stats");
    stats.appendChild(deltaChip(st.add, st.del));
    if (!st.objects.length) stats.appendChild(el("span", "no-obj", "no object"));
    for (const b of st.bands) stats.appendChild(el("i", `ft-band s${b}`));
    btn.append(name, stats);
    btn.addEventListener("click", () => selectFile(f.path));
    list.appendChild(btn);
  }
  return list;
}

/** the side panel in this lens: which objects live here, and where they belong */
function renderFileObjects(): HTMLElement {
  const box = el("div", "filetree");
  const f = fileByPath(currentFile);
  const ids = f ? fileStats(f).objects : [];
  if (!ids.length) {
    box.appendChild(el("p", "no-diff", "no indexed object declares anything in this file"));
    return box;
  }
  for (const id of ids) {
    const e = entry(id)!;
    const row = el("button", "ft-file");
    const name = el("span", "ft-name", e.name);
    name.title = e.summary;
    row.appendChild(name);
    const d = deltaOf(e.files);
    if (d.add || d.del) row.appendChild(deltaChip(d.add, d.del));
    const comp = componentOf(id);
    if (comp) row.appendChild(el("span", "ft-delta", comp.name));
    row.addEventListener("click", () => { if (comp) selectComponent(comp.id, id); });
    box.appendChild(row);
  }
  return box;
}

function renderComponentDoc(): HTMLElement {
  const comp = component(currentComponent) ?? page.components[0];
  ensureCurrent(comp);
  const main = el("main", "doc");
  main.id = "doc";

  // component totals: +/− over the WHOLE of each file its objects touch, since
  // the document shows the objects' own slices plus everything left over
  const paths = new Set<string>();
  for (const id of comp.entryIds) for (const f of entry(id)?.files ?? []) paths.add(f.path);
  const d = deltaOf((page.files ?? []).filter((f) => paths.has(f.path)));

  const head = el("header", "doc-head");
  const meta = el("p", "doc-meta");
  meta.appendChild(el("span", undefined, comp.stats));
  if (d.add || d.del) {
    meta.append(
      el("span", undefined, " \u00b7 "),
      deltaChip(d.add, d.del)
    );
  }
  head.append(el("h1", undefined, comp.name), meta);
  const origin = el("p", "origin", comp.origin);
  head.appendChild(origin);
  main.appendChild(head);

  const list = el("div", "entries");
  for (const id of comp.entryIds) {
    const e = entry(id);
    if (e) list.appendChild(renderEntry(e));
  }
  const rest = renderLeftovers(comp);
  if (rest) list.appendChild(rest);
  main.appendChild(list);
  return main;
}

// ---- connections -------------------------------------------------------------
// The graph shows the shape; this shows the reason. Every edge touching this
// object, split by direction, each row carrying the call site that put it
// there. Hovering a row lights the same wire in the graph panel.

function connectionRow(e: GraphEdge, selfId: string): HTMLElement {
  const otherId = e.a === selfId ? e.b : e.a;
  const outgoing = e.a === selfId;
  const other = entry(otherId)!;
  const kind = edgeKind(e);
  const row = el("div", `conn k-${kind}`);

  const head = el("div", "conn-head");
  head.append(el("span", "conn-dir", outgoing ? "→" : "←"));
  const nameBtn = el("button", "conn-name");
  nameBtn.textContent = other.name;
  nameBtn.title = `open ${other.name}`;
  nameBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const c = componentOf(otherId);
    if (c) selectComponent(c.id, otherId);
  });
  head.appendChild(nameBtn);
  head.appendChild(el("span", "conn-where", nodeFile(otherId).split("/").pop() ?? ""));
  // the state chip is the point: an unchanged caller of changed code is where
  // this PR can break something without touching it
  if (!outgoing && kind === "risk") head.appendChild(el("span", "conn-chip risk", "unchanged caller"));
  else head.appendChild(el("span", `conn-chip ${nodeSeed(otherId) ? "chg" : "un"}`, nodeSeed(otherId) ? "changed here" : "unchanged"));
  const oc = componentOf(otherId);
  if (oc && oc.id !== componentOf(selfId)?.id) head.appendChild(el("span", "conn-chip comp", oc.name));
  row.appendChild(head);

  // Call sites expand in place. The document only ever shows what the PR
  // changed, so an unchanged caller is never given a diff — it gets a plainly
  // labeled read-only peek at the head source instead, which is what a reviewer
  // needs to judge whether the change still fits the call.
  for (const s of e.sites ?? []) {
    const site = el("button", "conn-site");
    const chev = el("span", "conn-chev", "›");
    site.append(
      chev,
      el("span", "conn-at", `${s.file.split("/").pop()}:${s.line}`),
      el("code", undefined, s.text.length > 84 ? s.text.slice(0, 83) + "…" : s.text)
    );
    row.appendChild(site);
    if (!s.ctx?.length) continue;
    const peek = el("div", "peek");
    site.title = "read this call in place";
    site.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const open = peek.classList.toggle("open");
      site.classList.toggle("open", open);
      if (!open || peek.childElementCount) return;
      const changedSide = nodeSeed(otherId);
      peek.appendChild(el("div", "peek-note",
        `${s.file}${changedSide ? "" : " · not changed by this PR — shown for context"}`));
      s.ctx!.forEach((text, i) => {
        const n = (s.ctxStart ?? s.line) + i;
        const ln = el("div", `peek-line${n === s.line ? " at" : ""}`);
        ln.append(el("span", "peek-no", String(n)), el("code", undefined, text));
        peek.appendChild(ln);
      });
    });
    row.appendChild(peek);
  }
  const shown = e.sites?.length ?? 0;
  if (e.refs && e.refs > shown) {
    row.appendChild(el("div", "conn-more", `+${e.refs - shown} more reference site${e.refs - shown === 1 ? "" : "s"}`));
  }

  row.addEventListener("mouseenter", () => graphFocus?.([e.a, e.b], { a: e.a, b: e.b }));
  row.addEventListener("mouseleave", () => graphClear?.());
  return row;
}

function renderConnections(id: string): HTMLElement | null {
  const { out, in: incoming } = edgesOf(id);
  if (!out.length && !incoming.length) return null;

  const sec = el("section", "sec");
  sec.appendChild(el("h4", "sec-h", "Connections"));

  const untouched = incoming.filter((e) => !nodeSeed(e.a)).length;
  const sum = el("p", "conn-sum");
  sum.textContent =
    `${incoming.length} caller${incoming.length === 1 ? "" : "s"} · ${out.length} call${out.length === 1 ? "" : "s"} out` +
    (untouched && nodeSeed(id) ? ` · ${untouched} caller${untouched === 1 ? " is" : "s are"} untouched by this PR` : "");
  if (untouched && nodeSeed(id)) sum.classList.add("warn");
  sec.appendChild(sum);

  const group = (label: string, list: GraphEdge[]): void => {
    if (!list.length) return;
    const h = el("div", "conn-group");
    h.appendChild(el("span", undefined, label));
    // callers the PR never touched have no diff to show, so say so once here
    // rather than leaving the reviewer to wonder where their code went
    if (label === "called by" && list.some((x) => !nodeSeed(x.a))) {
      h.appendChild(el("span", "conn-group-note", "unchanged callers have no diff — open a call site to read it"));
    }
    sec.appendChild(h);
    // riskiest first: unchanged callers of changed code lead the list
    const ordered = [...list].sort((x, y) => {
      const w = (e: GraphEdge): number => (edgeKind(e) === "risk" ? 0 : edgeKind(e) === "co" ? 1 : 2);
      return w(x) - w(y);
    });
    for (const e of ordered) sec.appendChild(connectionRow(e, id));
  };
  group("called by", incoming);
  group("calls", out);
  return sec;
}

function renderEntry(e: Entry): HTMLElement {
  // an object the PR did not change has no diff to show, so collapsed it is a
  // one-line row rather than a full card — a component of 16 objects with one
  // change should cost one screen, not sixteen
  const compact = !e.seed && !expanded.has(e.id);
  const art = el("article", `entry${e.seed ? "" : " fill"}${compact ? " compact" : ""}${expanded.has(e.id) ? " open" : ""}`);
  art.id = `entry-${e.id}`;

  // the commit that introduced this object drives the card's band identity.
  // fill-only neighbors stay clean: they're unchanged context, no commit claims them.
  const intro = e.seed ? introducerOf(e.id) : undefined;
  if (intro) art.style.setProperty("--band", `var(--s${intro.stratum})`);

  // folder tab: the introducing commit's sha, stamped on the deposit line —
  // or a torn "unchanged" stub for fill-only context objects
  const tab = el("span", "entry-tab");
  if (compact) tab.classList.add("hidden");
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
  const entryDelta = deltaOf(e.files);
  if (entryDelta.add || entryDelta.del) nameRow.append(deltaChip(entryDelta.add, entryDelta.del));
  if (e.comments?.length) {
    const cb = el("span", "cmt-badge", `💬 ${e.comments.length}`);
    cb.title = "review threads";
    nameRow.append(cb);
  }
  // scan-level signal: callers this PR never touched, on an object it changed
  const wired = edgesOf(e.id);
  const untouchedCallers = wired.in.filter((x) => !nodeSeed(x.a)).length;
  if (e.seed && untouchedCallers) {
    const wc = el("span", "wire-chip", `${untouchedCallers} unchanged caller${untouchedCallers === 1 ? "" : "s"}`);
    wc.addEventListener("mouseenter", () => showHoverCard(wc, (card) => {
      card.appendChild(el("div", "hc-msg", "these callers were not modified by this PR but depend on code it changed"));
      for (const x of wired.in.filter((y) => !nodeSeed(y.a)).slice(0, 5)) {
        card.appendChild(el("div", "hc-who", entry(x.a)?.name ?? x.a));
      }
    }));
    wc.addEventListener("mouseleave", hideHoverCard);
    wc.addEventListener("mouseenter", () => graphFocus?.([e.id, ...wired.in.filter((y) => !nodeSeed(y.a)).map((y) => y.a)]));
    wc.addEventListener("mouseleave", () => graphClear?.());
    nameRow.append(wc);
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
  title.append(nameRow);
  if (compact) {
    const callers = edgesOf(e.id).in.length;
    nameRow.insertBefore(el("span", "row-chev", "›"), nameRow.firstChild);
    nameRow.append(el("span", "row-meta",
      `${nodeFile(e.id).split("/").pop() ?? ""}${callers ? ` · ${callers} caller${callers === 1 ? "" : "s"}` : ""}`));
  } else {
    title.append(el("p", "summary", e.summary));
  }
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
      // an object the PR never touched: no diff by definition. Say why it is
      // in the document at all and point at the wires that dragged it in.
      const why = el("p", "no-diff");
      const callers = edgesOf(e.id).in.filter((x) => nodeSeed(x.a)).length;
      why.textContent = callers
        ? `not changed by this PR — it is here because ${callers} changed object${callers === 1 ? "" : "s"} reference${callers === 1 ? "s" : ""} it`
        : "not changed by this PR — pulled in by the fill from changed code";
      why.appendChild(el("span", "no-diff-hint", "see Connections below for the call sites"));
      chg.appendChild(why);
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
    // -- connections -----------------------------------------------------------
    const conns = renderConnections(e.id);
    if (conns) body.appendChild(conns);
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
    rb.title = "mark this object as read";
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
    // accordion: opening one object closes the last, so the page always shows
    // a single diff and the sticky bar always names what you are reading
    if (expanded.has(e.id)) {
      expanded.delete(e.id);
      refresh();
    } else {
      openEntry(e.id, false);
    }
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
    if (page.branch) {
      const b = el("p", "ov-branch");
      const from = el("b", undefined, page.branch.head);
      from.title = page.branch.label ?? page.branch.head;
      b.append(from, el("span", undefined, ` \u2192 ${page.branch.base}`));
      sum.appendChild(b);
    }
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

// ---- changed files tree --------------------------------------------------------------
// GitHub-style repo structure for the PR: every changed file under its
// directory, with +/− deltas and a tick per time band that touched it.
// Clicking a file opens its full diff in an overlay.

function openFileOverlay(fd: FileDiff): void {
  const overlay = el("div", "overlay");
  const card = el("div", "file-overlay");
  const head = el("div", "fo-head");
  const pathSpan = el("span", "fo-path", fd.path);
  pathSpan.title = fd.path;
  head.append(pathSpan, el("span", "delta", fd.delta));
  const close = el("button", "strip-btn ghost", "close");
  close.addEventListener("click", () => overlay.remove());
  head.appendChild(close);
  const body = el("div", "fo-body");
  body.appendChild(renderFile(fd));
  card.append(head, body);
  overlay.appendChild(card);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function renderFileTree(): HTMLElement {
  const wrap = el("div", "filetree");
  const files = page.files ?? [];
  if (!files.length) {
    wrap.appendChild(el("p", "no-diff", "no changed files"));
    return wrap;
  }
  interface TreeNode {
    dirs: Map<string, TreeNode>;
    files: FileDiff[];
  }
  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts[i];
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
      node = node.dirs.get(d)!;
    }
    node.files.push(f);
  }
  const renderLevel = (node: TreeNode, depth: number): void => {
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dir = el("div", "ft-dir", name + "/");
      dir.style.paddingLeft = `${8 + depth * 13}px`;
      wrap.appendChild(dir);
      renderLevel(child, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const row = el("button", "ft-file");
      row.style.paddingLeft = `${8 + depth * 13}px`;
      const name = el("span", "ft-name", f.path.split("/").pop()!);
      name.title = f.path;
      row.appendChild(name);
      const bands = [...new Set(f.lines.map((l) => l.stratum).filter(Boolean) as number[])].sort((a, b) => a - b);
      for (const b of bands) row.appendChild(el("i", `ft-band s${b}`));
      row.appendChild(el("span", "ft-delta", f.delta));
      row.addEventListener("click", () => openFileOverlay(f));
      wrap.appendChild(row);
    }
  };
  renderLevel(root, 0);
  return wrap;
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

function edgeKind(e: { a: string; b: string }): EdgeKind {
  const ca = nodeSeed(e.a);
  const cb = nodeSeed(e.b);
  if (ca && cb) return "co";
  if (!ca && cb) return "risk";
  if (ca && !cb) return "out";
  return "quiet";
}

/** every edge touching this entry, in both directions, across components */
function edgesOf(id: string): { out: GraphEdge[]; in: GraphEdge[] } {
  const all = page.edges ?? [];
  return {
    out: all.filter((e) => e.a === id && entry(e.b)),
    in: all.filter((e) => e.b === id && entry(e.a))
  };
}

/** which component owns an entry — Connections rows jump across components */
function componentOf(id: string): ComponentDoc | undefined {
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

let graphFocus: ((ids: string[], edge?: { a: string; b: string }) => void) | null = null;
let graphClear: (() => void) | null = null;

/** light the document cards for these entries (empty array clears) */
function markDocCards(ids: string[]): void {
  for (const n of Array.from(document.querySelectorAll(".entry.wired"))) n.classList.remove("wired");
  for (const id of ids) document.getElementById(`entry-${id}`)?.classList.add("wired");
}

function renderComponentGraph(comp: ComponentDoc): HTMLElement {
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

let sideTab: "graph" | "files" = "graph";

function renderGraphPanel(): HTMLElement {
  // stale hooks would point at a graph that is no longer in the document
  graphFocus = null;
  graphClear = null;
  const side = el("aside", "side");
  if (mode === "commits") {
    side.appendChild(el("h3", "rail-h", "History"));
    side.appendChild(renderCommitHistory());
    return side;
  }
  if (mode === "files") {
    side.appendChild(el("h3", "rail-h", "Objects in this file"));
    side.appendChild(renderFileObjects());
    return side;
  }

  // components lens: toggle between the dependency graph and the repo tree
  side.appendChild(el("h3", "rail-h", sideTab === "files" ? "Changed files" : "Dependency graph"));
  const tabs = el("div", "side-tabs");
  const g = el("button", `side-tab${sideTab === "graph" ? " active" : ""}`, "graph");
  const f = el("button", `side-tab${sideTab === "files" ? " active" : ""}`, "files");
  g.addEventListener("click", () => { sideTab = "graph"; refresh(); });
  f.addEventListener("click", () => { sideTab = "files"; refresh(); });
  tabs.append(g, f);
  side.appendChild(tabs);
  side.appendChild(sideTab === "files"
    ? renderFileTree()
    : renderComponentGraph(component(currentComponent) ?? page.components[0]));
  return side;
}
// ---- export --------------------------------------------------------------------------
// Everything you wrote here leaves as one GitHub review: POST /api/export
// resolves the token server-side, and every export stamps the thread ids it
// carried in the review body, so re-exports skip already-pushed items instead of
// duping. Notes written in strata and threads that came back from GitHub travel
// through the same door.

interface ExportItem {
  id: string;
  path: string;
  line?: number;
  side: "RIGHT" | "LEFT";
  body: string;
  author: string;
  anchor: string;
  /** written here rather than fetched from GitHub */
  mine: boolean;
  sent: boolean;
  replies?: ReviewComment[];
}

function collectThreads(): ExportItem[] {
  const out: ExportItem[] = [];
  // your unsent notes lead: they are the reason to open this card
  for (const d of [...drafts].sort((a, b) => Number(!!a.exportedAt) - Number(!!b.exportedAt) || a.created.localeCompare(b.created))) {
    out.push({
      id: d.id,
      path: d.path,
      line: d.line,
      side: d.side,
      body: d.body,
      author: d.author,
      anchor: `${d.path}:${d.line}${d.side === "LEFT" ? " (removed)" : ""}`,
      mine: true,
      sent: !!d.exportedAt
    });
  }
  for (const e of Object.values(page.entries)) {
    for (const c of e.comments ?? []) {
      const anchor = c.anchor ?? "";
      out.push({
        id: String(c.id ?? anchor),
        path: anchor.replace(/:\d+\s*$/, ""),
        line: Number(anchor.match(/:(\d+)\s*$/)?.[1] ?? 0) || undefined,
        side: "RIGHT",
        body: c.body,
        author: c.author,
        anchor,
        mine: false,
        sent: false,
        replies: c.replies
      });
    }
  }
  return out;
}

function exportMarkdown(picked: ExportItem[]): string {
  const lines: string[] = [];
  for (const c of picked) {
    lines.push(`**${c.anchor || "(no anchor)"} — ${c.author}**`);
    lines.push(c.body);
    for (const r of c.replies ?? []) lines.push(`> ${r.author}: ${r.body}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** stamp the notes we just pushed so they never go twice */
function markExported(ids: string[]): void {
  const set = new Set(ids);
  const now = new Date().toISOString();
  for (const d of drafts) if (set.has(d.id) && !d.exportedAt) d.exportedAt = now;
  saveDrafts();
}

function openExportCard(): void {
  const threads = collectThreads();
  const overlay = el("div", "overlay");
  const card = el("div", "export-card");
  card.appendChild(el("h3", "exp-h", "Export review"));
  card.appendChild(el("p", "exp-note",
    `${threads.length} thread${threads.length === 1 ? "" : "s"} · pushed as one GitHub review${page.head ? ` on head ${page.head.slice(0, 7)}` : ""}`));
  const checks: HTMLInputElement[] = [];
  for (const c of threads) {
    const row = el("label", `exp-row${c.mine ? " mine" : ""}`);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !c.sent; // already on GitHub: listed, but not sent again
    checks.push(box);
    row.appendChild(box);
    const txt = el("span", "exp-txt");
    txt.append(
      el("b", undefined, c.anchor || "(no anchor)"),
      document.createTextNode(` — ${c.author}: ${c.body.length > 90 ? c.body.slice(0, 89) + "…" : c.body}`)
    );
    if (c.mine) txt.appendChild(el("span", `note-chip${c.sent ? " sent" : ""}`, c.sent ? "on github" : "yours"));
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
        comments: picked.map((c) => ({
          id: c.id,
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body
        }))
      })
    })
      .then((r) => r.json())
      .then((out) => {
        overlay.remove();
        if (!out.error) {
          markExported(picked.filter((c) => c.mine).map((c) => c.id));
          refresh();
        }
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

/** shared analyze flow: enter in the box starts the job, the progress line
    shows the live pipeline stage, done → navigate to the new review */
function wireAnalyze(input: HTMLInputElement, progress: HTMLElement): void {
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && input.value.trim()) {
      input.classList.add("busy");
      input.disabled = true;
      progress.classList.add("on");
      progress.textContent = "starting analysis";
      const fail = (msg: string): void => {
        progress.classList.remove("on");
        input.disabled = false;
        input.classList.remove("busy");
        window.alert(msg);
      };
      fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: input.value.trim() })
      })
        .then((r) => r.json())
        .then((out) => {
          if (out.error) return fail(out.error);
          const poll = (): void => {
            fetch("/api/progress")
              .then((r) => r.json())
              .then((p) => {
                if (p.stage) progress.textContent = p.stage;
                if (p.done) {
                  if (p.error) return fail(p.error);
                  location.href = `/?pr=${p.result.pr}`;
                  return;
                }
                window.setTimeout(poll, 1200);
              })
              .catch(() => window.setTimeout(poll, 2000));
          };
          poll();
        })
        .catch(() => fail("analysis could not be started"));
    }
  });
}

const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;

/** moon / sun pill: both states visible, the active one filled */
function makeThemeToggle(): HTMLElement {
  const group = el("div", "theme-switch");
  group.title = "color theme";
  const mkOpt = (set: string, svg: string, label: string): void => {
    const b = el("button", "ts-opt");
    b.dataset.set = set;
    b.title = `${label} theme`;
    b.setAttribute("aria-label", `${label} theme`);
    const ic = el("span", "ts-ic");
    ic.innerHTML = svg;
    b.appendChild(ic);
    b.addEventListener("click", () => {
      document.documentElement.dataset.theme = set;
      try { localStorage.setItem("strata-theme", set); } catch { /* storage unavailable */ }
      for (const o of Array.from(group.querySelectorAll(".ts-opt"))) o.classList.toggle("active", o === b);
    });
    group.appendChild(b);
  };
  mkOpt("dark", MOON_SVG, "dark");
  mkOpt("light", SUN_SVG, "light");
  const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  for (const b of Array.from(group.querySelectorAll<HTMLElement>(".ts-opt"))) b.classList.toggle("active", b.dataset.set === current);
  return group;
}

function renderTopbar(): HTMLElement {
  const bar = el("header", "topbar");
  const wm = el("a", "wordmark", "strata");
  wm.href = "/";
  wm.title = "home";
  bar.appendChild(wm);
  bar.appendChild(el("span", "spacer"));
  const addr = el("input", "pr-url") as HTMLInputElement;
  addr.type = "text";
  addr.placeholder = "paste github PR url";
  const progress = el("span", "analyze-progress");
  bar.appendChild(progress);
  wireAnalyze(addr, progress);
  bar.appendChild(addr);
  // a slot, not a button: the count changes every time you write a note, and
  // the topbar itself must not re-render (it owns the url field you type in)
  if (!onHome) bar.appendChild(el("span", "export-slot"));
  if (!onHome) {
    const ref = el("span", "pr-ref");
    ref.append(
      el("b", undefined, `${page.pr.repo} ${page.pr.number}`),
      document.createTextNode(` \u00b7 ${page.pr.title}`)
    );
    bar.appendChild(ref);
  }
  // the switch always sits last, hard right — same anchor as the home page
  bar.appendChild(makeThemeToggle());
  return bar;
}

function renderToggle(): HTMLElement {
  const wrap = el("div", "toggle-row");
  const t = el("div", "mode-toggle");
  const byCommit = el("button", undefined, "By commit");
  byCommit.setAttribute("data-mode", "commits");
  const byComp = el("button", undefined, "By component");
  byComp.setAttribute("data-mode", "components");
  const byFile = el("button", undefined, "By file");
  byFile.setAttribute("data-mode", "files");
  byCommit.addEventListener("click", () => setMode("commits"));
  byComp.addEventListener("click", () => setMode("components"));
  byFile.addEventListener("click", () => setMode("files"));
  t.append(byCommit, byComp, byFile);
  wrap.appendChild(t);
  return wrap;
}

// ---- home ----------------------------------------------------------------------------
// The landing page: everything analyzed so far, newest first, plus the
// bundled sample. Clicking the wordmark returns here from anywhere.

export interface HomeRecent {
  name: string;
  repo: string;
  number: string;
  title: string;
  commits: number;
  mtime: number;
  bands?: number[];
}

export function renderHome(recents: HomeRecent[]): void {
  onHome = true;
  dataName = "";

  document.body.textContent = "";

  const main = el("main", "home");
  const corner = el("div", "home-topright");
  corner.appendChild(makeThemeToggle());
  main.appendChild(corner);
  const hero = el("div", "hero");
  hero.appendChild(el("div", "hero-mark", "strata"));
  const input = el("input", "hero-input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "paste github PR url";
  const progress = el("div", "analyze-progress");
  wireAnalyze(input, progress);
  hero.append(input, progress);
  main.appendChild(hero);

  const rec = el("div", "home-recents");
  rec.appendChild(el("div", "home-h", "Recent"));
  const list = el("div", "home-list");
  if (!recents.length) {
    list.appendChild(el("p", "no-diff", "nothing analyzed yet — paste a github PR url above"));
  }
  for (const r of recents) {
    const row = el("button", "home-row");
    for (const b of r.bands ?? []) row.appendChild(el("i", `ft-band s${b}`));
    const d = new Date(r.mtime);
    row.appendChild(el("span", "home-repo", `${r.repo} ${r.number}`));
    const t = el("span", "home-title", r.title || r.name);
    t.title = r.title;
    row.appendChild(t);
    row.appendChild(el("span", "home-meta", `${r.commits} commit${r.commits === 1 ? "" : "s"} \u00b7 ${MONTHS[d.getMonth()]} ${d.getDate()}`));
    row.addEventListener("click", () => { location.href = `/?pr=${r.name}`; });
    list.appendChild(row);
  }
  rec.appendChild(list);
  main.appendChild(rec);
  document.body.appendChild(main);
}

export function render(p: PageData, prName?: string, bannerOverride?: string): void {
  page = p;
  dataName = prName ?? "";
  onHome = false;
  currentComponent = p.initialComponent;
  loadReview();
  loadDrafts();

  document.body.textContent = "";
  document.body.appendChild(renderTopbar());
  document.body.appendChild(renderToggle());
  const bannerText = bannerOverride ?? p.banner;
  document.body.appendChild(el("div", `banner${bannerText.startsWith("\u26a0") ? " warn" : ""}`, bannerText));
  document.body.appendChild(el("div", "strip-slot"));
  document.body.appendChild(el("div", "objbar-slot"));

  const layout = el("div", "layout");
  layout.appendChild(renderRail());
  layout.appendChild(docForMode());
  layout.appendChild(renderGraphPanel());
  document.body.appendChild(layout);
  fillStrip();
  fillObjBar();
  fillExport();
  wireKeys();
}
