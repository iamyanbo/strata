# strata

A local code-review workspace for GitHub pull requests. Paste a PR URL and
strata rebuilds the change as it actually happened: every written line
stamped with the commit that produced it, related changes grouped into
components by how the code references itself, and review threads that age
with the code instead of against it.

Everything on screen is computed — from git history and the TypeScript AST,
by deterministic code. No LLM writes a word of what you see.

## Quickstart

```sh
git clone <this repo>
cd strata
npm install
npx tsc                # compile the viewer + pipeline to dist/
node scripts/serve.mjs # → http://localhost:4517
```

The app opens on its home page — everything you've analyzed, newest first,
plus the bundled sample PR. To review your own, paste any merged GitHub PR
URL into the top bar:

```sh
node scripts/analyze.mjs https://github.com/owner/repo/pull/123
# (same thing as pasting the URL into the app)
```

The first analysis shallow-fetches the PR's repository into `repos/` — only
the commits around the PR, not the full history. Everything stays local.

## What you get

**Time ribbons.** Every line the PR wrote carries a tick colored by the
*sweep* that wrote it — a burst of commit activity separated by a calendar
day or a 2-hour gap. Blue = the careful first draft; red = the pass bolted on
an hour before opening. Hovering a tick gives the exact commit, author and
timestamp. Content that appears during a merge commit (hand-resolved
conflicts) gets its own hatched marker — it's the code nobody wrote
deliberately.

**Components, not files.** Changed symbols seed a flood fill over the
def−use graph; what they reach becomes a component you read top to bottom.
The dependency graph panel shows the local shape, and a replay walks the PR
commit by commit.

**A graph that says why.** Edges are directed — arrows point caller → callee —
and colored by where the PR's changes sit on them: both ends changed, changed
code reaching into stable code, or an **unchanged caller depending on changed
code**, which is the shape most breakage takes. That last one is counted under
the graph and filterable in one click. Hovering an edge shows the actual source
lines that put it there.

**Connections on every object.** Each card lists its callers and its calls,
riskiest first, each with the call site verbatim (`file.ts:297 json.items =
processSchema(...)`) and a jump to the other object — so the reason the graph
has that shape is readable in the document, not just inferable from the picture.
Hovering a row lights the matching wire in the graph, and vice versa.

Most callers of a changed function were not themselves changed, so they have no
diff to show — and the document only ever shows what the PR changed. Instead,
every call site opens in place: a few lines of head source with the call line
marked, labeled *not changed by this PR*. The reason an unchanged object is in
the document at all is stated on its card, with a pointer to the call sites that
pulled it in.

**One object at a time.** A component opens on its first changed object with
the diff already on screen. A sticky bar carries the component, the object, a
`3 / 16` counter with prev/next, a jump menu and the read tick, so none of that
scrolls away while you read. `j` / `k` walk the component, `n` jumps to the next
unread object, `Esc` collapses. Objects the PR did not change collapse to
one-line rows — a component of sixteen objects with one change costs one screen,
not sixteen.

**Review checkpoints.** Mark reviewed once; on the next push only what
changed since renders at full attention — everything you already read dims.
Checkmarks per object track what you personally read. Force-pushes are
detected and handled.

**Threads that age with the code.** Comments survive force-pushes via line
anchors, and when a commented line is rewritten *after* the comment, the
thread flags "rewritten since" with an expandable before/after of what
changed. Facts like "covered by X.test.ts" jump straight to the covering
test's diff, and "untested" is stated plainly on the object header.

**Export.** Push your threads back to GitHub as a single review (needs
`GITHUB_TOKEN`); re-exports skip already-pushed threads.

## How it works

```
scripts/analyze.mjs   shallow-fetch the PR's merge commit + window
pipeline/git.ts       parse the PR shape: commits, per-commit diffs, whole-PR diff
pipeline/index.ts     TypeScript AST over base and head trees; def−use resolution
pipeline/flow.ts      flood fill from changed symbols → components
pipeline/emit.ts      sweeps, per-line blame attribution, staleness pairs → data/<pr>.json
src/                  the viewer: DOM rendering, no framework
```

Two lenses over the same data at all times: **By component** (what changed,
grouped by how the code relates) and **By commit** (when it changed, with a
contributions map of who wrote what where).

## Honest limitations

- The indexer reads **TypeScript/JavaScript** only; PRs touching other
  languages still load, but their symbols aren't analyzed.
- Analyzes **merged** PRs (it needs a merge/squash commit to define the window).
- Sweep detection uses a 2-hour gap heuristic; blame attribution needs the
  writing commit inside the shallow-fetch window (PR commits always are).
- One local user: checkpoints and read marks live in your browser's
  localStorage. This is a review *workbench*, not a hosted review system.

## Secrets

Export reads `GITHUB_TOKEN` (or a `github.token` file in the repo root).
Analysis reads public API endpoints without a token (60 req/hr — set
`GITHUB_TOKEN` to raise it). The token never leaves the local server process.

## Development

```sh
npx tsc                    # build
npx tsc --watch            # rebuild on change
npm test                   # unit tests (diff parser, sweeps, staleness rule)
node scripts/smoke.mjs     # headless render check against data/sample.json
```

Knobs: `STRATA_SWEEP_GAP_HOURS` (default 2) controls when a burst of commits
becomes a new sweep; `STRATA_FETCH_DEPTH` overrides the shallow-fetch depth
when a PR window needs more ancestors.

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules,
the main one being: every signal on screen must be computable and traceable
to a commit. MIT licensed.
