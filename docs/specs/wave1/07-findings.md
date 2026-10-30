---
part: findings
owns:
  - src/release/findings.mjs
  - src/release/findings.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/confirm.mjs
  - src/release/facts.mjs
  - src/export.mjs
test: node --test src/release/findings.test.mjs
allow: []
---
# Part 7: more than one finding per run

Today `confirm.mjs` turns only the FIRST changed fact between two builds into a test, so a release with several regressions shows one.
This part holds the pure logic for turning ALL changed facts into findings and judging each one. It has no browser, no build and no I/O,
so everything is tested offline. A person will wire it into `confirm.mjs` afterwards: do NOT edit `confirm.mjs`, and do not import it
(it runs a whole check when imported).

## `findings.mjs` must export

### `factToFinding(d, actions, start, baseline, id = 'R1')`
Move the existing function of the same name out of `confirm.mjs` and add the `id` parameter (it replaces the hard-coded `'R1'`). Everything else
must behave exactly as it does today for both kinds of fact: a `window@scrollY` fact becomes a relative `scroll_delta` finding (or `null` when the
earlier value is not a number or `d.i < 1`), and every other fact becomes an `attr` or `text` finding with an `xpath=/html/...` selector. Read the
current code in `confirm.mjs` and copy the logic and the wording of `title`, `expected` and `actual` word for word.

### `selectFindings(changed, actions, start, baseline, { max = 5 } = {}) -> { findings, skipped }`
`changed` is the ranked list of facts with `kind: 'changed'` (shape `{ i, step, key, kind, was, now }`, see `facts.mjs`); ignore any other kind.
- A fact that changes at one step usually stays changed at every later step (it is carried over). Keep only the EARLIEST step (smallest `i`)
  for each `key`. Every later entry for that key goes to `skipped` with `why: 'carried over from step <i>'`.
- Turn the kept facts into findings in the given order with `factToFinding`, giving ids `R1`, `R2`, ... in the order they are kept. A fact that
  returns `null` goes to `skipped` with `why: 'cannot be written as a test'` and does NOT use up an id.
- Keep at most `max` findings; the rest go to `skipped` with `why: 'over the limit of <max> findings'`.
- `skipped` entries look like `{ key, i, why }`. Never throw on odd input (empty list gives `{ findings: [], skipped: [] }`).
- Each finding also gets `fact: { key, i, was, now }` so a report can say which fact it came from (the exporter ignores extra fields).

### `judgeFindings(findings, goodRuns, candRuns) -> [{ id, verdict, goodPassed, candFailed, runs }]`
`goodRuns` and `candRuns` are arrays with one entry per run, each exactly what `runExported` returns: `{ results: { R1: true, R2: false }, errors?, error? }`
(`true` = the test passed; `error` = the whole run failed, `results` is empty). For each finding, over the runs of each version:
- `error`: any run of either version has an `error`, or has no boolean for this id.
- `confirmed`: passed in EVERY good run and failed in EVERY candidate run.
- `fails_both`: failed in every good run (so it is not a difference between the versions).
- `not_reproduced`: passed in every run of both versions.
- `unstable`: anything else (mixed results).
`goodPassed` and `candFailed` are counts, `runs` is the number of runs of the candidate. Check `error` first, then the others in the order above.

### `firstConfirmed(judged) -> verdict | null`
The first entry with verdict `confirmed`, or `null`. (Bisecting is slow, so only one finding is bisected.)

### `summarize(judged, skipped) -> string`
One plain sentence for a log line, for example `2 of 3 findings confirmed (R1, R3); 1 unstable (R2); 4 facts carried over from an earlier step`.
Leave out parts that are zero. No long dash character.

## Tests (offline)

Build facts by hand (no browser). Cover:
- `factToFinding` for an attribute fact (selector is `xpath=/html/` plus the path before `@`, `assert.kind` is `attr`), for a `#text` fact, for a value of 300 or more
  characters (`op: 'contains'`), for a scroll fact with a numeric earlier value (relative `scroll_delta`, value equals the old version's scroll change), and for a scroll fact
  at `i = 0` (returns `null`). `id` defaults to `R1` and can be set.
- `selectFindings`: two different facts become `R1` and `R2`; the same key at steps 1, 2 and 3 yields ONE finding at step 1 and two `skipped` carried-over entries; an
  untestable fact is skipped without using an id; `max` is honoured and the overflow is listed; `added`/`removed`/`moved` facts are ignored; empty input.
- `judgeFindings`: one case for each verdict, including a run with `error`, a missing id, and the order of checks.
- `firstConfirmed` and `summarize` with several mixes.
