---
part: external-runs
owns:
  - src/release/ui/external-runs.mjs
  - src/release/ui/external-runs.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/evidence.mjs
test: node --test src/release/ui/external-runs.test.mjs
allow: []
---
# Part 27: show checks that were started outside the dashboard

The dashboard starts a check as a child process and shows its progress in the Runs view. A check started from a terminal (`node bin/behique.mjs check ...` or `check-app.mjs`) writes the same evidence case under `out/evidence/<caseId>/`, event by event, but the dashboard does not know it exists until it is closed and appears in Reports. This part reads the evidence cases that are still open and turns them into run rows with a phase and a progress figure, derived only from the events already written. Pure: the file access is injected.

## Event types the pipeline writes, in order (data for the phase table)

`case.opened` (data: `goodRef`, `candRef`, `adapter`, `app`), then `artifact` and `claim` events throughout (they carry no phase), `builds.compared`, `masking.summary`, `test.exported` (one per finding), `test.run` (one per test run, may be absent), `test.judged` (one per finding), `shots.recorded` or `shots.failed` (one per step), `bisect.started`, `bisect.step`, `bisect.done` (only with a bisect), `case.closed` (data: `outcome`), and possibly `decision` after the close. Timestamps are the `ts` field (ISO 8601).

## `external-runs.mjs` must export

### `PHASES`
An object from event type to `{ phase, pct }`: `case.opened` ("recording the good version", 5), `builds.compared` ("comparing the versions", 35), `masking.summary` ("comparing the versions", 35), `test.exported` ("writing tests", 45), `test.run` ("running tests", 60), `test.judged` ("running tests", 65), `shots.recorded` ("taking screenshots", 80), `shots.failed` ("taking screenshots", 80), `bisect.started` ("bisecting", 85), `bisect.step` ("bisecting", 90), `bisect.done` ("bisecting", 95), `case.closed` ("done", 100), `decision` ("done", 100).

### `phaseOf(events) -> { phase, pct, lastType, lastAt, done, text }`
Looks at the last event whose type is in `PHASES` (events of other types are skipped). `done` is true when a `case.closed` event exists anywhere. `text` is the phase with a detail when one is cheap: for `test.exported` and `test.judged`, `writing tests (n so far)` and `running tests (n of m judged)` where `m` is the number of `test.exported` events; for `bisect.step`, `bisecting (step n)` counting `bisect.step` events; for `case.closed`, `done: <outcome>`. No events, or none in the table, gives `{ phase: 'starting', pct: 0, lastType: null, lastAt: null, done: false, text: 'starting' }`. `lastAt` is the `ts` of the last event of any type (the record's newest line), as an ISO string.

### `externalRuns({ cases, started = new Set(), now = Date.now(), staleMs = 30 * 60 * 1000 }) -> runs`
`cases` is an array of `{ id, events }`. Returns, newest first by the `ts` of their `case.opened`, one row per case that is NOT in `started` (the ids of runs the server itself started) and NOT done: `{ caseId, app, goodRef, candRef, startedAt, lastAt, phase, pct, text, stale, external: true }`. `app` is `case.opened` data `app`, else `adapter`, else `'unknown'`. `stale` is true when `now - Date.parse(lastAt) > staleMs`; then `text` becomes `<text>; no new events for <m> minutes, it may have been stopped` with `m` rounded down. A case with no `case.opened` event is skipped.

### `recentCases({ root, listCases, openCase, limit = 25 }) -> cases`
`listCases(root)` returns case ids (folder names) and `openCase(dir)` a case with `read()`; the ids start with a UTC timestamp, so the newest `limit` ids in reverse lexical order are read, and each becomes `{ id, events: openCase(join(root, id)).read() }`. A case whose folder cannot be read is skipped (never throws). This is the only function that touches collaborators; it takes them as arguments.

## Tests (offline)

Build cases in temp folders with `openCase` from `evidence.mjs` and cover: `phaseOf` for an empty case, for each phase in the table (including the counted texts), for a closed case with its outcome, and that `artifact` and `claim` events are skipped; `externalRuns` excludes started ids and closed cases, orders newest first, reads the app from `app` then `adapter`, marks a stale run with the minutes, and skips a case without `case.opened`; `recentCases` takes the newest `limit` ids, skips an unreadable folder, and returns their events.
