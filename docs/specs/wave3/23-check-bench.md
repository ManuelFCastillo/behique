---
part: check-bench
owns:
  - src/release/check-bench.mjs
  - src/release/check-bench.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/check-app.mjs
  - src/release/confirm.mjs
  - src/release/compare.mjs
  - src/release/findings.mjs
test: node --test src/release/check-bench.test.mjs
allow: []
---
# Part 23: run a full release check on many apps and keep one table of what happened

`check-app.mjs` crawls one app at its good version, then compares good and candidate along the crawled steps (`confirm.mjs`). This part is the logic to run that for a list of apps, one after the other,
read each run's output lines into plain data, and print one table. Pure logic: the runner that starts `node` and the cleanup are INJECTED, so every test is offline with fakes. No long dash character anywhere.

## The result shape (other parts rely on it)
```
{ app, good, cand, outcome, caseId, crawl, facts, controlDifferences, candidateDifferences, findings, confirmed, total, error, seconds }
```
- `outcome`: `build_failed`, `crawl_failed`, `no_steps`, `no_change`, `confirmed`, `not_confirmed`, `timeout`, `error`.
- `caseId`: the id after `evidence: ` or `null`. `crawl`: `{ states, flows, steps, stoppedBy, seconds }` or `null`. `facts`: `{ stable, volatile }` or `null`.
- `controlDifferences`, `candidateDifferences`: integers or `null`. `findings`: `[{ id, verdict }]`. `confirmed`, `total`: integers (0 when none). `error`: first line of the reason or `null`. `seconds`: wall time of the run, a number.

## `check-bench.mjs` must export

### `parseCheckOutput(lines) -> partial result`
`lines` is the array of output lines of ONE `check-app.mjs` run (it prints the crawl lines, then the confirm lines). Read these exact line shapes (each may be missing; the last match wins when repeated):
- `evidence: <id>` gives `caseId`.
- `<n> page states, <m> flows, <k> steps (stopped: <why>, <s> s)` gives `crawl` `{ states: n, flows: m, steps: k, stoppedBy: why, seconds: s }`.
- `the crawl failed: <msg>` gives `outcome: 'crawl_failed'`, `error: msg`. `the crawl did not produce any steps, so there is nothing to compare` gives `outcome: 'no_steps'`.
- `a build failed to start, so the versions could not be compared: <msg>` gives `outcome: 'build_failed'`, `error: msg`.
- `facts: <a> stable, <b> volatile (` gives `facts` `{ stable: a, volatile: b }`.
- `control (<ref> a third time): <n> differences` gives `controlDifferences: n`. `candidate (<ref>): <n> differences` gives `candidateDifferences: n`.
- A finding verdict line is `<id>: <ref> (good) passed <p>/<r>, <ref> (candidate) failed <f>/<r>: <verdict>` where `<verdict>` is one of `confirmed`, `fails_both`, `not_reproduced`, `unstable`, `error`: add `{ id, verdict }` to `findings` (the id is the text before the first `: `, at most 40 characters of letters, digits, `-`, `_`, `.`).
- `<c> of <n> findings confirmed` gives `confirmed: c`, `total: n`. When no such line exists, `total` is the number of finding lines and `confirmed` the number with verdict `confirmed`.
- `no changed facts between the builds` or `none of the changed facts can be written as a test` or a line starting `no value changed` gives `outcome: 'no_change'`.
- The line `CONFIRMED: ` gives `outcome: 'confirmed'`; a line starting `NOT CONFIRMED` gives `outcome: 'not_confirmed'`.
Outcome precedence when several apply: `build_failed`, `crawl_failed`, `no_steps`, then `confirmed`, `not_confirmed`, `no_change`. When nothing matched and `findings` is empty the outcome is `error` with `error: 'No result line found.'`.
Missing numbers are `null` (counts of findings are `0`). Lines are matched after trimming; non-strings are ignored. Never throws.

### `runOne({ app, good, cand, runner, bisect = false, timeoutMs = 1_200_000, now = Date.now, env = {} }) -> Promise<result>`
Calls `runner(argv, { timeoutMs, env })` once, where `argv = ['src/release/check-app.mjs', app, good, cand]` plus `'--bisect'` when `bisect`. `runner` resolves `{ code, lines, timedOut }`. Builds the result from `parseCheckOutput(lines)`, plus `app`, `good`, `cand`, `seconds` (from `now`, one decimal).
`timedOut` gives `outcome: 'timeout'` and `error: 'Timed out after <n> minutes.'`. A rejected runner gives `outcome: 'error'` and `error` the first line of the message. A nonzero `code` with no parsed outcome gives `error`. Never throws.
App and refs are validated first: `app` matches `^[a-z0-9-]+$`, each ref `^[A-Za-z0-9._/-]{1,100}$` and does not start with `-`; otherwise the result is `outcome: 'error'` with `error: 'Invalid app or version name.'` and the runner is not called.

### `runAll({ jobs, runner, cleanup, onResult, ...options }) -> Promise<result[]>`
`jobs` is `[{ app, good, cand }]`. Runs them one at a time, in order. After EVERY job (also after a failed or timed out one) calls `cleanup()` (async, may throw: swallow) so a crashed run cannot leave a sandbox behind. Calls `onResult(result, index)` after each job (errors from it are swallowed). Returns all results. An empty list returns `[]`.

### `renderTable(results) -> string`
A markdown table with the columns `App`, `Versions`, `Outcome`, `Crawl (states/steps)`, `Control diffs`, `Candidate diffs`, `Findings (confirmed/total)`, `Seconds`, `Note`. `Versions` is `<good> to <cand>`, `Crawl` is `<states>/<steps>` or `-`, missing numbers are `-`, `Note` is the `error` text cut at 80 characters (pipe characters replaced by `/`). After the table one line: `<n> apps: <count> confirmed, <count> no_change, <count> not_confirmed, <count> failed` where failed counts `build_failed`, `crawl_failed`, `no_steps`, `timeout`, `error`. No long dash character.

## Tests (offline, fakes only)
`parseCheckOutput` on realistic full outputs for: a confirmed run (crawl line, facts, control, candidate, two finding lines, the summary line, `CONFIRMED`), a no-change run, a build failure, a crawl failure, a run with no steps, a run with one `fails_both` and one `confirmed` finding, junk lines and non-string entries, repeated lines where the last wins. `runOne`: argv exactly as given with and without bisect, invalid names refused without calling the runner, timeout, rejected runner, nonzero code with no result. `runAll`: order, cleanup after each job including failures and when cleanup throws, `onResult` called with the index and errors swallowed, empty input. `renderTable`: columns, dash for missing values, pipe replaced, the totals line.
