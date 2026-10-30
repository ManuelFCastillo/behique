# Build log: Muse built these parts from the specs in this folder

Built 2026-10-29 with `tools/muse-build/build.mjs`, standard Muse Spark 1.3 through the Meta API (provider `meta`, reasoning low), about $0.57 estimated in total
(unverified third-party price). Every file Muse wrote was read before its tests were run. The scan stopped each part once before any test ran, for a pattern the spec had
not allowed (an environment variable read the spec asked for, a test string that looks destructive, an example URL), and a person cleared it by reading the files.

| Part | Files | Model calls | Estimated cost | How it went |
|---|---|---|---|---|
| 1 Profile and runner | `onboard/profile.mjs`, `static-server.mjs` | 4 | $0.155 | First test had a flaw (`fetch` collapses `/../x`); repaired. Rebuilt once from a stricter spec (refuse interpreter eval arguments, warn on `npx`); repaired once more |
| 2 Settled pictures | `visual/picture.mjs` | 1 | $0.042 | Passed first time |
| 3 Inspect and propose, skill file | `onboard/inspect.mjs`, `propose.mjs`, `docs/skills/onboard-app.md` | 2 | $0.102 | Rebuilt because my spec used the Music Blocks profile as the skill's worked example (a model could copy it); now two made-up apps, tested |
| 4 Verify and onboard | `onboard/verify.mjs`, `onboard.mjs` | 2 | $0.101 | One repair round |
| 5 Visual bisect | `visual/visual-bisect.mjs` | 2 | $0.065 | One repair round |
| 6 Check and evidence | `visual/check.mjs`, `evidence.mjs` | 2 | $0.103 | One repair round |

## What a person changed after reading Muse's code (not written by the model)

- `src/release/build.mjs`: the feed and the expected entry count are optional, so a static site needs no feed (my change, before the build).
- `onboard/verify.mjs` and its test: a new check, "no page errors on the good version" (a page that throws while loading is not an app we know how to run), and its test.
- `visual/check.mjs` and a test: with no regions in the profile the whole picture is compared (it used to compare nothing and say "no candidate defects"); the bisect's log lines and events are kept for the record.
- `visual/evidence.mjs`: writes the bisect events; takes a region's box from the report when the profile has none.
- `visual/visual-bisect.mjs`: removed one dead line.
- The profile `onboard/profiles/musicblocks.json`: Muse proposed only the static serve and said what it could not know; the three regions and the workspace anchor were added by a person after verification passed (the profile's `notes` say so).

## First real result (Music Blocks v3.8.0 against master)

`onboard.mjs` proposed a profile for the public repo (cost $0.008), verification built both versions in about 2 seconds each and measured a noise floor of 0 pixels, and
`check.mjs --bisect` compared the regions and bisected the left edge strip in 10 steps over 695 commits to `5d13049` "fix: improve graphics window boundary contrast (#8741)",
which touches `js/utils/platformstyle.js`; the parent matched 3 of 3 runs and the commit differed 3 of 3. The commit's own title says the change is intended, so this is a visible
change Behique found and located, not a bug. The case is `20261029T234502Z_musicblocks-v3.8.0-vs-master` on the report page.

## Known limits

- One real app, one proposal. The model was not asked to handle an app that needs install, a dev server or a seeded state.
- The profile's regions were chosen by a person from the measured difference; the system does not yet find them itself.
- Pictures are saved by content, so an unchanged region's pictures share one file and the report shows one name for them (for example the good picture and the parent picture).
- This path is not in the dashboard's "start a run" flow yet: the dashboard starts the DOM-based `confirm.mjs`, so a visual check is started from the command line.
