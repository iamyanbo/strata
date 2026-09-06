// The landing page. It is the first thing anyone sees, so it says what strata
// does before asking for a PR url, and it says it with the same ink, bands and
// ribbons the app itself uses — every figure here is built from the product's
// own tokens rather than a screenshot that would go stale.

import { el, svgIcon, MONTHS } from "./dom.js";
import { makeThemeToggle, wireAnalyze } from "./chrome.js";
import { demoShot } from "./demo.js";

export interface HomeRecent {
  name: string;
  repo: string;
  number: string;
  title: string;
  commits: number;
  mtime: number;
  bands?: number[];
}

const IC = {
  lens: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg>`,
  ribbon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 3v18M11 6h8M11 11h6M11 16h9"/></svg>`,
  graph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="7" r="2.4"/><circle cx="12" cy="18" r="2.6"/><path d="M7.4 8 10.8 15.6M16.6 9 13.2 15.4"/></svg>`,
  fill: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h7M4 12h4M4 17h9"/><circle cx="17" cy="9" r="3"/><path d="M17 12v6"/></svg>`,
  note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
};

interface Feature { icon: string; title: string; body: string }

const FEATURES: Feature[] = [
  {
    icon: IC.lens,
    title: "Three lenses, one diff",
    body: "Read the PR by commit, by component, or by file. The lenses annotate each other — a file names the object that owns each run of lines, an object links back to the file — and every changed line is reachable in at least one of them."
  },
  {
    icon: IC.ribbon,
    title: "Every line carries its commit",
    body: "A tick beside each line is colored by the sweep of work that wrote it. Hover for the author, the timestamp and the message. Deletions carry it too: blame cannot see a removed line, so the commit that removed it is matched from its own diff."
  },
  {
    icon: IC.fill,
    title: "Components, not folders",
    body: "Changed symbols seed a flood fill over a TypeScript def−use index built from both trees. What the fill reaches becomes a unit you read top to bottom, and each object shows only the lines inside its own span."
  },
  {
    icon: IC.graph,
    title: "A graph that says why",
    body: "Arrows point caller → callee, colored by where the change falls on them. Unchanged callers of changed code are counted and filterable in one click, and every edge opens the source lines that put it there."
  },
  {
    icon: IC.note,
    title: "Notes that leave as a review",
    body: "Comment on any line — including a removed one, which anchors to the old file where GitHub still has it — and push your notes and the PR's existing threads as a single review."
  },
  {
    icon: IC.check,
    title: "Checkpoints that age",
    body: "Mark reviewed once. When the next push lands, only the objects those commits touched come back to unread; everything else stays where you left it."
  }
];

const STEPS: { n: string; name: string; body: string }[] = [
  { n: "1", name: "fetch", body: "shallow-clone just the commits around the PR" },
  { n: "2", name: "index", body: "TypeScript AST over base and head, imports resolved" },
  { n: "3", name: "fill", body: "seed from the diff, walk def−use edges three hops" },
  { n: "4", name: "read", body: "strata opens on the biggest change" }
];

export function renderHome(recents: HomeRecent[]): void {
  document.body.textContent = "";
  const main = el("main", "home");

  const nav = el("div", "home-nav");
  nav.append(el("span", "home-mark", "strata"), el("span", "spacer"), makeThemeToggle());
  main.appendChild(nav);

  // ---- hero
  const hero = el("section", "hero");
  hero.appendChild(el("p", "hero-eyebrow", "local code review for github pull requests"));
  hero.appendChild(el("h1", "hero-h1", "Read a pull request the way it was written."));
  hero.appendChild(el("p", "hero-sub",
    "strata rebuilds a PR from its commits: who wrote each line and when, which symbols actually changed, and what still depends on them. It runs on your machine and nothing leaves it."));

  const form = el("div", "hero-form");
  const input = el("input", "hero-input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "paste a github PR url, then press enter";
  const progress = el("div", "analyze-progress");
  wireAnalyze(input, progress);
  form.append(input);
  hero.append(form, progress);

  const alt = el("p", "hero-alt");
  const sample = el("a", "hero-link", "open the bundled example") as HTMLAnchorElement;
  sample.href = "/?pr=sample";
  alt.append(document.createTextNode("no url handy? "), sample);
  hero.appendChild(alt);
  main.appendChild(hero);

  main.appendChild(demoShot());

  // ---- what it does
  const feats = el("section", "home-sec");
  feats.appendChild(el("h2", "home-h2", "What it does"));
  const grid = el("div", "feat-grid");
  for (const f of FEATURES) {
    const card = el("article", "feat");
    card.append(svgIcon(f.icon, "feat-ic"), el("h3", "feat-h", f.title), el("p", "feat-b", f.body));
    grid.appendChild(card);
  }
  feats.appendChild(grid);
  main.appendChild(feats);

  // ---- how it works
  const how = el("section", "home-sec");
  how.appendChild(el("h2", "home-h2", "How it works"));
  const steps = el("div", "step-row");
  for (const s of STEPS) {
    const st = el("div", "step");
    st.append(el("span", "step-n", s.n), el("b", "step-name", s.name), el("span", "step-b", s.body));
    steps.appendChild(st);
  }
  how.appendChild(steps);
  how.appendChild(el("p", "home-note",
    "Everything is derived, never guessed: components come from the AST, ribbons from git blame and per-commit diffs, and any claim on screen can be traced to the line that produced it."));
  main.appendChild(how);

  // ---- recents
  const rec = el("section", "home-sec");
  rec.appendChild(el("h2", "home-h2", recents.length ? "Analyzed here" : "Nothing analyzed yet"));
  const list = el("div", "home-list");
  if (!recents.length) {
    list.appendChild(el("p", "home-empty", "paste a PR url above, or open the bundled example"));
  }
  for (const r of recents) {
    const row = el("button", "home-row");
    const bands = el("span", "home-bands");
    for (const b of r.bands ?? []) bands.appendChild(el("i", `ft-band s${b}`));
    const d = new Date(r.mtime);
    row.append(bands, el("span", "home-repo", `${r.repo} ${r.number}`));
    const t = el("span", "home-title", r.title || r.name);
    t.title = r.title;
    row.append(t, el("span", "home-meta",
      `${r.commits} commit${r.commits === 1 ? "" : "s"} · ${MONTHS[d.getMonth()]} ${d.getDate()}`));
    row.addEventListener("click", () => { location.href = `/?pr=${r.name}`; });
    list.appendChild(row);
  }
  rec.appendChild(list);
  main.appendChild(rec);

  const foot = el("footer", "home-foot");
  foot.append(
    el("span", undefined, "runs locally · your code and your token never leave this machine"),
    el("span", "spacer"),
    el("span", undefined, "MIT")
  );
  main.appendChild(foot);

  document.body.appendChild(main);
}
