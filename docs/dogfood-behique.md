# Dogfood: Behique checks its own dashboard

Run 2026-11-04 (00:18 to 00:29 local), by a helper session. Behique was set up as an app inside Behique and `behique check` was run on its own dashboard between two existing commits, inside the Docker sandbox on hardac2.

## Verdict in one paragraph

Behique recommended HOLD on `d2c6f20` (good) vs `bc8f6aa` (candidate): 5 reproduced behaviour changes, all 5 "a person would notice", 0 markup churn, evidence log verified. The bisect named `bc8f6aa` as the first bad commit in 4 steps (verified: parent `2a9df3a` passed 3 of 3, `bc8f6aa` failed 3 of 3). The finding is true, and it matches `git diff`, but it is not about the dashboard code: all 5 tests are the same change seen five times. The app list in the sidebar (and the "Set up an app" dropdown) is built from `src/release/onboard/profiles/*.json` of the checkout, and `bc8f6aa` added `docusaurus.json` and `slidev.json`. Two new apps appear, so every button after them moves down one place (`excalidraw` at button 3 becomes `docusaurus`, and so on). The change the dashboard code itself made (values drawn as code with the differing words lit) is in the recorded facts too, but did not make the top 5. See "What Behique saw and what it did not".

## What was set up

| File | What it is |
|---|---|
| `src/release/onboard/profiles/behique.json` | The profile (format v2), hand written, no model call. This is what puts "behique" in the sidebar (`appregistry.mjs` `profileApp`). |
| `src/release/onboard/seeds/behique/evidence/` | Two saved cases of public apps, 0.9 MB in all: `20261102T055326Z_2025.10.1-vs-2025.11.2` (Hoppscotch, with a bisect, a reproduced failure and screenshots) and `20261031T151534Z_1.29.1-vs-1.30.0` (FreshRSS Share regression). No decisions, no secrets (grepped for key, secret, bearer, password and home paths: none). Not the private codecosmos case. |
| `docs/dogfood-behique.md` | This file. |

The profile in plain words: repo `/Users/mcastillo/dev/behique`, work root `/Users/mcastillo/dev/behique-apps/work` (the same as the other apps), defaults good `d2c6f20` and candidate `bc8f6aa`, install `npm ci` (run with scripts off, nothing downloads a browser), serve `node demo/server.mjs {port}`, ready when `/dashboard` answers (60 s limit), viewport 1280 by 800 at scale 1, no services, no login. The server listens on localhost only inside the container and the sandbox launcher relays it, as for vitepress. `describeCommands` shows only `install: npm ci` and `serve: node demo/server.mjs {port}`. `profile.test.mjs`, `profile-v2.test.mjs` and `appregistry.test.mjs`: 54 of 54 pass.

### How the evidence gets into out/evidence (the awkward part)

The dashboard is dull without cases in `out/evidence`, and `out/` is git-ignored, so a checkout of any ref has none. The profile format has no clean way to put a file into a checkout:

- `seed` entries only load a sidecar database (`psql`, `mongosh`, `redis-cli`...). Behique has no database.
- `serve.prepare` commands are limited to `node`, `npm`, `npx`, `pnpm`, `yarn` and may not run inline code (`-e`, `-p`, `-c`). A script that copies the cases would have to exist in the checkout, and the refs under test do not contain it (and I was told not to edit repo files).
- I did not work around the inline-code rule (for example `npm pkg set scripts...`), because that rule is a safety property.

What does work, and what was done: `checkoutRef` makes the checkout as a git worktree under the work root and never cleans it (`git clean` is limited to a path that does not exist), and `packDir` tars the whole checkout except `.git` and `node_modules`, ignored files included. So files placed in the worktree's `out/evidence` are shipped into the sandbox. The seeds were placed like this, after `checkoutRef` had made the two worktrees (it is the same function the check uses):

```
node --input-type=module -e '
const {loadProfile,profileToAdapter}=await import("./src/release/onboard/profile.mjs");
const {checkoutRef}=await import("./src/release/checkout.mjs");
const ad=profileToAdapter(loadProfile("behique"));
for(const r of ["d2c6f20","bc8f6aa"]) console.log((await checkoutRef(ad,r)).dir)'
# then, for each printed dir:
mkdir -p <dir>/out/evidence && cp -R src/release/onboard/seeds/behique/evidence/. <dir>/out/evidence/
```

This is a manual step per ref. It is not in the profile, so a new ref (a bisect commit, for example) is NOT seeded. In this run the bisect midpoints (`9a5863f`, `c06c9fd`, `1aba489`, `2a9df3a`) had no seeded cases, which is acceptable here because the bisect tests R1 (a sidebar button), not the report. For a real, repeatable setup either the profile format needs a `files` list (copy these files into the checkout before the install), or the server needs to read evidence from somewhere the sandbox provides: the working tree's `demo/server.mjs` already has `BEHIQUE_EVIDENCE_DIR` (uncommitted when I looked, so absent from both refs), which would let `serve.env` point at a folder, but a folder still has to be filled. Neither exists yet; I did not add them.

## Commands run

```
# sandbox check: hardac2 answered over ssh, docker 29.9.2
BEHIQUE_SANDBOX=docker:ssh://hardac2 node bin/behique.mjs check behique d2c6f20 bc8f6aa --no-dashboard
BEHIQUE_SANDBOX=docker:ssh://hardac2 node bin/behique.mjs check behique d2c6f20 bc8f6aa --bisect --no-dashboard

# my own server, then stopped
node demo/server.mjs 8797
curl http://127.0.0.1:8797/api/ui/repos      # sidebar apps
curl http://127.0.0.1:8797/api/ui/cases      # Reports list
curl "http://127.0.0.1:8797/api/ui/case?id=<case>"
```

`--no-dashboard` so nothing was posted to the server on 8790. Nothing ran unsandboxed: the only host process was the CLI itself, and the app, `npm ci` and the dashboard under test ran in Docker on hardac2 (no outside network for the app). The local OrbStack engine was not needed and not tried.

## The two refs

- Good: `d2c6f20` "Each recording says what it shows" (2026-11-02 13:55).
- Candidate: `bc8f6aa` "Docusaurus and Slidev through the dashboard..." (current HEAD, 2026-11-03). 11 commits apart; `ui/behique-live.html` changed in 3 of them (`43bcb3b`, `c79a25c`, `751f9fa`; 64 lines changed in all, mostly `751f9fa`'s code-styled values).
- Uncommitted working-tree changes are NOT part of either ref. Other sessions were editing `demo/server.mjs`, `ui/behique-live.html`, `src/release/viewmodel.mjs` and untracked `ui/ai-panel.js`, `ui/right-tabs.js` at the time. The check tested the committed files only (worktrees of the two commits), so what is on screen at 8790 today is not what was checked.

## Results

| | Run 1 | Run 2 (with `--bisect`) |
|---|---|---|
| Case | `20261104T061934Z_d2c6f20-vs-bc8f6aa` | `20261104T062433Z_d2c6f20-vs-bc8f6aa` |
| Verdict | HOLD, CONFIRMED | HOLD, CONFIRMED, BISECT CONFIRMED |
| Crawl | 22 page states, 19 flows, 38 steps (stopped at its 60 s limit) | reused the saved crawl |
| Facts | 28522 stable, 3 volatile (0.0% masked); control third recording: 0 differences | same |
| Candidate vs good | 4855 differences (changed 902, added 3809, removed 36, moved 108) | same |
| Findings | R1 to R5, each passed 3 of 3 on good and failed 3 of 3 on candidate | same |
| Bisect | not run | 11 changes, 4 steps (`9a5863f`, `c06c9fd`, `1aba489`, `2a9df3a` all good), first bad `bc8f6aa`, both ends verified 3 of 3 |
| Time | total 248.8 s (compare 178.6, tests 64.4, shots 5.9) | total 245.7 s (compare 117.1, tests 68.8, shots 6.5, bisect 53.3) |
| Recordings | 10 webm (one run each way per finding), 3 screenshots | likewise |

Sidebar and reports: `GET /api/ui/repos` on my server (port 8797) lists `behique` as `kind: profile`, "set up by Behique", ready, defaults `d2c6f20`/`bc8f6aa`. `GET /api/ui/cases` lists both runs with `app: "behique"`, verdict `hold`, so they show under Reports when the app is selected. `GET /api/ui/case` returned the second case with 11 claims and the bisect (`conclusive: true, verified: true, steps: 4`). I did not look at the page in a browser. The GitHub entry for the repo named `behique` is linked to this profile by `profileForRepo` (folder name), by code reading and the unit tests only; `gh` was not queried.

## What Behique saw and what it did not

Compared with `git diff d2c6f20 bc8f6aa`:

- Matches: R1 to R5 are text changes of sidebar buttons 3 to 7 (`excalidraw` to `docusaurus`, `hoppscotch` to `excalidraw`, `html5-boilerplate` to `hoppscotch`, `musicblocks` to `html5-boilerplate`, `nextjs-blog` to `musicblocks`). `git diff --stat` shows exactly `docusaurus.json` and `slidev.json` added to the profiles folder. The same shift shows in the "Set up an app" dropdown (options 3 to 11 changed, 2 added) and the sidebar gains a scrollbar at step 35. The bisect landing on `bc8f6aa` is right, since that commit adds both files.
- Five findings for one cause: the five tests differ in value, so they were not grouped (`alike` groups the same change on several elements). A person reading the report would want "two apps were added to the list" as one line.
- The dashboard code change was seen but not turned into a test. The facts diff contains the effect of `withCode`/`codeVal` (new `code.val` and `mark` elements inside claim cards of the seeded cases: about 590 `mark` elements added, 370 `code` elements added, 148 claim sentences whose text changed because the quoted values moved into `code`), so the seeded cases did render and the new rendering was recorded. But added elements are not turned into tests (only changed values and vanished elements are), the cap is 5, and the sidebar text ranks first. So the verdict is right and complete as a HOLD, but it hides the larger, more interesting change behind the most noticeable one.
- Not seen: the new `openOnLastFrame` behaviour (no recording was played), the "borrowed recordings" block (no seeded case has one), colour of the lit tokens (CSS values are not recorded as facts; the screenshot after step 2 differs by 124961 pixels and the diff image is saved), and anything behind POST (the crawl is read-only: GET only, nothing typed).
- Masked: 3 of 28525 facts (0.0%), under `window`; `window@scrollY` also differs by 2 pixels (1503 to 1501) after the click on "Set up an app"; I did not find out why (probably the page is a little taller or shorter on the candidate).

## Problems and caveats

- The crawl stopped at its 60 s limit (22 states). It reached the Evidence view but I did not confirm it opened a seeded report; the claim-card facts show it did render claims.
- Both refs were seeded by hand (see above); a ref that is not seeded has an empty Evidence view, so a check on any other pair of refs needs the same two steps first.
- The two checks added two real cases to `out/evidence` (git-ignored), which the main dashboard on 8790 will now list under the `behique` app, and wrote `out/crawl/behique-d2c6f20748d1.*` and `out/check/*.json`.
- Left behind: six `bq-cache:behique-*` images on hardac2 (the build cache, about 1.2 GB each but sharing the base image; `src/release/sandbox/clean.mjs` prunes them), two worktrees under `~/dev/behique-apps/work/w-d2c6f20748d1` and `w-bc8f6aaac436` (with `out/evidence` seeded) and their entries in this repo's `.git/worktrees`. No containers, networks or volumes labelled `behique=1` remained on hardac2, and nothing listens on 8797 or the 83xx ports any more.
- The bisect ran on a good network from hardac2 this time; the earlier note that it was unreliable on a poor network was not reproduced. No step was skipped (`skipped: 0`).
- No paid model call was made (`--explain` and `--ai` were not used).

## What a person should do next

1. Open the dashboard on 8790, select the `behique` app and read the second case. Decide whether HOLD is the right word for "two apps were added to a list": a data-driven list changing is something a person notices but would ship, so this is a fair test of the ranking rules.
2. Decide how seed files should reach a checkout: a `files` list in the profile (copy named files from `seeds/<app>/` into the checkout before the install), or a committed server setting (`BEHIQUE_EVIDENCE_DIR` plus a seeded folder). Then the hand-copy step goes away and bisect midpoints are seeded too.
3. Consider collapsing findings that are the same data change on a list (five buttons shifting by one) into one finding, and letting added elements with a `code`/`mark` shape reach the findings. Both would have put the dashboard's own code change in the top results.
4. Pick refs where the profile folder did not change (for example `751f9fa^` vs `751f9fa`, one dashboard commit) for a cleaner dashboard-only check; the same two commands work with `--recrawl` on the new good ref.
