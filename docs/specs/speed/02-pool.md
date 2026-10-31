---
part: pool
owns:
  - src/release/pool.mjs
  - src/release/pool.test.mjs
context:
  - docs/speed-plan.md
  - src/release/confirm.mjs
  - src/release/timing.mjs
test: node --test src/release/pool.test.mjs
allow: []
---
# Part 2: a small pool so test runs and screenshots happen a few at a time

Read `docs/speed-plan.md` sections 2 and 3 (Phase 2). Today `confirm.mjs` runs every test run, every screenshot build and every bisect verify run strictly one after another, each on its own port (8300) and its own sandbox run. hardac2 has 24 cores. This part provides a pure pool: run N async jobs with at most `size` in flight, give each job a slot number (so it can pick a port and a label), keep the results in the order of the jobs, and never let one job's failure stop the others. The wiring into `confirm.mjs` is done by hand afterwards; this part writes only `pool.mjs` and its tests.

Pure and small. No process, no file, no network, no timers of its own except what tests inject. No long dash character anywhere. Style: short plain functions like `timing.mjs`.

## `pool.mjs` must export

### `runPool(jobs, worker, { size = 1, onDone } = {}) -> Promise<results[]>`
- `jobs` is an array of any values. `worker(job, slot, index)` is called for each, where `slot` is an integer from 0 to `size - 1` that no other job in flight has at the same moment, and `index` is the job's position. It returns a promise.
- At most `size` workers run at once. Jobs start in order; when one finishes, the next waiting job takes the freed slot. `size` below 1 or not an integer counts as 1; `size` above `jobs.length` is fine.
- `results[i]` is `{ ok: true, value }` or `{ ok: false, error }` (the error's message as a string, first line only, at most 300 characters) for job `i`. A worker that throws or rejects never rejects the pool. Results are in job order regardless of finish order.
- `onDone(result, index, slot)` if given is called as each job finishes (in finish order), so a caller can write an event or a log line as runs complete. An `onDone` that throws is ignored.
- Resolves when every job has finished. An empty `jobs` resolves to `[]` at once.

### `slotPort(basePort, slot) -> number`
`basePort + slot`. Refuse (return null) when the result is not an integer from 1024 to 65535.

### `poolSize({ setting, sandbox, perBuildMemoryMb, freeMemoryMb } = {}) -> number`
The number of builds to run at once:
- With no sandbox (`sandbox` falsy) the answer is always 1: host builds share fixed ports and a feed server, so they cannot overlap.
- With a sandbox: start from `setting` (an integer 1 to 8; anything else counts as 3), then if both `perBuildMemoryMb` and `freeMemoryMb` are positive numbers, cap it at `floor(freeMemoryMb / perBuildMemoryMb)`, never below 1.
- Always an integer from 1 to 8.

### `groupInOrder(results, keyOf) -> Map`
A small helper for the caller: groups `results[i]` by `keyOf(i)` keeping each group's order. Pure.

## Tests (`pool.test.mjs`, node:test, offline)
Use workers that resolve on injected promises or `setTimeout` with small delays (10 to 30 ms), and assert the in-flight count never passes `size`.
- 7 jobs, size 3: at most 3 in flight at any moment, all 7 results in job order, slots used are only 0, 1, 2 and two jobs in flight never share a slot.
- A worker that throws on job 2 gives `{ ok: false, error }` for job 2 and `{ ok: true }` for the others; the pool resolves.
- `onDone` is called 7 times, in finish order, with the right index; a throwing `onDone` does not break the pool.
- size 1 runs strictly in sequence (job 2 starts after job 1 ends); size 0 and size 2.5 behave as 1; size 50 with 3 jobs runs all 3 at once.
- Empty jobs resolves to `[]`.
- `slotPort(8300, 2)` is 8302; `slotPort(65535, 1)` is null.
- `poolSize`: no sandbox is 1 whatever else is passed; sandbox with setting 3 and 27000 MB free and 10240 per build is 2; setting 3 with 4096 per build and 27000 free is 3; setting 'x' is 3; setting 12 is 8; free 1000 with 4096 per build is 1.
- `groupInOrder` groups by key and keeps order.
