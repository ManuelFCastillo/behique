---
part: visual-bisect
owns:
  - src/release/visual/visual-bisect.mjs
  - src/release/visual/visual-bisect.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/bisect.mjs
  - src/release/build.mjs
  - src/release/visual/picture.mjs
test: node --test src/release/visual/visual-bisect.test.mjs
allow: [child_process]
---
# Part 5: bisect a visual difference

Finds the first commit at which a region of the app's picture stops matching what it looked like in the good version. It reuses the existing `bisect()` (see the overview) by giving it a `test` function
that builds a commit, takes a settled picture and judges one region. The new code is that judgement and the plumbing around it. Do NOT copy or change `bisect.mjs`.

## `visual-bisect.mjs` must export `visualBisect(options) -> Promise<result>`

Options: `{ adapter, profile, goodRef, badRef, region, port = 8300, runs = 3, loads = 3, log = () => {}, onEvent = () => {}, deps = {} }`.
`region` is the NAME of a region in `profile.regions` (throw a clear error if it does not exist). `deps` lets tests replace collaborators; the defaults are:
`startBuildFn` (`startBuild` from `../build.mjs`), `pictureFn` (`pictureOf` from `./picture.mjs`), `floorFn` (`measureFloor`), `bisectFn` (`bisect` from `../bisect.mjs`).
Also use `regionReport` and `anchorsOk` from `./picture.mjs`, and `diffImage` from `../../senses/pixels.mjs`.

Steps:
1. **Reference.** Build `goodRef` (stop the build afterwards, also on failure), take its picture with `pictureFn(base, profile)` (throw if not `settled`), and measure the noise floor of `goodRef` with `floorFn(base, profile, { loads })` BEFORE stopping the build.
2. **Is there anything to find?** Build and picture `badRef`. Compute `regionReport(reference, picture, region, profile.regions[region], { floor, scale: profile.viewport.deviceScaleFactor })`. If the region is NOT above the floor, throw an error that says
   there is no difference in that region between the two versions beyond the noise, so there is nothing to bisect. Also run `anchorsOk`; if the anchors fail on `badRef`, throw an error saying the candidate looks broken, not changed in the region.
3. **Search.** Call `bisectFn({ adapter, goodRef, badRef, dir: <unused, pass an empty string>, id: region, port, runs, log, onEvent, test })` where `test` is
   `async ({ ref, port }) => verdict` implemented as follows. Build `ref` (a failed build is `{ verdict: 'skip', why: 'build failed: <first line>' }`; always stop it). Take the picture; if it did not settle, `skip` with `why: 'page did not settle'`.
   Run `anchorsOk`; if any anchor is above the floor, `skip` with `why: 'app looks broken (anchor <name> differs)'` (a commit that breaks the app says nothing about the region). Otherwise `regionReport` the region: above the floor is `bad`, otherwise `good`.
4. **Evidence pictures.** If the search is conclusive, build and picture the parent of the first bad commit and the first bad commit itself (use `result.parent` and `result.commit`), and return them.
Return `{ ...bisectResult, region, floor, reference: <png>, pictures: { parent: <png>, first: <png> } | null, reports: { parent: <regionReport>, first: <regionReport> } | null }`.
A conclusive and verified result means: the parent matched the reference `runs` times in a row, and the first bad commit differed `runs` times in a row (that is what `bisect()` already verifies using the same `test`).

## Tests (offline, no browser)

Create a real temporary git repository with `execFileSync('git', ...)`: 9 commits on `main` with tags `good` on the first and `bad` on the last. Fake `startBuildFn` returns `{ ref, sha, base: 'fake://' + ref, stop }` (record starts and stops);
use the real `git rev-parse` to map the ref to its index in the history. Fake `pictureFn(base)` returns a PNG made with `blank`, `paint` and `encode` from `src/senses/pixels.mjs`: for commits at or after index K a dark strip is painted inside the region `edge` (and the rest of the picture is identical);
fake `floorFn` returns `{ n: 3, changed: 0, regions: { edge: 0, work: 0 } }`. Use the real `bisect` (`adapter.repo` is the temp repo, `adapter.workRoot` a temp directory; no worktrees are created because the build is faked). Check:
- it finds exactly commit K, `conclusive` and `verified` are true, and `pictures.first` differs from `pictures.parent` inside the region while `pictures.parent` matches the reference;
- the number of tested commits is about log2 of the history plus the verification runs, not all of them;
- a commit whose picture breaks an anchor (paint over the `work` anchor region) is skipped and the search still finds the right commit using a neighbour (index K is not the broken one);
- a failing `startBuildFn` for one commit is skipped the same way;
- no difference between good and bad in the region throws the "nothing to bisect" error; a broken candidate throws the other error; an unknown region name throws;
- every build the fakes started was stopped (equal counts), also when an error was thrown.
