---
part: shots
owns:
  - src/release/shots.mjs
  - src/release/shots.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/facts.mjs
  - src/session.mjs
  - src/senses/pixels.mjs
  - src/senses/hands.mjs
  - src/senses/canvas-evidence.mjs
test: node --test src/release/shots.test.mjs
allow: [external_network]
---
# Part 9: screenshots as evidence in a release check

A release check records page FACTS (attributes, text, scroll position), but a person looking at a report also wants to see the page. This part takes
screenshots of a build at chosen steps of the recorded actions, compares the good version and the candidate, and writes the pictures and an honest
sentence into the evidence case. It must not claim more than the pictures show: for a change that lives in an attribute (a link's `data-url`, say) the
screenshots look identical, and the report must say exactly that.

## `shots.mjs` must export

### `captureShots(base, actions, steps, { viewport = { width: 1280, height: 900 }, settleOptions = {} } = {}) -> Promise<{ [step]: PNG Buffer }>`
Open `base` with `Session` from `src/session.mjs` (the same way `recordRun` in `facts.mjs` does: `new Session(base, { viewport })`, `await s.open()`, `await s.act(a)` per action,
`await s.close()` in `finally`). `steps` is a list of step numbers: `0` is the page right after opening, `n` is the page after the n-th action (1-based, so it matches the `i` of a fact).
After opening and after every action, wait with `settle` from `src/senses/hands.mjs` (pass `settleOptions`) and, once settled or timed out, keep that screenshot for the steps that were asked for. Use
the viewport screenshot that `settle` returns (`png`), not a full-page one. Do not take or keep pictures for steps that were not asked for. Throw if a step is outside `0..actions.length`.
Stop acting after the largest requested step (do not run the remaining actions).

### `compareShots(goodPng, candPng, { floorPng = null, minPixels = 4 } = {}) -> { changed, ratio, bbox, sizeMismatch, floor, above, diffPng }`
Use `diff`, `diffImage` and `aboveFloor` from `pixels.mjs`. `floorPng` is a SECOND picture of the good version taken the same way: `floor` is `diff(goodPng, floorPng).changed` (0 when absent) and
`above` is `aboveFloor({ changed }, { changed: floor }, { minPixels })`. A size mismatch is always `above: true`. `diffPng` is the `diffImage` of good versus candidate.

### `describeShots(c, { step, label, goodRef, candRef }) -> string`
Plain English, one or two sentences, no long dash character:
- not above the floor: `After step <step> (<label>) a screenshot of <candRef> looks the same as <goodRef> (<changed> pixels differ, <floor> from run to run noise). A change that does not show on screen, such as a link's address, cannot be seen in a picture.`
- above the floor: `After step <step> (<label>) a screenshot of <candRef> differs from <goodRef> by <changed> pixels (the same version differs from itself by <floor>), in the box x <x>, y <y>, <w> by <h>.` Use the bbox in image pixels.
- size mismatch: say the two screenshots have different sizes, so they cannot be compared pixel by pixel.

### `recordShots({ ev, step, label, goodRef, candRef, goodPng, candPng, floorPng }) -> { claimId?, above, hashes }`
`ev` is an evidence case from `openCase` (see the overview). Save three artifacts with `ev.artifact(name, buffer, 'image/png')`: `step<step>-<goodRef>-screenshot.png`, `step<step>-<candRef>-screenshot.png`, `step<step>-versions-diff.png`
(replace characters other than letters, digits, `.`, `_`, `-` in the refs with `_`). Then write ONE `verified_fact` claim with `ev.claim('verified_fact', describeShots(...), { evidence: [<the three hashes>] })`.
Never write `reproduced_failure` here: a picture that differs is a lead for a person, not a proof. Return what was written.

## Tests (offline)

- `compareShots` and `describeShots` with pictures made by `blank`, `paint`, `encode`: identical pictures, a difference under the floor, a difference over the floor (check the bbox sentence), a size mismatch.
- `captureShots` with a tiny local page: start an `http.createServer` on `127.0.0.1` (port 0) that serves a page with a button that turns a box from white to black when clicked
  (actions: `[{ type: 'click', selector: '#go' }]`; read `src/session.mjs` for the action format). Steps `[0, 1]` return two PNGs that differ, steps `[0]` returns only step 0, a step beyond the
  actions throws, and the browser is closed afterwards. Use `{ stableMs: 200, pollMs: 100, maxMs: 4000 }` as `settleOptions`.
- `recordShots` with a real `openCase` in a temporary directory: three artifacts and one `verified_fact` claim, `ev.verify().ok` is true, and the claim text matches `describeShots`.
