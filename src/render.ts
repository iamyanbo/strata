import type { Commit, ComponentDoc, DiffLine, Entry, FileDiff, GraphEdge, PageData } from "./types.js";
import type { Comment as ReviewComment, DraftComment } from "./types.js";
import { el, svgEl, MONTHS } from "./dom.js";
import { lineNo, whenLabel, whenRange, isMergeCommit, authorColor, deltaOf, deltaChip } from "./format.js";
import { showHoverCard, hideHoverCard } from "./hovercard.js";
import {
  renderComponentGraph, componentOf, edgesOf, edgeKind, nodeFile, nodeSeed,
  graphFocus, graphClear, clearGraphHooks
} from "./graph.js";
import { makeThemeToggle, wireAnalyze } from "./chrome.js";
export { renderHome } from "./home.js";
export type { HomeRecent } from "./home.js";

// ---- rendering -------------------------------------------------------------
// Two lenses over one PR. The toggle switches the rail and the document:
//   by commit    — rail lists commits grouped by day; doc shows the commit
//                  and which components it FEEDS.
//   by component — rail lists derived components; doc shows entries with
//                  traces; each entry shows which commits WROTE it (ribbons).

export let page: PageData;
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

/** "I have reviewed this PR" means both halves: a checkpoint at today's
    commits, AND every changed object ticked off. Setting only the checkpoint
    made the rail switch from "14 changed" to "0/14 read", which reads like it
    threw your progress away. */
function markReviewed(): void {
  review = {
    seenCommits: page.commits.filter((c) => !isMergeCommit(c)).map((c) => c.sha),
    reviewedAt: Date.now(),
    read: reviewableIds()
  };
  saveReview();
}

/** every stop a reviewer is expected to visit: changed objects, plus each
    component's loose changes */
function reviewableIds(): string[] {
  const out = Object.entries(page.entries).filter(([, e]) => e.seed).map(([id]) => id);
  for (const c of page.components) if (unclaimedFiles(c).length) out.push(restId(c));
  return out;
}

/** lines in this object written or removed by a commit that did not exist at
    your last checkpoint */
function newSinceCheckpoint(id: string): number {
  // reviewedAt, not seenCommits.length: a force-push can leave a real
  // checkpoint with none of its commits still on the branch, and that is
  // exactly when everything should come back for another look
  if (!review?.reviewedAt) return 0;
  // the leftovers card ages on its own lines, like any other stop
  const files = isRest(id)
    ? unclaimedFiles(component(id.slice("rest:".length)) ?? page.components[0])
    : entry(id)?.files ?? [];
  let n = 0;
  for (const f of files) {
    for (const l of f.lines) {
      if (l.kind !== "ctx" && l.by && !review.seenCommits.includes(l.by)) n++;
    }
  }
  return n;
}

/** Read state ages with the code: a tick holds until a commit you have not
    seen touches that object, and then only that object goes back to unread. */
function isRead(id: string): boolean {
  if (!review?.read.includes(id)) return false;
  if (!review.reviewedAt) return true; // ticked by hand, never checkpointed
  return newSinceCheckpoint(id) === 0;
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
  reset.title = "forget the checkpoint and every read mark";
  reset.addEventListener("click", () => { clearReview(); refresh(); });

  const changedIds = reviewableIds();
  const unread = changedIds.filter((id) => !isRead(id)).length;

  if (!review) {
    s.appendChild(el("span", undefined,
      `not yet reviewed · ${real.length} commit${real.length === 1 ? "" : "s"} · ${changedIds.length} to review`));
    mark.title = "checkpoint at today's commits, and tick everything off";
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
    s.appendChild(el("span", undefined, unread
      ? `reviewed ${when} · ${unread} still unread`
      : `reviewed ${when} · all ${changedIds.length} read`));
    if (unread) {
      mark.textContent = "mark all read";
      s.append(mark, reset);
    } else {
      s.appendChild(reset);
    }
  } else {
    s.classList.add("has-new");
    // a push un-reads exactly the objects it touched, so say how many came back
    const back = changedIds.filter((id) => newSinceCheckpoint(id) > 0).length;
    s.appendChild(el("span", undefined,
      `reviewed ${when} · ${fresh.length} commit${fresh.length === 1 ? "" : "s"} since · ${newLineCount()} new line${newLineCount() === 1 ? "" : "s"} in ${back} object${back === 1 ? "" : "s"}`));
    mark.textContent = "reviewed again";
    mark.title = "move the checkpoint to these commits and tick everything off";
    s.append(mark, reset);
  }
  return s;
}

// ---- lookups ----------------------------------------------------------------

export function component(id: string): ComponentDoc | undefined {
  return page.components.find((c) => c.id === id);
}

export function entry(id: string): Entry | undefined {
  return page.entries[id];
}

function commit(id: string): Commit | undefined {
  return page.commits.find((c) => c.id === id);
}

/** commits that touched an entry, oldest first */
export function commitsOf(entryId: string): Commit[] {
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

/** scroll so `node` sits just below the sticky bar rather than under it.
    scrollIntoView({block:"start"}) puts the element's top at the viewport top,
    which is exactly where the bar is — that is what hid a file's heading when
    stepping between files. */
function scrollUnderBar(node: Element | null): void {
  if (!node) return;
  const slot = document.querySelector(".objbar-slot") as HTMLElement | null;
  const pad = (slot?.offsetHeight ?? 0) + 14;
  const top = node.getBoundingClientRect().top + window.scrollY - pad;
  // instant, not smooth: switching lens or file should land, not glide, and a
  // smooth scroll can be left half-finished when the next step arrives
  window.scrollTo(0, Math.max(0, top));
}

export function selectComponent(id: string, targetEntry?: string): void {
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
      scrollUnderBar(node);
      node.classList.add("flash");
      window.setTimeout(() => node.classList.remove("flash"), 1400);
    }
  }
}

function selectCommit(id: string): void {
  mode = "commits";
  currentCommit = id;
  refresh();
  scrollUnderBar(document.getElementById("doc"));
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
  const bar =
    mode === "components" && page.components.length ? renderObjectBar()
    : mode === "files" && changedFiles().length ? renderFileBar()
    : mode === "commits" ? renderCommitBar()
    : el("div", "objbar");
  // the lens switch leads: it is the outermost question the bar answers
  bar.insertBefore(el("div", "ob-sep"), bar.firstChild);
  bar.insertBefore(renderToggle(), bar.firstChild);
  slot.appendChild(bar);
  measureSticky();
}

/** the bar knows when it is pinned, so it can lift off the page under it */
function wireStuck(): void {
  const sentinel = document.querySelector(".sticky-sentinel");
  const slot = document.querySelector(".objbar-slot");
  if (!sentinel || !slot || typeof IntersectionObserver === "undefined") return;
  new IntersectionObserver(
    ([e]) => slot.classList.toggle("stuck", !e.isIntersecting)
  ).observe(sentinel);
}

/** the sticky bar's real height, so scrolling never hides a heading under it */
function measureSticky(): void {
  const slot = document.querySelector(".objbar-slot") as HTMLElement | null;
  const h = slot?.offsetHeight ?? 0;
  if (h) document.documentElement.style.setProperty("--stickyH", `${h + 12}px`);
}

/** by commit: the same walk, over commits */
function renderCommitBar(): HTMLElement {
  const bar = el("div", "objbar");
  const commits = page.commits.filter((c) => !isMergeCommit(c));
  if (!commits.length) return bar;
  if (!commits.some((c) => c.id === currentCommit)) currentCommit = commits[0].id;
  const at = Math.max(0, commits.findIndex((c) => c.id === currentCommit));
  const cur = commits[at];
  bar.appendChild(menuButton(
    "comp",
    () => {
      const lab = el("span", "menu-lab");
      lab.append(
        el("b", undefined, cur.message.length > 34 ? cur.message.slice(0, 33) + "…" : cur.message),
        el("span", "menu-sub", cur.sha)
      );
      return lab;
    },
    commits.map((c) => ({
      id: c.id,
      label: c.message,
      mark: c.id === currentCommit ? "•" : "",
      current: c.id === currentCommit,
      detail: () => el("span", "menu-kind", `${c.day} ${c.time}`)
    })),
    (id) => selectCommit(id)
  ));
  bar.appendChild(el("div", "ob-sep"));
  const nav = el("div", "ob-nav");
  const prev = el("button", "ob-step", "◂");
  prev.title = "newer commit";
  prev.disabled = at <= 0;
  prev.addEventListener("click", () => selectCommit(commits[at - 1].id));
  const next = el("button", "ob-step", "▸");
  next.title = "older commit";
  next.disabled = at >= commits.length - 1;
  next.addEventListener("click", () => selectCommit(commits[at + 1].id));
  nav.append(prev, el("span", "ob-count", `${at + 1} / ${commits.length}`), next);
  bar.appendChild(nav);
  bar.appendChild(el("span", "ob-keys", `${cur.author} · band ${cur.stratum}/4`));
  return bar;
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
}

// ---- time helpers -----------------------------------------------------------------


function commitBySha(sha: string): Commit | undefined {
  return sha ? page.commits.find((c) => c.sha === sha) : undefined;
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
// Comments authored in Strata live in localStorage until you push them: one
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
/** +/− chip in the review's own colors */
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
      const changed = objectsOf(c);
      const ctx = contextOf(c).length;
      const read = changed.filter((id) => isRead(id)).length;
      const stats = review && changed.length
        ? `${read}/${changed.length} read${ctx ? ` · ${ctx} unchanged` : ""}`
        : `${changed.length} to review${ctx ? ` · ${ctx} unchanged` : ""}`;
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

/** The objects a reviewer walks: the ones this PR changed, biggest change
    first. You cannot review what the PR did not touch, so referenced-but-
    unchanged objects are not stops on the way through — they are not counted,
    not stepped onto by j/k, and carry no read checkmark. */
function objectsOf(comp: ComponentDoc): string[] {
  const weight = (id: string): number => {
    const d = deltaOf(entry(id)!.files);
    return d.add + d.del;
  };
  const changed = comp.entryIds
    .filter((id) => entry(id)?.seed)
    .sort((a, b) => weight(b) - weight(a));
  // whatever belongs to no symbol is still part of the change, so it is the
  // last stop rather than something you scroll past
  return unclaimedFiles(comp).length ? [...changed, restId(comp)] : changed;
}

/** how a stop names itself, whether it is an object or the leftovers card */
function stopName(id: string): string {
  return isRest(id) ? "outside any object" : entry(id)?.name ?? id;
}

/** the rest: in the component because changed code reaches them */
function contextOf(comp: ComponentDoc): string[] {
  return comp.entryIds.filter((id) => entry(id) && !entry(id)!.seed);
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
  if (!list.includes(currentEntry)) currentEntry = list[0];
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
  scrollUnderBar(document.getElementById(`entry-${id}`));
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
  const list = objectsOf(comp);
  const read = new Set(list.filter((id) => isRead(id)));
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
    if (!st.objects.length) bar.appendChild(el("span", "conn-chip un", "no objects"));
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
  const ctx = contextOf(comp).length;

  const bar = el("div", "objbar");

  bar.appendChild(menuButton(
    "comp",
    () => {
      const lab = el("span", "menu-lab");
      lab.append(el("b", undefined, comp.name), el("span", "menu-sub", `${list.length}`));
      return lab;
    },
    page.components.map((c) => ({
      id: c.id,
      label: c.name,
      mark: c.id === comp.id ? "•" : "",
      current: c.id === comp.id,
      detail: () => el("span", "menu-kind", `${objectsOf(c).length} changed`)
    })),
    (id) => { currentEntry = ""; selectComponent(id); }
  ));

  bar.appendChild(el("div", "ob-sep"));

  if (!list.length) {
    bar.appendChild(el("span", "conn-chip un", `nothing to review · ${ctx} unchanged`));
    return bar;
  }

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
      lab.appendChild(el("b", undefined, stopName(currentEntry)));
      if (here) lab.appendChild(deltaDetail(here));
      return lab;
    },
    list.map((id) => ({
      id,
      label: stopName(id),
      mark: isRead(id) ? "✓" : newSinceCheckpoint(id) ? "↻" : "●",
      current: id === currentEntry,
      detail: () => (isRest(id) ? el("span", "menu-kind", "no symbol") : deltaDetail(entry(id)!))
    })),
    (id) => openEntry(id)
  ));

  // the current object's identity and read state, kept out of the scroll
  bar.appendChild(el("div", "ob-sep"));

  if (currentEntry) {
    const read = isRead(currentEntry);
    const tick = el("button", `ob-tick${read ? " on" : ""}`, read ? "✓ read" : "mark read");
    tick.title = "mark this as read";
    tick.addEventListener("click", () => { toggleRead(currentEntry); refresh(); });
    bar.appendChild(tick);
    const unread = objectsOf(comp).filter((id) => !isRead(id)).length;
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

/** Objects this PR does not change, kept out of the stream of changes and
    behind one click. They are here because changed code reaches them, and the
    reviewer asks for them deliberately rather than scrolling past them. */
function renderContextGroup(ids: string[]): HTMLElement | null {
  if (!ids.length) return null;
  const open = ids.some((id) => expanded.has(id));

  const art = el("article", `entry context-group${open ? " open" : " compact"}`);
  const head = el("header", "entry-head");
  const title = el("div", "entry-title");
  const nameRow = el("div", "name-row");
  const files = new Set(ids.map((id) => nodeFile(id).split("/").pop() ?? ""));
  nameRow.append(
    el("span", "row-chev", "›"),
    el("code", "name", "unchanged references"),
    el("i", "row-leader"),
    el("span", "kind", `${ids.length} object${ids.length === 1 ? "" : "s"}`),
    el("span", "row-meta", [...files].slice(0, 3).join(", ") + (files.size > 3 ? `, +${files.size - 3}` : ""))
  );
  title.append(nameRow);
  head.appendChild(title);
  art.appendChild(head);

  const fill = (): void => {
    const body = el("div", "entry-body context-body");
    body.appendChild(el("p", "conn-sum", "reached by the changes, unchanged themselves"));
    for (const id of ids) body.appendChild(renderEntry(entry(id)!));
    art.appendChild(body);
  };
  if (open) fill();
  head.addEventListener("click", () => {
    const nowOpen = art.classList.toggle("open");
    art.classList.toggle("compact", !nowOpen);
    const body = art.querySelector(".context-body");
    if (body) body.remove();
    else fill();
  });
  return art;
}

/** the id the leftovers card is reviewed under — it holds real changed lines,
    so it is a stop on the walk and it can be ticked off like anything else */
function restId(comp: ComponentDoc): string {
  return `rest:${comp.id}`;
}

function isRest(id: string): boolean {
  return id.startsWith("rest:");
}

function renderLeftovers(comp: ComponentDoc): HTMLElement | null {
  const files = unclaimedFiles(comp);
  if (!files.length) return null;
  const n = files.reduce((s, f) => s + f.lines.filter((l) => l.kind !== "ctx").length, 0);
  const id = restId(comp);
  const open = expanded.has(id);

  const art = el("article", `entry rest${open ? " open" : " compact"}`);
  art.id = `entry-${id}`;
  const head = el("header", "entry-head");
  const title = el("div", "entry-title");
  const nameRow = el("div", "name-row");
  const read = isRead(id);
  const tick = el("button", `read-tick${read ? " on" : ""}`);
  tick.title = read ? "marked as read — click to unmark" : "mark as read";
  tick.addEventListener("click", (ev) => { ev.stopPropagation(); toggleRead(id); refresh(); });
  nameRow.append(
    tick,
    el("code", "name", "outside any object"),
    el("i", "row-leader"),
    el("span", "kind", `${files.length} file${files.length === 1 ? "" : "s"}`),
    deltaChip(
      files.reduce((s, f) => s + f.lines.filter((l) => l.kind === "add").length, 0),
      files.reduce((s, f) => s + f.lines.filter((l) => l.kind === "del").length, 0)
    )
  );
  title.append(nameRow, el("p", "summary", "imports, top-level statements and test bodies — changes that belong to no symbol"));
  head.appendChild(title);
  head.appendChild(el("span", "trace-badge", `${n} line${n === 1 ? "" : "s"}`));
  art.appendChild(head);

  if (open) {
    const wrap = el("div", "entry-body");
    const sec = el("section", "sec");
    sec.appendChild(el("h4", "sec-h", "Changes"));
    for (const f of files) sec.appendChild(renderFile(f));
    wrap.appendChild(sec);
    art.appendChild(wrap);
  }
  head.addEventListener("click", () => {
    if (expanded.has(id)) { expanded.delete(id); refresh(); }
    else openEntry(id, false);
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
  // the file's heading, its totals and the "no object covers this" note are the
  // point of arriving — park them under the bar, not above the fold
  scrollUnderBar(document.getElementById("doc"));
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
      ? `${st.objects.length} object${st.objects.length === 1 ? "" : "s"} · every changed line, in order`
      : "no symbol covers this file — it appears only in this lens"));
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
      label.appendChild(el("span", "run-none", "no object"));
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
    box.appendChild(el("p", "no-diff", "no object declares anything here"));
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
  // count what the reviewer walks, not everything the fill reached
  const nStops = objectsOf(comp).length;
  const nCtx = contextOf(comp).length;
  meta.appendChild(el("span", undefined,
    `${nStops} to review${nCtx ? ` · ${nCtx} unchanged` : ""}`));
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
  // the walk's last stop is the leftovers card, which renderLeftovers appends
  for (const id of objectsOf(comp)) {
    if (!isRest(id)) list.appendChild(renderEntry(entry(id)!));
  }
  const ctx = renderContextGroup(contextOf(comp));
  if (ctx) list.appendChild(ctx);
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
      peek.appendChild(el("div", "peek-note", `${s.file}${changedSide ? "" : " · unchanged"}`));
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
    (untouched && nodeSeed(id) ? ` · ${untouched} unchanged` : "");
  if (untouched && nodeSeed(id)) sum.classList.add("warn");
  sec.appendChild(sum);

  const group = (label: string, list: GraphEdge[]): void => {
    if (!list.length) return;
    const h = el("div", "conn-group");
    h.appendChild(el("span", undefined, label));
    // callers the PR never touched have no diff to show, so say so once here
    // rather than leaving the reviewer to wonder where their code went
    if (label === "called by" && list.some((x) => !nodeSeed(x.a))) {
      h.appendChild(el("span", "conn-group-note", "open a call site to read it"));
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
  const read = isRead(e.id);
  // only what changed can be reviewed, so only what changed carries the tick
  if (e.seed) {
    const tick = el("button", `read-tick${read ? " on" : ""}`);
    tick.title = read ? "marked as read — click to unmark" : "mark as read";
    tick.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleRead(e.id);
      refresh();
    });
    nameRow.appendChild(tick);
  }
  nameRow.append(
    el("code", "name", e.name),
    el("i", "row-leader"),
    el("span", "kind", e.kind)
  );
  const entryDelta = deltaOf(e.files);
  if (entryDelta.add || entryDelta.del) nameRow.append(deltaChip(entryDelta.add, entryDelta.del));
  if (e.comments?.length) {
    nameRow.append(threadChip(e.comments.length));
  }
  // scan-level signal: callers this PR never touched, on an object it changed
  const wired = edgesOf(e.id);
  const untouchedCallers = wired.in.filter((x) => !nodeSeed(x.a)).length;
  if (e.seed && untouchedCallers) {
    const wc = el("span", "wire-chip", `${untouchedCallers} unchanged caller${untouchedCallers === 1 ? "" : "s"}`);
    wc.addEventListener("mouseenter", () => showHoverCard(wc, (card) => {
      card.appendChild(el("div", "hc-msg", "unchanged callers of code this PR changed"));
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
    if (newLines && !read) {
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
  // the header carries the blast radius, not a count of the rows in Impact:
  // "2 facts" was a reference count plus a test fact, on every single card
  head.appendChild(title);
  if (e.refs) {
    const badge = el("span", "trace-badge", `${e.refs} ref${e.refs === 1 ? "" : "s"}`);
    badge.title = `${e.refs} reference${e.refs === 1 ? "" : "s"} at head`;
    head.appendChild(badge);
  }
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
      // an object the PR never touched has no diff by definition. Say who
      // reaches it, by name — a count answers nothing a reviewer can act on.
      const why = el("p", "no-diff");
      const callers = edgesOf(e.id).in.filter((x) => nodeSeed(x.a));
      if (callers.length) {
        const names = callers.slice(0, 2).map((x) => entry(x.a)?.name ?? x.a);
        const more = callers.length - names.length;
        why.appendChild(document.createTextNode("Unchanged. Reached by "));
        names.forEach((n, i) => {
          if (i) why.appendChild(document.createTextNode(more ? ", " : " and "));
          why.appendChild(el("code", "why-name", n));
        });
        why.appendChild(document.createTextNode(more ? ` and ${more} more.` : "."));
      } else {
        why.textContent = "Unchanged. Pulled in from changed code nearby.";
      }
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
    const readNow = isRead(e.id);
    if (!e.seed) foot.classList.add("hidden");
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

  // no sibling nav down here: the sticky bar walks commits from the top, and
  // a second pair of arrows at the bottom only competes with it

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


// commit history: a github-style list, newest → oldest, stratum color = time band,
// avatar + contributor chips for the people dimension. Merge commits are excluded
// (they change no files themselves — pure plumbing).
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
  clearGraphHooks();
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
// duping. Notes written in Strata and threads that came back from GitHub travel
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
const THREAD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>`;

/** the thread count, with a drawn bubble rather than an emoji */
function threadChip(n: number): HTMLElement {
  const chip = el("span", "cmt-badge");
  const ic = el("span", "chip-ic");
  ic.innerHTML = THREAD_SVG;
  chip.append(ic, el("span", undefined, String(n)));
  chip.title = `${n} review thread${n === 1 ? "" : "s"}`;
  return chip;
}

// ---- lineage line --------------------------------------------------------------
// What the old banner said, in the order a reviewer needs it: where this merges
// from and to, then exactly which two commits the diff spans, both linked to
// GitHub. The analysis method (AST index, hop count, blame) is true but it is
// not something you re-read every session, so it moves behind the ⓘ.

function ghBase(): string {
  return page.pr.repo ? `https://github.com/${page.pr.repo}` : "";
}

function ghLink(cls: string, text: string, href: string, title?: string): HTMLElement {
  if (!href) return el("span", cls, text);
  const a = el("a", cls, text) as HTMLAnchorElement;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  if (title) a.title = title;
  return a;
}

/** "colinhacks:branch" (a fork) → that fork's own tree */
function branchHref(ref: string, label?: string): string {
  if (!ghBase()) return "";
  const forked = label?.includes(":") ? label.split(":") : null;
  return forked
    ? `https://github.com/${forked[0]}/${page.pr.repo.split("/")[1]}/tree/${forked[1]}`
    : `${ghBase()}/tree/${ref}`;
}

function renderLineage(bannerText: string): HTMLElement {
  // the mock/failure banner keeps its loud form — it is a warning, not lineage
  if (bannerText.startsWith("⚠")) return el("div", "banner warn", bannerText);

  const wrap = el("div", "lineage");
  // the bundled example still says so — it is the one dataset that ships
  if (bannerText.startsWith("sample dataset")) wrap.appendChild(el("span", "conn-chip comp", "sample"));
  const b = page.branch;
  if (b) {
    wrap.appendChild(el("span", "lin-cap", "merging"));
    wrap.appendChild(ghLink("lin-branch head", b.head, branchHref(b.head, b.label), b.label ?? b.head));
    wrap.appendChild(el("span", "lin-arrow", "→"));
    wrap.appendChild(ghLink("lin-branch base", b.base, branchHref(b.base)));
    wrap.appendChild(el("span", "lin-dot", "·"));
  }

  const base = page.base ?? "";
  const head = page.head ?? "";
  if (base || head) {
    wrap.appendChild(el("span", "lin-cap", "diff"));
    wrap.appendChild(ghLink("lin-sha", base.slice(0, 7) || "base",
      base ? `${ghBase()}/commit/${base}` : "", "the commit this PR is measured against"));
    wrap.appendChild(el("span", "lin-range", "…"));
    wrap.appendChild(ghLink("lin-sha", head.slice(0, 7) || "head",
      head ? `${ghBase()}/commit/${head}` : "", "the newest commit in this PR"));
    if (base && head && ghBase()) {
      wrap.appendChild(ghLink("lin-out", "compare ↗", `${ghBase()}/compare/${base}...${head}`,
        "open this range on github"));
    }
    wrap.appendChild(el("span", "lin-dot", "·"));
  }

  const num = page.pr.number.replace("#", "");
  if (num && ghBase()) {
    wrap.appendChild(ghLink("lin-out", `PR ${page.pr.number} ↗`, `${ghBase()}/pull/${num}`, "open the pull request"));
  }

  // the method, kept but demoted: hover to read how this page was built
  const info = el("button", "lin-info", "ⓘ");
  info.setAttribute("aria-label", "how this analysis was built");
  info.addEventListener("mouseenter", () => showHoverCard(info, (card) => {
    card.appendChild(el("div", "hc-when", "how this page was built"));
    // the method is a typed list; the banner string is only a fallback for
    // datasets emitted before it existed
    const parts = page.method ?? bannerText.split(" · ").filter((x) => !/→/.test(x));
    for (const part of parts) card.appendChild(el("div", "hc-msg", part));

  }));
  info.addEventListener("mouseleave", hideHoverCard);
  wrap.appendChild(info);
  return wrap;
}

function renderTopbar(): HTMLElement {
  const bar = el("header", "topbar");
  const wm = el("a", "wordmark", "Strata");
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
    const num = page.pr.number.replace("#", "");
    ref.append(
      ghLink("pr-link", `${page.pr.repo} ${page.pr.number}`,
        num && ghBase() ? `${ghBase()}/pull/${num}` : "", "open the pull request on github"),
      document.createTextNode(` \u00b7 ${page.pr.title}`)
    );
    bar.appendChild(ref);
  }
  // the switch always sits last, hard right — same anchor as the home page
  bar.appendChild(makeThemeToggle());
  return bar;
}

function renderToggle(): HTMLElement {
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
  for (const b of [byCommit, byComp, byFile]) {
    b.classList.toggle("active", b.getAttribute("data-mode") === mode);
  }
  return t;
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
  const bannerText = bannerOverride ?? p.banner;
  document.body.appendChild(renderLineage(bannerText));
  document.body.appendChild(el("div", "strip-slot"));
  document.body.appendChild(el("div", "sticky-sentinel"));
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
  wireStuck();
}
