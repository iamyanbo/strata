// Page furniture that is not a view: the theme switch, and the "paste a PR url"
// control that drives an analysis. Both the landing page and the topbar use
// them, so neither owns them.

import { el } from "./dom.js";

const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;

/** moon / sun pill: both states visible, the active one filled */
export function makeThemeToggle(): HTMLElement {
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
  for (const b of Array.from(group.querySelectorAll<HTMLElement>(".ts-opt"))) {
    b.classList.toggle("active", b.dataset.set === current);
  }
  return group;
}

/** Enter on a PR url starts the analysis and follows its progress until the
    dataset is ready, then opens it. */
export function wireAnalyze(input: HTMLInputElement, progress: HTMLElement): void {
  input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || !input.value.trim()) return;
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
  });
}
