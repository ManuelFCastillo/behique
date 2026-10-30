# Onboarding an app so Behique can check it (overview)

Behique is a release-verification tool. Given two versions of an app it builds both, compares what a page shows, finds the
first commit that changes it (bisect), keeps the proof in an append-only evidence store, and a person decides ship or hold.
Today that only works for FreshRSS, because its adapter (install, seed, serve) was written by hand. This work lets Behique do
that setup itself for a new repo, starting with Music Blocks (a canvas app), and adds a bisect that works on pictures.

The rule that runs through all of it: **a model proposes, code verifies, a person approves.** A model may propose how to run
an app, but nothing it proposes is trusted until deterministic code has built the app, served it, taken a settled picture and
measured the noise. No command a model proposes runs until a person has approved it.

## The parts (each has its own spec in this folder, and its own directory or files)

| Part | Spec | Files |
|---|---|---|
| 1 App profile and runner | 01-profile-and-runner.md | `src/release/onboard/profile.mjs`, `static-server.mjs` |
| 2 Settled pictures | 02-picture.md | `src/release/visual/picture.mjs` |
| 3 Inspect a repo, propose a profile, and the skill file | 03-inspect-and-propose.md | `src/release/onboard/inspect.mjs`, `propose.mjs`, `docs/skills/onboard-app.md` |
| 4 Verify a profile and the onboard command | 04-verify-and-onboard.md | `src/release/onboard/verify.mjs`, `onboard.mjs` |
| 5 Visual bisect | 05-visual-bisect.md | `src/release/visual/visual-bisect.mjs` |
| 6 Check and evidence | 06-check-and-evidence.md | `src/release/visual/check.mjs`, `evidence.mjs` |

Each part is built on its own, in order, and has tests that need no network and no model.

## Conventions (follow the existing code)

- Node ESM, files end in `.mjs`, two-space indent, no semicolons, single quotes, no TypeScript, no build step.
- No new npm dependencies. Use `node:` built-ins, `playwright` and `pngjs` (already installed, used through `src/senses/pixels.mjs`).
- Comments are short and say WHY. A header comment at the top of each file says what it is for and how to run it.
- Tests use `node:test` and `node:assert/strict`, live next to the code as `<name>.test.mjs`, and run offline. A test that needs a
  browser may use headless Chromium through `playwright` against a local `http://127.0.0.1` server it starts itself. No test
  may use the internet, read `.env`, or write outside a temp directory (`mkdtempSync(join(tmpdir(), ...))`).
- Never write the long dash character (U+2014) anywhere, in code, comments, strings or docs. Use a colon, a comma or parentheses.
- Never read, print or write `.env`. Never write files other than the ones the spec lists as owned.
- Errors are thrown with a message a person can act on. Functions that can be tested without side effects take their
  collaborators as arguments (for example `startBuildFn`, `pictureFn`, `ask`) so tests can pass fakes.

## Existing interfaces you can rely on (do not change them)

### `src/release/build.mjs`: `startBuild({ adapter, ref, port })`
Checks out `ref` as a git worktree at `join(adapter.workRoot, 'w-' + sha12)`, runs `git clean -fdxq -- ...adapter.cleanPaths`
in it (**an empty `cleanPaths` would clean the whole worktree, so always give one harmless path that does not exist**),
then `await adapter.prepare(dir, { port, feedUrl })` which must return an object with `entries` (use `{ entries: 0 }`),
then spawns `adapter.serve(dir, port)` = `{ cmd, args }` with `cwd: dir`, and waits until `GET http://127.0.0.1:<port><basePath>/`
answers OK. `adapter.feed` may be `null` and `adapter.expectedEntries` may be undefined. Returns
`{ ref, sha, dir, base, port, entries, buildMs, stop }`; call `await build.stop()` when done. An adapter object has:
`name, repo (absolute path to a git clone), workRoot (absolute directory where worktrees go), cleanPaths, feed: null,
basePath ('' or '/i'), prepare(dir, ctx), serve(dir, port)`.

### `src/release/bisect.mjs`: `bisect({ adapter, goodRef, badRef, dir, id, port, runs, log, test, onEvent })`
Binary search over `git rev-list --reverse goodRef..badRef`. `test` is `async ({ adapter, ref, port, dir, id }) =>
({ verdict: 'good' | 'bad' | 'skip', why? })` and is called once per tested commit; `skip` means "says nothing, try a neighbour".
`log(line)` receives progress lines. `onEvent(type, data)` receives `started {changes}`, `step {...}`, `verifying {...}`.
The result is `{ conclusive, verified, commit, parent, subject, author, date, files, url, changes, steps, seconds }`, or
`{ conclusive: false, verified: false, range, changes, steps, seconds }`. `verified` means the parent passed `runs` times and the
first bad commit failed `runs` times. It removes the worktrees it created (those under `adapter.workRoot`).

### `src/senses/pixels.mjs` (all synchronous, PNGs are Buffers)
`decode(png)`, `encode(image)`, `blank(w,h,rgba)`, `paint(image, box, rgba)`, `scaleBox(box, k)`,
`diff(a, b, { tolerance, region, ignore }) -> { sizeMismatch, width, height, total, changed, ratio, bbox, inRegion }`
(boxes are `{ x, y, w, h }` in IMAGE pixels; `inRegion` is the changed count inside `region`),
`diffImage(a, b, opts) -> PNG Buffer`, `noiseFloor(shots, opts) -> { n, pairs, changed, ratio, tolerance }` (the largest difference
between any two pictures of the SAME state), `aboveFloor(diffResult, floor, { margin = 1.5, minPixels = 1 }) -> boolean`,
`emptiness(image, box)`. Pictures from a device scale factor 2 browser are twice as many pixels as CSS pixels: use `scaleBox`.

### `src/senses/hands.mjs`
`shot(page)` = viewport screenshot. `settle(page, { stableMs = 600, pollMs = 150, maxMs = 8000 }) -> { png, settled, ms }` waits
until the viewport stops changing. A real app under load needs a long settle after load (for example `stableMs: 1500, pollMs: 300,
maxMs: 40000`), and a fixed sleep is not good enough: measured noise was zero when idle and up to 598,000 pixels when pages were still
booting.

### `src/release/evidence.mjs`: `openCase(dir)`
Returns `{ event(type, data, by), artifact(name, content, mediaType) -> sha256, claim(label, text, { by, evidence, model, extra }), read(),
verify() }`. An append-only, hash-chained log plus content-addressed files. Claim labels and who may write them (enforced, it throws):
`verified_fact`, `reproduced_failure`, `statistical` (written by `code`); `suspected_cause` (`code` or `human`); `ai_hypothesis` (`model` only,
needs `model`). A `verified_fact`, `reproduced_failure` or `statistical` claim MUST cite evidence (artifact hashes returned by `artifact`).
See `src/senses/canvas-evidence.mjs` for a complete example of writing a case, including how claim text is worded. A case begins
with `event('case.opened', { goodRef, candRef, adapter, kind, steps, options: { bisect, runs }, scenario: { name, label, about, upstream: null } })`
and ends with `event('case.closed', { outcome })`, where `outcome` is `'regression proven'`, `'differences found'` or `'no candidate defects'`.
For a bisect, also write `event('bisect.started', { changes })`, `event('bisect.step', { step, sha, index, verdict, subject, goodThrough, badFrom, changes })` as
the search runs (use bisect's `onEvent`), and an artifact named exactly `bisect.json` containing `{ result, log }` (the bisect result and the log lines).

## The first real target: Music Blocks

- A git clone (partial, blobs fetched on demand) is at `/Users/mcastillo/dev/behique-apps/musicblocks`; tags `v3.6.2` to `v3.8.0`; `master` is 695 commits after `v3.8.0`.
  Worktrees go in `/Users/mcastillo/dev/behique-apps` (named `w-<sha12>` by `startBuild`).
- It is a static site (no install, no build). It is served as plain files. In the browser its own server answers `/env.js` with
  development mode; a plain file server must do the same: respond to `GET /env.js` with `window.MB_ENV="development";window.MB_IS_DEV=true;`.
- Page: viewport 1280x800 at device scale factor 2. After load it shows a welcome tour dialog, closed by one click at CSS pixel (220, 155).
  Loading takes 6 to 10 seconds in development mode, so wait with `settle` (long), not a sleep.
- Differences already measured between `v3.8.0` and `master`: the toolbar is redesigned, the tour dialog is restyled, and master has a dark
  strip about 7 CSS pixels wide at the far left and far right of the viewport. The workspace blocks are pixel-identical. Two loads of the
  same version differ by 0 pixels when idle.
- Music Blocks is open source and public, so its screenshots may go to a model. Never send screenshots of private apps.
