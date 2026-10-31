---
part: crawl-summary
owns:
  - src/release/crawl/summary.mjs
  - src/release/crawl/summary.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/crawl/run.mjs
  - src/release/crawl/plan.mjs
  - src/release/crawl/cli.mjs
test: node --test src/release/crawl/summary.test.mjs
allow: []
---
# Part 24: how good was a crawl? Numbers and a plain verdict from a saved crawl

The crawler (`crawl/cli.mjs`) writes `<app>-<sha12>.crawl.json`. To say whether the crawler did well on an app (not just whether it ran), this part reads that file's data and returns coverage numbers
and a plain verdict. Pure functions on plain data: no file, no process, no network. No long dash character anywhere.

## The input
A crawl record: `{ app, ref, sha, options, stoppedBy, ms, stats, states, flows, steps }` where `stats = { tried, states, seenAgain, failed, queued }` (numbers), `states = [{ url, title, path }]` (`path` is the list of control labels clicked from the landing page, `[]` for the landing page),
`flows` is a list of label lists, `steps` is a list of `{ type: 'click' | 'goto' | ..., label?, selector?, path? }`. Any field may be missing or of the wrong type: treat it as empty.

## `summary.mjs` must export

### `summarizeCrawl(crawl) -> summary`
```
{ app, ref, states, distinctUrls, distinctTitles, distinctStates, maxDepth, meanDepth, flows, steps, clicks, tried, failed, failedRatio, seenAgain, stoppedBy, seconds, quality, reasons }
```
- `states`: `states.length`. `distinctUrls`: number of distinct URLs after removing the origin (keep path and query). `distinctTitles`: number of distinct non-empty titles. `distinctStates`: number of distinct `url + '|' + title` pairs.
- `maxDepth`, `meanDepth` (one decimal): from `path.length` of each state (`0` for none).
- `flows`: `flows.length`. `steps`: `steps.length`. `clicks`: steps whose `type` is `click`.
- `tried`, `failed`, `seenAgain` from `stats`; `failedRatio` is `failed / tried` to two decimals, `0` when `tried` is 0. `stoppedBy` from the record (`'unknown'` when missing); `seconds` is `ms / 1000` to one decimal.
- `quality` is one of `good`, `thin`, `degenerate`, `failed`, decided in this order, with `reasons` a list of plain sentences for every rule that fired (also the ones that did not decide):
  1. `steps` is 0: `failed`, reason `The crawl produced no steps.`
  2. `states` is 1 or less: `degenerate`, reason `Only the landing page was found.`
  3. `failedRatio` above 0.3: `thin`, reason `More than 30 percent of the tries failed.`
  4. `states` above 5 and `distinctTitles` / `states` below 0.2 AND `distinctUrls` below 3: `thin`, reason `Most pages look the same (few titles and few addresses).`
  5. `flows` is 1 or less: `thin`, reason `Only one click path was found.`
  6. otherwise `good`.
  Extra reasons that do not change the quality: `Stopped at the path limit; more pages may exist.` when `stoppedBy` is `paths`; `Stopped at the time budget; more pages may exist.` when it is `budget`.
Never throws; a non-object input gives the all-zero summary with quality `failed` and the reason `No crawl data.`

### `renderSummary(summary) -> string[]`
Plain lines for a person: `<app> <ref>: <quality>`, `pages: <states> (<distinctStates> distinct, <distinctTitles> titles), depth max <maxDepth> mean <meanDepth>`, `click paths: <flows>, steps: <steps> (<clicks> clicks)`, `tries: <tried>, failed <failed> (<failedRatio>), already seen <seenAgain>`, `stopped by: <stoppedBy> after <seconds> s`, then one line `note: <reason>` per reason.

### `compareSummaries(a, b) -> { better, same, notes }`
`a` and `b` are summaries. `better` is `'a'`, `'b'` or `null`: rank by quality (`good` 3, `thin` 2, `degenerate` 1, `failed` 0), then by `distinctStates`, then by `flows`; `null` when all are equal. `same` is true when all three are equal. `notes` is a list of sentences naming what differs (`quality`, `distinctStates`, `flows`).

## Tests (offline)
Build small crawl records by hand. Cover: each quality rule on its own and the order when several apply, the extra reasons for `paths` and `budget`, depth numbers, distinct counts with the origin removed and with empty titles, `failedRatio` with 0 tried, missing and wrong-typed fields, non-object input, `renderSummary` lines, `compareSummaries` by quality, by distinct states, by flows and all equal.
