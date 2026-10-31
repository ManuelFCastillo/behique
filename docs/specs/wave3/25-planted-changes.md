---
part: planted-changes
owns:
  - src/release/planted.mjs
  - src/release/planted.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/facts.mjs
  - src/release/crawl/enumerate.mjs
test: node --test src/release/planted.test.mjs
allow: []
---
# Part 25: a small app with known changes planted in it, and a scorer, to measure whether a release check finds what is really different

Real version pairs of third-party apps have no ground truth: a difference found may or may not be "a bug". This part gives a ground truth. It builds a small multi-page static site (as plain text files), a catalog of single known
changes (each applied to the base alone), a comment-only no-op change, and a scorer that turns release check results into a detection rate. Pure functions on plain data: no file, no process, no network, no randomness. No long dash character anywhere.

## `planted.mjs` must export

### `buildBaseApp() -> { files }`
`files` maps a path to its text. Exactly these files, all valid HTML5 with `<html lang="en">`, no external requests (no CDN, no fonts, no images from other hosts), no `Math.random` and no dates, so two loads look the same:
- `index.html`: title `Planted Home`. A heading `<h1>Planted Home</h1>`. A nav with links `<a href="/about.html" title="About this site">About</a>` and `<a href="/list.html">List</a>`. A counter: `<button id="count" data-step="1" aria-label="Increase the counter">Count: <span id="n">0</span></button>` and a `<button id="reset" type="button">Reset</button>`, with an inline script where clicking `count` adds the `data-step` value (as a number) to the number in `#n`, and clicking `reset` sets it to 0. A tab widget: two `<button role="tab" aria-selected="true">` and `aria-selected="false"` buttons `One` and `Two` and two panels `<div role="tabpanel">` with the texts `Panel one text` and `Panel two text`; clicking a tab sets its `aria-selected` to true, the other to false and shows only its panel (the other panel gets the `hidden` attribute). A `<details><summary>More info</summary><p>Hidden details text</p></details>`.
- `about.html`: title `About Planted`. A heading `<h1>About</h1>`, a paragraph `This is the about page.` and a link `<a href="/">Home</a>`.
- `list.html`: title `Planted List`. A heading `<h1>Planted list</h1>`, a link `<a href="/">Home</a>`, and `<ul>` with four items `<li data-id="item-1">First item</li>` to `<li data-id="item-4">Fourth item</li>`.
- `style.css`: a few rules including `body { background: #ffffff; }`, linked from every page.
Every page contains the HTML comment `<!-- build 1 -->` once.

### `MUTATIONS`
An array of exactly these entries `{ id, kind, file, find, replace, expectDetected, why }` where `find` occurs EXACTLY ONCE in that base file (a test proves it) and `replace` differs from `find`:
1. `data-attr` (kind `attribute`, `list.html`): `data-id="item-2"` to `data-id="item-2-changed"`. `expectDetected: true`.
2. `heading-text` (kind `text`, `list.html`): `<h1>Planted list</h1>` to `<h1>Planted list (new)</h1>`. true.
3. `link-title` (kind `attribute`, `index.html`): `title="About this site"` to `title="About us"`. true.
4. `remove-item` (kind `removal`, `list.html`): the whole line of item 3 (`<li data-id="item-3">Third item</li>`) replaced by an empty string. true.
5. `counter-step` (kind `behaviour`, `index.html`): `data-step="1"` to `data-step="2"`. true. (Visible only after the counter is clicked.)
6. `aria-label` (kind `attribute`, `index.html`): `aria-label="Increase the counter"` to `aria-label="Add one"`. true.
7. `reset-disabled` (kind `attribute`, `index.html`): `<button id="reset" type="button">` to `<button id="reset" type="button" disabled>`. true.
8. `panel-text` (kind `text`, `index.html`): `Panel two text` to `Panel two text (new)`. true. (Visible only after the second tab is clicked.)
9. `background` (kind `visual`, `style.css`): `background: #ffffff;` to `background: #f0f0f0;`. `expectDetected: false` (a change only a picture shows; facts cannot see it).
`why` is one plain sentence saying what is different.

### `applyMutation(files, id) -> { ok: true, files } | { ok: false, error }`
Returns a COPY of `files` with the one mutation applied (never mutates the input). Errors (as plain sentences): unknown id; the file is missing; `find` does not occur exactly once.

### `planHistory() -> [{ tag, message, files, mutation }]`
The ordered commits to make, each a COMPLETE file map: first `{ tag: 'base', message: 'Planted app: base', files: base, mutation: null }`; then for each mutation in order `{ tag: 'm-' + id, message: 'Planted change: ' + id, files: base with only that mutation, mutation: id }`; last `{ tag: 'noop', message: 'Planted app: comment only', files: base with every `<!-- build 1 -->` replaced by `<!-- build 2 -->`, mutation: null }`. Changes are never cumulative: each candidate differs from base by exactly one change.

### `scorePlanted(results) -> score`
`results` is a list of check results `{ tag, outcome, candidateDifferences, controlDifferences, confirmed, total }` where `tag` is the candidate tag (`m-<id>` or `noop`) and `outcome` is one of `build_failed`, `crawl_failed`, `no_steps`, `no_change`, `confirmed`, `not_confirmed`, `timeout`, `error`. For each result decide a row `{ tag, id, kind, expectDetected, status, detected, confirmedAsTest }`:
- `status` `error` when the outcome is `build_failed`, `crawl_failed`, `no_steps`, `timeout` or `error` (these rows are excluded from the rates and counted in `errors`).
- `status` `inconclusive` when `controlDifferences` is above 0 (the control run differed, so a difference proves nothing; excluded from the rates, counted in `inconclusive`).
- otherwise `detected` is true when `candidateDifferences` is above 0; `confirmedAsTest` is true when `confirmed` is above 0; `status` is `found` when detected, else `missed`.
- A tag that is not `noop` and not a known mutation tag is ignored. A mutation with no result is `status: 'not_run'` (counted in `notRun`).
Return `{ rows, detectionRate, confirmRate, falsePositives, blindSpotsConfirmed, errors, inconclusive, notRun, lines }` where `detectionRate` is `found / (found + missed)` over rows whose `expectDetected` is true and status is `found` or `missed` (a number from 0 to 1 to two decimals, `null` when none); `confirmRate` is `confirmedAsTest` rows over those same rows (same rounding); `falsePositives` is 1 when the `noop` row has status `found` else 0 (`null` when the noop did not run or was an error or inconclusive); `blindSpotsConfirmed` is the number of `expectDetected: false` rows with `detected` true (a visual change that facts reported anyway, worth knowing).
`lines` is plain text for a person: one line per row `<tag>: <status> (<kind>)` followed by ` detected` / ` confirmed as a test` / ` expected to be invisible to facts` where they apply, then `detection rate: <n>%`, `confirmed as a test: <n>%`, `false positive on the comment-only change: yes|no|not measured`, and `errors: <n>, inconclusive: <n>, not run: <n>`.

## Tests (offline)
`buildBaseApp`: the exact file list, every page has the comment once, titles, no `http://` or `https://` URL in any file (no external requests), deterministic (two calls deep equal). `MUTATIONS`: nine entries with unique ids; every `find` occurs exactly once in its base file and differs from `replace`; `applyMutation` on each gives a copy where only that file changed and the input is untouched; unknown id, missing file and a `find` that is not unique give the errors. `planHistory`: 11 entries in order, tags, each candidate differs from base in exactly one file (the noop in every html file), none is cumulative. `scorePlanted`: all found, some missed, an error row, an inconclusive row, a mutation not run, the noop found (false positive 1), the noop missing (null), the background row detected (blind spot) and missed, rates rounded to two decimals, `null` rates when nothing ran, unknown tags ignored, `lines` content.
