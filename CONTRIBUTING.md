# Contributing to strata

Thanks for taking a look. A few ground rules keep this project what it is.

## The one design rule

**Every signal on screen is computed, never invented.** Ribbons, sweeps,
staleness, components — all derived from git and the TypeScript AST by
deterministic code, and every claim must be traceable to a commit. Features
that require guessing (LLM summaries, "risk scores" from vibes, heuristics
you can't explain in one sentence) don't belong here. If your change adds a
new signal, document the exact rule it follows.

## Getting started

```sh
git clone <your fork>
cd strata
npm install
npx tsc            # build dist/
node scripts/serve.mjs
# open http://localhost:4517 — the bundled sample PR loads
```

To analyze a real PR, paste its GitHub URL into the top bar, or:

```sh
node scripts/analyze.mjs https://github.com/owner/repo/pull/123
```

The first analysis shallow-fetches the PR's repository into `repos/`
(a few hundred MB for large projects). Nothing leaves your machine except
GitHub API reads.

## Before you open a PR

- `npx tsc` — no errors
- `node scripts/smoke.mjs` — passes with real pipeline data
- If you touched the pipeline: regenerate a dataset and click through both
  lenses (By commit / By component)
- UI changes: check the dark **and** light theme

## Code style

- TypeScript, strict; no framework in the renderer — DOM only
- Colors and spacing come from the variables in `src/style.css`; nothing
  hardcodes a hex value outside `:root` / `[data-theme="light"]`
- Comments explain constraints and rules, not what the next line does

## Reporting bugs

Include: the PR URL, the output of `node scripts/analyze.mjs <url>` up to the
failure, and your OS + node version. If the viewer misrenders a dataset,
attach the generated `data/<pr>.json` (it contains only public PR data).
