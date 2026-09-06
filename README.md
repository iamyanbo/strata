# Strata

A local code-review workspace for GitHub pull requests. Paste a PR URL and
Strata rebuilds the change as it actually happened: every written line
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

**Three lenses over one PR.** *By commit* walks the history, *by component*
follows the def−use fill, and *by file* is the completeness backstop: the
component lens is a lens, and on a real PR it reaches only about half the changed
lines — docs, untyped sources and files whose changes fall outside every
top-level symbol never appear in it. The file lens lists every changed file, and
shows each one in line order with each run of lines labeled by the object that
owns it (click through to that object), or marked as belonging to none. Review
threads on files no object covers finally have a home there.

**One object, one diff.** An object shows the lines inside its own span — its
declaration, its body, and the doc comment *attached* to it (a `////////` rule or
a comment separated by a blank line belongs to no symbol, so an added blank line
above one is not a change to the interface below it) — not the whole file it
happens to live in. A change made only of blank lines or separator rules is not
a change: the symbol stays context, and the line falls to the file view. Six symbols declared in one edited file used to render six copies of the
same file-wide diff, with the same threads and the same introducing commit on
each. Review threads land on the object whose span contains them, and a commit
"touches" an object only when it wrote or removed one of that object's lines.
Whatever belongs to no symbol — imports, top-level statements, the bodies of
test callbacks — is collected into a card at the end of the component: real
changed lines, so it reads like any other change and is ticked off like one.

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
unread object, `Esc` collapses. Objects the PR did not change are not mixed in
with the ones it did: they wait at the end of the component behind one collapsed
row, *unchanged references*, and each says by name what reaches it. They take no part in reviewing either: no read checkmark, no place in the
counter, and `j`/`k` step past them — you cannot review what the PR did not
change. A component of sixteen objects with one change costs one screen, not
sixteen.

**Checks, stamped.** The lineage line carries CI on the head commit as it stood
when the PR was analyzed — passing, failing with the names of what failed, or
still running — linked to the checks tab. It says *read <time>* on hover,
because a dataset is a photograph and CI keeps running after the shutter.

**Review checkpoints.** *Mark reviewed* does what it says: it drops a
checkpoint at today's commits **and** ticks off every changed object. On the
next push, only the objects those commits touched come back to unread — the
rest stay read, so `11/11` becomes `5/11` and the strip tells you which commits
did it. Individual ticks still work for reviewing in passes, *reset* forgets the
checkpoint and every tick, and force-pushes are detected and handled.

**Threads that age with the code.** Comments survive force-pushes via line
anchors, and when a commented line is rewritten *after* the comment, the
thread flags "rewritten since" with an expandable before/after of what
changed. Facts like "covered by X.test.ts" jump straight to the covering
test's diff, and "untested" is stated plainly on the object header.

**Write the review here.** Hover any diff line and the `+` opens a composer:
notes anchor to that line, render inline where a GitHub thread would, and are
kept per PR in your browser until you push them. A note on a removed line
anchors to the old file, so it lands on the left side of the GitHub diff where
the line still exists.

**Export.** Your notes and the threads that came back from GitHub leave together
as a single review (needs `GITHUB_TOKEN`); re-exports skip anything already
pushed, and pushed notes are marked *on github* instead of *not sent yet*.

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

The landing page carries a working miniature of the viewer: the lens switch
drives it, ribbons and edges answer hover with the same cards the app uses, and
it cycles through the three lenses until you touch it.

## Development

```sh
npx tsc              # build
npx tsc --watch      # rebuild on change
npm test             # pipeline units, dataset invariants, and the viewer in jsdom
npm run check        # type-check, then the tests
```

[ARCHITECTURE.md](ARCHITECTURE.md) walks the four pipeline stages and the
viewer's modules.

Knobs: `STRATA_SWEEP_GAP_HOURS` (default 2) controls when a burst of commits
becomes a new sweep; `STRATA_FETCH_DEPTH` overrides the shallow-fetch depth
when a PR window needs more ancestors.

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules,
the main one being: every signal on screen must be computable and traceable
to a commit. MIT licensed.
