---
part: crawl-reuse
owns:
  - src/release/crawl/reuse.mjs
  - src/release/crawl/reuse.test.mjs
context:
  - docs/speed-plan.md
  - src/release/crawl/cli.mjs
  - src/release/check-app.mjs
  - src/release/crawl/summary.mjs
test: node --test src/release/crawl/reuse.test.mjs
allow: []
---
# Part 4: do not crawl the same good version twice

Read `docs/speed-plan.md` section 3, Phase 4. `check-app.mjs` crawls the good version on every check (85 to 120 s), even when the same commit was crawled with the same options an hour ago and its record sits in `out/crawl/<app>-<sha12>.crawl.json`. This part decides, on plain data, whether a saved crawl can be reused for a wanted crawl, and picks the best one. Reading the files and skipping the crawl step is wired by hand into `check-app.mjs` and `crawl/cli.mjs` afterwards; this part writes only `reuse.mjs` and its tests.

Pure functions on plain data: no file, no process, no network. Any field may be missing or of the wrong type: treat it as not matching. No long dash character anywhere. Style: `summary.mjs`.

## The input
A saved crawl record, as `crawl/cli.mjs` writes it: `{ app, ref, sha, options, stoppedBy, ms, stats, states, flows, steps }`. `options` is the object of crawl options the run used (for example `{ maxDepth: 2, maxPaths: 40, maxFlows: 20, budgetMs: 120000 }`; treat it as an arbitrary flat object of numbers, strings and booleans). `steps` is the list of recorded steps; `stats.failed` and `stats.tried` are numbers.

A want: `{ app, sha, options }` with the same meaning.

## `reuse.mjs` must export

### `crawlMatches(record, want) -> { ok: true } | { ok: false, why }`
True only when all hold: same `app` (string equality), same full `sha` (40 hex, string equality; a 12-character `sha` in `want` matches a record whose `sha` starts with it), same options (every key in `want.options` equals the record's value, and the record has no extra key with a different value; compare with `===` after treating missing as undefined), the record has at least one step, and the record is not `failed` by the summary's rule (`steps` non-empty is that rule, so only the step check is needed here). On a mismatch `why` says which, in plain words: `'different app'`, `'different commit'`, `'different crawl options (maxPaths)'` naming the first differing key in sorted order, `'the saved crawl has no steps'`.

### `pickCrawl(records, want) -> { record, index } | null`
Among the records that match, the one with the most `steps`; ties go to the later `index`. Null when none matches. Never throws.

### `reuseNote(record, { now = Date.now() } = {}) -> string`
One line for the console: `reusing the crawl of <app> <sha12> from <when> (<n> steps, <m> page states); pass --recrawl to crawl again`, where `<when>` is `record.savedAt` if present (an ISO string) rendered as `Xm ago`, `Xh ago` or `Xd ago` from `now`, else `'an earlier run'`. Pure.

### `crawlFileStem(app, sha) -> string | null`
`<app>-<sha12>` when `app` is `/^[a-z0-9-]{1,40}$/` and `sha` is at least 12 lowercase hex characters, else null. This is the stem `crawl/cli.mjs` uses, so the caller can look for the file directly.

### `optionsFromArgs(argv) -> object`
Parse the crawl options the same way `crawl/cli.mjs` reads them, so a want can be built from a command line: `--max-depth`, `--max-paths`, `--max-flows` (integers), `--budget` (seconds, stored as `budgetMs` in milliseconds), each only when present. Unknown flags are ignored. Returns `{}` for none. Look at `cli.mjs` to get the option names and defaults exactly right; use the record's own key names.

## Tests (`reuse.test.mjs`, node:test, offline)
- A record that matches in app, sha and options with steps returns ok; a 12-character sha in the want matches.
- Each mismatch gives the right `why`: different app, different commit, a differing option naming the key, an extra key in the record with a different value, no steps.
- Missing or junk fields (null record, record without options, steps not an array) never throw and do not match.
- `pickCrawl` picks the most steps, ties to the later index, null when none.
- `reuseNote` renders minutes, hours and days, and the fallback text.
- `crawlFileStem` and `optionsFromArgs` round-trip a command line.
