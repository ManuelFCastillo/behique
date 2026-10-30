---
part: check-and-evidence
owns:
  - src/release/visual/check.mjs
  - src/release/visual/check.test.mjs
  - src/release/visual/evidence.mjs
  - src/release/visual/evidence.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/evidence.mjs
  - src/senses/canvas-evidence.mjs
  - src/release/visual/picture.mjs
  - src/release/visual/visual-bisect.mjs
  - src/release/onboard/profile.mjs
test: node --test src/release/visual/check.test.mjs src/release/visual/evidence.test.mjs
allow: [external_network]
---
# Part 6: the visual check command and its evidence case

This is what a person runs: compare two versions of a profiled app by picture, optionally bisect the first difference, and keep the result in the evidence store so the existing report page shows it
(it already shows pictures cited by a claim, and a bisect result stored as `bisect.json`).

## `evidence.mjs` must export `recordVisualCase({ evidenceRoot, profile, goodRef, candRef, goodSha, candSha, reference, candidate, floor, reports, bisect = null, region = null, anchors = null, now = new Date() }) -> { caseId, outcome, ok }`

Inputs: `reference` and `candidate` are PNG Buffers; `floor` is the noise floor from `measureFloor`; `reports` is the array of `regionReport` results for every named region (all above or not);
`bisect` is the result of `visualBisect` (with `reference`, `pictures`, `reports`) or `null`; `anchors` the `anchorsOk` result.
Write a case with `openCase(join(evidenceRoot, caseId))` where `caseId` is `<UTC timestamp like 20261029T214131Z>_<profile.name>-<goodRef>-vs-<candRef>` with every character outside `[\w.-]` replaced by `_`. Events and claims, in order:
1. `event('case.opened', { goodRef, candRef, adapter: 'visual-' + profile.name, kind: 'visual', steps: [], options: { bisect: Boolean(bisect), runs: 3 }, scenario: { name: 'visual-' + profile.name, label: <app name> + ', by picture', about } })`.
   `about` must say, in plain words: this check compares settled pictures of the two versions region by region against the measured noise of the older one; a difference means the pictures differ, not that something is a bug, and a person decides.
2. Artifacts (`image/png` for pictures): `good-picture.png`, `candidate-picture.png`, and for every region that is above the floor a `diff-<region>.png` made with `diffImage` from `src/senses/pixels.mjs`; `floor.json` (application/json).
3. `statistical` claim (by code, cites `floor.json`): the noise floor: how many pixels two loads of `goodRef` differ by at most, over the whole picture and per region (`n` loads).
4. For each region above the floor, a `verified_fact` (by code, cites `good-picture.png`, `candidate-picture.png` and that region's diff): says the region name, how many pixels in the region differ between `goodRef` and `candRef`, and the floor for that region. These are observations, not failures.
   If `anchors` exists and failed, one `verified_fact` saying which anchor regions also differ (the app may be broken, not only changed).
5. If `bisect` is conclusive and verified: a `reproduced_failure` (by code) that cites `bisect.json` (artifact: `{ result, log }`, where `log` is the array of lines `bisect()` produced if available, else `[]`), `good-picture.png`, and artifacts `parent-picture.png` and `first-bad-picture.png` made from `bisect.pictures`.
   Its text names the region, the first commit (7 characters and the subject), and says the parent matched the good picture in `runs` of `runs` runs and the commit differed in `runs` of `runs` runs. A second `verified_fact` lists the files the commit touched (up to 6) and cites `bisect.json`.
   If the bisect is conclusive but not verified, a `suspected_cause` (by `code`) cites `bisect.json` and says the runs were not clean. If it is not conclusive, a `suspected_cause` says the first bad change is one of N (use `range`).
6. `event('case.closed', { outcome, bisected: Boolean(bisect) })` where `outcome` is `'regression proven'` if a `reproduced_failure` was written, else `'differences found'` if any region is above the floor, else `'no candidate defects'`. Return `ok: openCase(...).verify().ok`.
Do not write the long dash character in any claim text. Keep claim texts short, factual and in the style of `src/senses/canvas-evidence.mjs`.

## `check.mjs`

Header comment: `node src/release/visual/check.mjs <app> <goodRef> <candRef> [--region name] [--bisect] [--ports 8301,8302] [--runs 3] [--loads 3]`.
Export `runCheck(options, deps) -> Promise<{ code, lines, caseId, outcome }>` with `deps` (`loadProfile`, `profileToAdapter`, `startBuildFn`, `pictureFn`, `floorFn`, `visualBisectFn`, `recordVisualCase`, `evidenceRoot`, `now`) defaulting to the real modules (`loadProfile` and `profileToAdapter` from `../onboard/profile.mjs`, `evidenceRoot` the absolute path of `out/evidence` in the repo root).
The command line at the bottom parses `process.argv`, calls `runCheck`, prints `lines`, sets the exit code (0 when nothing differs or a difference was found and recorded, 1 on an error, 2 on usage). Steps:
1. Load the profile named `<app>` (usage error, code 2, if it is missing). Build `goodRef` and `candRef` (stop both, always), take a picture of each and measure the noise floor on `goodRef`; if a picture is not settled, stop with code 1 and say so.
2. `regionReport` every region in the profile (and run `anchorsOk` if the profile has anchors). Print one line per region: name, changed pixels in the region, the floor for it, above or not.
3. With `--bisect`: choose the region (`--region name`, or else the first region that is above the floor; if none is above the floor print that there is nothing to bisect and skip). Call `visualBisectFn`, passing a `log` that collects lines into `lines`. A thrown error from it is recorded in `lines` and gives code 1 (the case is still written without the bisect).
4. Call `recordVisualCase` and print the case id, the outcome, and the line `See it at /report?case=<caseId> on the demo server.`.
The shas for the case come from the builds (`goodSha`, `candSha`).

## Tests (offline, fakes only)

`evidence.test.mjs`: build synthetic pictures with `blank`, `paint`, `encode` from `src/senses/pixels.mjs` and call `recordVisualCase` into a temp directory. Check, by reading the case back with `openCase(...).read()` and `summarize` from `../evidence.mjs`: the claim labels and who wrote them (everything by `code`), that every `verified_fact` and `reproduced_failure` cites evidence that exists, the artifact names and media types,
`outcome` for the three situations (verified bisect, differences without bisect, nothing differs), the not-verified and not-conclusive bisect wording, that the record verifies (`ok` true), and that `bisect.json` parses and contains `result`. Also check that `buildViewModel` from `../viewmodel.mjs` accepts the case (it needs `case.opened` and `case.closed` as written) and gives verdict `hold` for the verified bisect, `inconclusive` for differences only, and `ship` for nothing differing.
`check.test.mjs`: with fake collaborators, check the usage error, the missing profile, that both builds are stopped when a picture does not settle, the per-region lines, that `--bisect` without a region above the floor skips the bisect, that a `visualBisectFn` error still records a case, and the exit codes.
