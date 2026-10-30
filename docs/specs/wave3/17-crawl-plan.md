---
part: crawl-plan
owns:
  - src/release/crawl/plan.mjs
  - src/release/crawl/plan.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
test: node --test src/release/crawl/plan.test.mjs
allow: []
---
# Part 17: the crawl planner

The crawl explores an app breadth first: load the page, list what can be clicked, click each thing in a fresh page, see whether that reached a state not seen before, and keep going a couple of levels deep.
This part is the bookkeeping for that, as a pure state machine with no browser: which path to try next, what to do with the state it reached, and how to turn the useful paths into a list of steps the release check can replay.
A path is an array of actions (`{ type: 'click', selector }`, each also carrying a `label`), starting from a freshly loaded start page. No file, network or process access, so every test is offline.

## `plan.mjs` must export

### `createPlanner({ maxDepth = 2, maxPaths = 40, maxPerPage = 12 } = {}) -> planner`
`planner` has these methods:

- `next() -> path | null`. Returns the next path to try, first in first out, starting with the empty path `[]` (the start page itself). Returns `null` when nothing is queued. Each path is returned at most once.
- `report(path, state) -> { isNew, queued }`. `state` is `{ key, url, title, candidates }` where `candidates` is the array `candidates(...)` returns (each `{ action, label, key, ... }`) and `key` is the `stateKey` of the page.
  If `state.key` was seen before, the state is not new: nothing is queued and `{ isNew: false, queued: 0 }` comes back. Otherwise record the state with its `path` and discovery order; and, while `path.length < maxDepth`, queue one new path per candidate in the given order:
  `[...path, { ...candidate.action, label: candidate.label }]`, skipping a candidate whose `key` already appears in `path` (never click the same thing twice in a row of one path) and never queueing more than `maxPaths` paths in total over the planner's life (counting the root path). Returns `{ isNew: true, queued: <how many were added> }`.
  A `state` without a string `key` is ignored (`{ isNew: false, queued: 0 }`).
- `failed(path)`. Records that replaying `path` failed (an element was missing, a timeout): it is counted and nothing else happens.
- `stats() -> { tried, states, seenAgain, failed, queued }`: `tried` is how many paths `next` handed out, `states` how many new states were recorded, `seenAgain` how many reports were not new, `failed` how many failures, `queued` how many paths are still waiting.
- `states() -> [{ key, url, title, path, order }]` in discovery order.
- `flows({ max = 8 } = {}) -> [{ path, state }]`. The paths worth replaying in a release check: for every recorded state except the start state (empty path), in discovery order, but at most one per distinct LAST action `key` (a menu item reachable by many paths counts once) and at most `max`. Prefer shallower paths: sort by `path.length` then discovery order before applying the limits.
- `toSteps(flows, { startPath = '/' } = {}) -> actions[]`. The flat action list the release check replays: for the first flow just its path's actions; before every later flow insert `{ type: 'goto', path: startPath }` (and never two `goto`s in a row). Each action keeps its `label`. The original arrays are never mutated. An empty list of flows gives `[]`.

## Tests (offline)

Drive the planner with a hand-built fake site: a map from path (as a string of labels) to a state, so a loop calls `next()`, looks up the state, calls `report`. Cover: the root path first and FIFO order; a repeated state key is not new and queues nothing; `maxDepth` stops queueing (depth 1 and 2); `maxPaths` is honoured across the whole run; a candidate already clicked in the path is skipped; `failed` and `stats`; `states()` order; `flows` (shallow first, one per last-action key, `max`, the start state excluded); `toSteps` (first flow has no leading goto, later flows do, no double goto, labels kept, no mutation, empty input); a state with no key is ignored; `next` never returns the same path twice; a full run on the fake site finishes and the numbers in `stats` add up.
