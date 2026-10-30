---
part: verify-and-onboard
owns:
  - src/release/onboard/verify.mjs
  - src/release/onboard/verify.test.mjs
  - src/release/onboard/onboard.mjs
  - src/release/onboard/onboard.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/onboard/profile.mjs
  - src/release/onboard/inspect.mjs
  - src/release/onboard/propose.mjs
  - src/release/visual/picture.mjs
  - src/release/build.mjs
test: node --test src/release/onboard/verify.test.mjs src/release/onboard/onboard.test.mjs
allow: [external_network]
---
# Part 4: verify a profile, and the onboard command

A proposed profile is a guess until code has shown it works. `verify.mjs` does that with real builds. `onboard.mjs` is the command that ties parts 1 to 4 together, and it will not run any command from a proposal
until a person has approved it.

## `verify.mjs` must export `verifyProfile(profile, { good, cand, startBuildFn = startBuild, pictureFn = pictureOf, floorFn = measureFloor, ports = [8301, 8302], loads = 3, log = () => {} })`

`startBuild` is from `../build.mjs`, `pictureOf` and `measureFloor` from `../visual/picture.mjs`, `profileToAdapter` from `./profile.mjs`. It resolves a report:
`{ ok, checks: [{ name, ok, detail }], floor }`, and it NEVER throws for a failed check (it records it). Always stop every build it started, also on failure. The checks, in this order, and each later check is skipped (not failed) if an earlier build check failed:
1. `builds the good version`: `startBuildFn({ adapter, ref: good, port: ports[0] })` returns a build whose `base` answers (the build runner already waits for that). Detail: the sha (first 12 characters) and build seconds.
2. `builds the candidate version`: the same for `cand` on `ports[1]`.
3. `pictures settle`: `pictureFn(base, profile)` for each version returns `settled: true`. Detail: the milliseconds each took.
4. `pictures are the same size`: the two pictures have the same width and height (read from the PNG header: width at byte 16 and height at byte 20, big endian).
5. `the app is alive`: neither picture is blank: more than 1% of the good picture's pixels differ from its most common colour (use `emptiness` from `src/senses/pixels.mjs` over the whole picture and require `< 0.99`).
6. `no blocked requests`: report, as detail, how many external requests were blocked on each version (this check passes either way; it informs).
7. `noise floor`: `floorFn(goodBase, profile, { loads })` returns the floor. Pass if it resolves (a page that never settles makes it throw: then fail with that message). Detail: the largest whole-picture difference between loads, in pixels.
`floor` in the report is that result or `null`. `ok` is true only if every check that ran passed.

## `onboard.mjs`

Header comment: `node src/release/onboard/onboard.mjs <repoPath> --name <app> --good <ref> --cand <ref> [--profile file.json] [--propose] [--dry-run] [--approve] [--max-cost 0.3] [--ports 8301,8302]`.
Export `runOnboard(options, deps) -> Promise<{ code, lines, profile, report }>` where `options` are the parsed flags and `deps` are the collaborators (`inspectRepo`, `proposeProfile`, `verifyProfile`, `saveProfile`, `describeCommands`, `ask`, `skillText`, `writeFile`, `now`) with the real ones as defaults, so tests can pass fakes.
The command line at the bottom only parses `process.argv`, calls `runOnboard`, prints `lines` and sets the exit code. The rules, in order:
1. Missing `repoPath`, `--name`, `--good` or `--cand` gives code 2 and a usage line.
2. Run `inspectRepo(repoPath)`; add a short summary of the facts to `lines` (tags, whether there is an `index.html`, package scripts).
3. Get a profile: if `--profile file.json` is given, read and validate it with `validateProfile` (code 2 with the problems if invalid). Else if `--propose`: build the messages; with `--dry-run` print the projected cost and the number of prompt characters and STOP (code 0, nothing sent);
   otherwise refuse (code 2) if the projected cost is above `--max-cost` (default 0.3), call `proposeProfile`, add the cost to `lines`, and if the proposal has problems, print them and stop with code 1. Else (neither flag) code 2 with a usage line.
   In every case the profile's `name` is forced to `--name`, and the proposal is written to `out/onboard/<name>.proposed.json` through `writeFile` so a person can read it.
4. Print `describeCommands(profile)` under the heading `Commands this profile would run:`.
5. Without `--approve`: print `Review the profile above, then run again with --approve to build and verify it.` and stop with code 0. **Nothing is built, served or executed without `--approve`.**
6. With `--approve`: call `verifyProfile`; print each check as `ok` or `FAILED` with its detail. If `report.ok`, call `saveProfile(profile)` and print where it was saved (code 0); if not, do NOT save, print that the profile was not saved (code 1).
The default `ask` (used only by the real command line, never by tests) calls `chat('meta', messages, { maxTokens: 4000, reasoning: 'low' })` from `../../llm.mjs` and resolves `{ text, pt, ct }`; the default `skillText` is the contents of `docs/skills/onboard-app.md`.

## Tests (offline, fakes only)

`verify.test.mjs`: with fake `startBuildFn` (records starts and stops, can be told to throw for a ref), fake `pictureFn` (returns PNGs made with `blank`, `paint` and `encode` from `src/senses/pixels.mjs`, can return `settled: false` or a different size or a blank picture) and fake `floorFn`:
all checks pass; the good build fails (later checks skipped, and the other build is not started); the candidate build fails (the good build is still stopped); an unsettled picture; different sizes; a blank app; `floorFn` throwing. Every started build is stopped in every case.
`onboard.test.mjs`: usage errors give code 2; `--propose --dry-run` calls neither `ask` nor `verifyProfile`; a proposal over the cost cap is refused; a proposal with problems stops with code 1 and saves nothing; without `--approve` nothing is verified and nothing is saved (assert the fakes were not called);
with `--approve` and a passing report the profile is saved once; with a failing report it is not saved and the code is 1; the command list is printed before anything is verified; `--profile` with an invalid file gives code 2.
