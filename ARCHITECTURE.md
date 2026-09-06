# Architecture

Strata is two halves: a **pipeline** that turns a pull request into one JSON
document, and a **viewer** that reads only that document. They never run at the
same time and never share memory — if a claim is on screen, it is in the JSON,
and if it is in the JSON, some pipeline stage computed it from git or the AST.

```
 GitHub / a local clone
          │
          ▼
  pipeline/  ──────────────────────────────────►  data/<pr>.json
   git.ts      the PR's shape: commits, per-commit diffs, whole-PR diff
   index.ts    TypeScript AST over base and head; defs, uses, import resolution
   flow.ts     seeds from the diff, flood fill over def−use edges, components
   sweeps.ts   commit bursts → the four time bands
   emit.ts     per-line attribution, per-object slices, threads → PageData
   run.ts      stage runner
                                                          │
                                                          ▼
                                                     src/ (the viewer)
```

## The pipeline

Every stage is deterministic and takes the previous stage's output. `run.ts`
sequences them; `scripts/analyze.mjs` fetches a PR first, and
`scripts/serve.mjs` exposes both over HTTP so the viewer can trigger an
analysis.

The two rules the pipeline holds to:

- **Nothing is guessed.** Components come from the AST, ribbons from `git blame`
  for additions and per-commit diffs for deletions, staleness from timestamps.
- **A symbol owns only its own lines.** `emit.ts` slices a file's diff to each
  definition's span — its declaration, body and attached doc comment, clamped
  against the previous definition — so no two objects show the same lines, and
  changes that belong to no symbol (imports, top-level statements, test bodies)
  stay unowned and are shown as such.

## The viewer

No framework, no build step beyond `tsc`. Modules, smallest first:

| file | what it owns |
| --- | --- |
| `src/dom.ts` | `el`, `svgEl`, month names — markup helpers with no state |
| `src/format.ts` | timestamps, deltas, avatar tints — pure presentation |
| `src/hovercard.ts` | the single floating card every hover surface shares |
| `src/chrome.ts` | the theme switch and the "paste a PR url" control |
| `src/home.ts` | the landing page |
| `src/demo.ts` | the landing page's working replica of the viewer |
| `src/graph.ts` | the dependency graph: edge semantics, layout, story replay |
| `src/render.ts` | the three lenses, the diff, notes, review state, export |
| `src/types.ts` | the shape of `data/<pr>.json` — the contract between halves |

`render.ts` is still the largest file: it holds the three lenses, and they share
the selection, review and note state that makes a session a session. `graph.ts`
and `render.ts` import each other on purpose — every crossing happens at call
time, never while the modules are evaluating — and that pattern is how the next
lens would be split out if it earns its own file.

## Tests

```sh
npm test          # unit + render tests
npm run check     # tsc --noEmit, then the tests
```

- `tests/pipeline.test.mjs` — pure functions (diff parsing, sweeps, what counts
  as a change) plus invariants the bundled dataset must satisfy: no two objects
  claim a line, every changed line names its commit, every edge carries a call
  site.
- `tests/render.test.mjs` — the viewer in jsdom, run as one ordered session:
  open an object, write a note on an added and a removed line, export it, mark
  the PR reviewed, simulate a push, watch only the touched objects come back to
  unread.

The render tests share one document deliberately. A reviewer's session is
stateful, and the bugs worth catching live in the sequence rather than in any
single render.
