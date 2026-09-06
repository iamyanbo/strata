// Pure presentation helpers: how a timestamp, a delta or an author's initial
// looks. No state, no DOM queries — safe to use from any view.

import type { Commit, FileDiff } from "./types.js";
import { el, MONTHS } from "./dom.js";

export function lineNo(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}

/** "2024-06-03 14:02" → "Jun 3 · 14:02"; falls back to the day+time fields */
export function whenLabel(ts: string | undefined, day: string, time: string): string {
  const m = ts?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  if (!m) return `${day} ${time}`.trim();
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])} · ${m[4]}`;
}

/** compact span: same day → "Jun 3 · 14:02–16:20" (single stamp when the sweep
    spans one minute), else "Jun 3 14:02 → Jun 5 09:12" */
export function whenRange(from: string | undefined, to: string | undefined): string {
  if (!from) return "";
  const fm = from.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  const tm = (to ?? from).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  if (!fm || !tm) return "";
  if (fm[1] === tm[1] && fm[2] === tm[2] && fm[3] === tm[3]) {
    if (fm[4] === tm[4]) return `${MONTHS[Number(fm[2]) - 1]} ${Number(fm[3])} · ${fm[4]}`;
    return `${MONTHS[Number(fm[2]) - 1]} ${Number(fm[3])} · ${fm[4]}–${tm[4]}`;
  }
  return `${MONTHS[Number(fm[2]) - 1]} ${Number(fm[3])} ${fm[4]} → ${MONTHS[Number(tm[2]) - 1]} ${Number(tm[3])} ${tm[4]}`;
}

/** merge commits change no files themselves — pure plumbing, excluded everywhere */
export function isMergeCommit(c: Commit): boolean {
  return /^Merge (pull request|branch|remote-tracking)/.test(c.message);
}

/** stable avatar tint per person, so the same author keeps the same color */
export function authorColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `av${h % 6}`;
}

export function deltaOf(files: FileDiff[]): { add: number; del: number } {
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

export function deltaChip(add: number, del: number): HTMLElement {
  const chip = el("span", "delta-chip");
  if (add) chip.appendChild(el("b", "plus", `+${add}`));
  if (del) chip.appendChild(el("b", "minus", `−${del}`));
  return chip;
}
