import { PAGE } from "./data.js";
import { render } from "./render.js";
import type { PageData } from "./types.js";

// Real pipeline output (data/<pr>.json); on failure, render the mock
// with a loud banner so mock data can never masquerade as real.
const MOCK_BANNER = "\u26a0 MOCK DATA \u2014 pipeline output failed to load. This is the fictional demo PR, not a real repository.";

const SAMPLE_PR = "sample"; // bundled example PR, committed under data/

async function boot(): Promise<void> {
  // theme: persisted choice, dark by default
  try {
    document.documentElement.dataset.theme = localStorage.getItem("strata-theme") ?? "dark";
  } catch { document.documentElement.dataset.theme = "dark"; }

  let PR = new URLSearchParams(location.search).get("pr");
  if (!PR) {
    // no ?pr= → ask the server for the most recently analyzed PR;
    // a fresh clone has none, so land on the bundled sample
    try {
      PR = (await (await fetch("/api/latest")).json()).pr;
    } catch { PR = SAMPLE_PR; /* file:// or older server */
    }
    if (!PR) PR = SAMPLE_PR;
  }
  if (!PR) { render({ ...PAGE, banner: MOCK_BANNER }); return; }
  try {
    const r = await fetch(`data/${PR}.json?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`pipeline output ${r.status}`);
    const p = (await r.json()) as PageData;
    console.log(`[strata] real data: ${p.pr.repo} ${p.pr.number} · head ${p.banner}`);
    const banner = PR === SAMPLE_PR
      ? `sample PR — paste a github PR url above to review your own · ${p.banner}`
      : p.banner;
    render(p, PR, banner);
  } catch (err) {
    console.warn("[strata] falling back to mock:", err);
    render({ ...PAGE, banner: MOCK_BANNER });
  }
}

void boot();
