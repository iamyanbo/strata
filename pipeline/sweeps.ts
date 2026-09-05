// Sweep clustering: bursts of commit activity become time bands.
// A new sweep starts when the calendar day changes or the gap to the previous
// commit exceeds STRATA_SWEEP_GAP_HOURS (default 2). Up to 4 sweeps each get
// their own band on the ramp; more are folded onto it. Without timestamps,
// bands fall back to commit order (newest-first input expected).

import type { RawCommit } from "./git.js";
import type { Stratum } from "../src/types.js";

export const SWEEP_GAP_HOURS = Number(process.env.STRATA_SWEEP_GAP_HOURS || 2);

export function sweepBands(commits: RawCommit[]): Map<string, Stratum> {
  const bandOfSha = new Map<string, Stratum>();
  const chronological = [...commits].reverse(); // oldest first
  if (chronological.length && chronological[0].ts) {
    const gapMs = SWEEP_GAP_HOURS * 3600 * 1000;
    const sweeps: { shas: string[] }[] = [];
    let prev: number | null = null;
    let prevDay = "";
    for (const c of chronological) {
      const t = new Date(c.ts!.replace(" ", "T")).getTime();
      const day = c.ts!.slice(0, 10);
      if (prev === null || day !== prevDay || t - prev > gapMs) sweeps.push({ shas: [] });
      sweeps[sweeps.length - 1].shas.push(c.sha);
      prev = t;
      prevDay = day;
    }
    const n = sweeps.length;
    for (let i = 0; i < n; i++) {
      const band = (n <= 4 ? i + 1 : Math.min(4, Math.floor((i / n) * 4) + 1)) as Stratum;
      for (const sha of sweeps[i].shas) bandOfSha.set(sha, band);
    }
  } else {
    const m = Math.max(commits.length, 1);
    commits.forEach((c, i) => {
      // git log order is newest-first, so band 1 (oldest) maps to the LAST index
      const band = Math.min(3, Math.floor(((m - 1 - i) / m) * 4));
      bandOfSha.set(c.sha, (band + 1) as Stratum);
    });
  }
  return bandOfSha;
}

/** did the commit that wrote the line postdate the comment? (epoch seconds vs ISO) */
export function isStaleWriter(writerAt: number, createdIso: string): boolean {
  const t = Date.parse(createdIso) / 1000;
  return Number.isFinite(t) && writerAt > t;
}
