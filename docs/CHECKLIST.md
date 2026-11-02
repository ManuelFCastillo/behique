# Behique: master checklist

Written 2026-10-31. One page that says what is done, what is left, and what stands between this and a product people say "wow" to. `docs/STATUS.md` is the day-by-day log with the details and numbers; this file is the summary and is the one to update when something lands.

Deadline: Meta Global AI Developer Hackathon, treat as **Wednesday 2026-11-04, 8 PM ET** (4 days). The official page could not be read by tools; 9 PM ET was our earlier note, a third-party listing says 8 PM ET. Track, judging criteria and video limit are unverified. Manny holds the confirmation email.

The one line: hand Behique a repository and two versions. Without a model and without hand-written steps it sets the app up, finds the click paths, records what the running app does on both versions, proves each change with a test that passes on the old version and fails on the new, finds the commit that caused it, and keeps a tamper-evident record that a person signs Ship or Hold.

## Done

Each line names where it is verified. "Verified" means run for real, not only unit-tested.

### Set up any repository
- [x] List the user's GitHub repos read-only through the `gh` login, clone one from the dashboard with a preview of the exact command (`src/release/github.mjs`, `ui/clone-flow.mjs`). Verified: 47 repos listed; cloning checked by preview and refusals only, no repo was cloned from the page.
- [x] Inspect a repo without running anything (package manager, frameworks, workspaces, env templates, compose, static roots) and have the model propose a profile (`onboard/inspect*.mjs`, `propose.mjs`; one call, about $0.008).
- [x] Verify the profile by running it, feed failures back, repair up to 3 rounds (`onboard/repair.mjs`). Verified on 6 repos: 1 right as proposed, 5 after 1 to 3 rounds, about $0.10 in all.
- [x] Six profiles saved and in the sidebar: excalidraw, html5-boilerplate, nextjs-blog, todomvc, umami, vitepress. Plus FreshRSS (built in) and Music Blocks (visual).
- [x] Run untrusted repos in Docker on hardac2 (or a local engine) with database sidecars, no outside network, scripts disabled unless approved, every docker argument built by one policy module (`sandbox/`). Verified: egress blocked, umami with Postgres, all six repos.
- [x] Refuse to run a repo's own code on this machine unless a sandbox is on (`ui/settings.mjs`, `needsSandbox`).

### Check two versions
- [x] Crawl the good version read-only (GET only, nothing typed, no model) to find click paths (`crawl/`). Verified: FreshRSS Share regression reproduced from the crawl alone, the same answer as the hand-written case.
- [x] Record page facts along the crawled flows on both versions, learn noise from control recordings (up to 5 extra), compare (`facts.mjs`, `compare.mjs`).
- [x] Turn every changed fact into a Playwright test, run each 3 times per version on fresh builds, judge confirmed / unstable / not reproduced, up to 5 findings per run (`findings.mjs`, `confirm.mjs`, `export.mjs`). Verified: six real repos, planted-change bench 8 of 8 found, 7 of 8 proven, 0 false positives.
- [x] Screenshots at every confirmed step, good twice (floor) and candidate once, recorded with a plain sentence when the change is invisible (`shots.mjs`).
- [x] Bisect to the first bad commit with the exported test, skip-safe, both ends verified 3 of 3 (`bisect.mjs`). Verified: FreshRSS 8 steps over 227 commits; Music Blocks 10 steps over 695 (visual).
- [x] Visual check for canvas apps: settled pictures, regions proposed from the difference, visual bisect (`visual/`). Verified on Music Blocks.
- [x] Speed: per-commit build cache as Docker images, pool of 3 builds, crawl reuse, a `timing:` line per check (`sandbox/cache.mjs`, `pool.mjs`, `crawl/reuse.mjs`). Verified: six repos 111 min to 35 min, test runs 9x to 20x, same outcomes; the one pool bug (recording port baked into a value) fixed and rerun.

### Evidence and the decision
- [x] Append-only hash-chained record, content-addressed evidence, claim labels with enforced authorship (code proves, a model only guesses, a person decides) (`evidence.mjs`).
- [x] Ship / Hold from the dashboard with server-enforced rules: reason required, override needed to ship against HOLD, nothing decided mid-run, no ship on incomplete evidence (`decision.mjs`).
- [x] The one paid "ask why" call shown word for word with its price before it is sent, 3 per case, grounded-quote check (`ask.mjs`, `hypothesis.mjs`). Verified once for real, about $0.006.

### Dashboard (`ui/behique-live.html`, served at `/dashboard`, `npm start`)
- [x] New run (Behaviour, Pictures, or a known case) with live progress and cancel; Runs, Evidence, Bisect, Reports, Settings views all work; Settings chooses where checks run and the speed options. Verified in the browser.
- [x] Set up an app from the dashboard: review the exact text and cost, propose, approve commands, verify, save. Verified on a copy of Music Blocks.
- [x] The old mock dashboard folder (`~/dev/behique-ui`) is no longer used; the fabricated confidence figure, the replay animation and (2026-10-31) the drawn FreshRSS placeholder in the build panes are gone. Before a report loads the panes say "Nothing loaded yet" and what will show there.

### Explorer and canvas senses (earlier work, kept)
- [x] Model-driven explorer on the planted-bug todo app: 13 of 27 bugs (Meta Spark 1.3), replay and self-check, Playwright export (`src/explorer.mjs`). Not connected to the release pipeline.
- [x] Canvas senses phases 0 to 3: pixel diff and floor, coordinate hands with pixel verdicts, model vision for controls, 18 of 18 planted canvas bugs; recorded in the evidence store and shown on `/report`. Not wired into the main check.

### Documentation
- [x] `docs/STATUS.md` (log), `docs/sandbox.md`, `docs/speed-plan.md` + PDF, `docs/canvas-senses-plan.md`, `docs/DEMO-SCRIPT.md` + PDF, `docs/overnight-log.md`, `docs/onboarding-baseline.md`.

## Left

Ranked by how much each changes what a user sees. Effort is a guess for one person with the current tooling.

### Product
1. [x] **Rank findings by whether a person would notice** (2026-10-31, `src/release/notice.mjs`). Every finding carries a class: a person would notice (text, a link or form target, a state such as disabled or expanded, the page scrolling differently, a link or text carried in a `data-*` attribute), or markup churn (generated ids such as `_r_1_` and `:r3:`, framework `data-*` tokens, hashed asset names, `rel`). Findings are ranked by class, so the cap keeps the noticeable ones, R1 is the most noticeable and the bisect follows it; the class is in the claim, the test's header, the log and the dashboard's build panes. A check whose proven changes are all churn is recommended SHIP with the note "Only markup churn changed: n proven changes, nothing a person would notice" instead of HOLD. Verified: 96 unit tests on the rules, selection and view-model, and the umami rerun below.
2. [x] **Say what cannot be seen** (2026-10-31). The compare phase records a `masking.summary` event (masked count, total, the page areas with the most masked facts); the statistical claim ends with "The masked facts sit mostly under ... A change inside a masked fact cannot be seen by this check", and the dashboard shows the same sentence under the good build.
3. [x] **Treat third-party content as volatile** (2026-10-31). A `src`, `srcset` or `poster` whose host is not the app's own (the recording origin or a loopback name) never becomes a finding; it is listed as skipped with the host named. Links (`href`) to other hosts stay the app's own choice and are still findings.
   Still open from this group: the classes are rules, not learned; a hashed-looking change in text is still "noticeable" (a version label is text and should be); no class yet for a missing element or a console error because those facts are not recorded (items 4 and 5).
4. [ ] **Record more kinds of fact**: console errors, failed network requests, HTTP status of the page, accessibility names. Today: attributes, text, scroll position, pictures. Effort: 1 to 2 days.
5. [x] **Turn a vanished element into a test** (2026-10-31, `vanishedRoots` in `src/release/findings.mjs`). The removed facts of a step are collapsed to the elements whose ancestors are all still there (one vanished element takes every attribute and text under it), and for each one the fact a person would miss first (its text, then a link, a value, a picture) becomes a test that expects the old value, so it fails on the candidate whether the whole element is gone or only its attribute or text. Vanished elements rank after value changes and get the same notice class; the claim says "n elements present on good are missing (m recorded facts)", the dashboard row says "the element is gone on the candidate". The old `facts missing` close (no test) only remains when no vanished element can be written as a test. Verified: unit tests on the collapse, the selection and the view-model; not yet seen on a real repo.
6. [x] **Apps behind a login or needing data** (2026-10-31, `src/release/login.mjs`, `src/release/sandbox/seed.mjs`, `serve.prepare`). A profile's `login` block (path, user, a password from the environment or a documented public default, submit) becomes recorder actions inserted before the steps and after every `goto /` reset; the password is filled but never written to the record, and an exported test reads it from the environment. The read-only request filter lets the login's own request through. `serve.prepare` commands run before every start, inside the cached image, so an app's migrations hit the fresh sidecar. `seed` files load into the sidecars. umami: the crawl went from 2 page states (an empty database on a cached build made the login answer 500, not the login itself) to 16 page states, 12 flows, 28 steps across /websites, /dashboard, /boards, /links, /pixels and /dashboard/edit, logged in as the default admin. Not done: a seed file run end to end (no profile uses one yet), and a full check on umami with the login (the crawl only).

### Where it runs
7. [x] **A command and a CI hook** (2026-10-31). `node bin/behique.mjs check <app> <good> <cand>` (package `bin`: `behique`) runs the pipeline, streams its log, prints the result as Markdown, writes `out/check/<case>.json` and `.md`, and exits 0 SHIP, 1 HOLD, 2 REVIEW, 3 incomplete. `--profile file.json --repo path` takes the profile from the repository under test. `behique comment --result ... --repo owner/name --pr N` posts it through `gh api` as one marked comment, updated on later runs (`--dry-run` prints it). `action.yml` is a composite GitHub Action (inputs: profile, app, good, cand, bisect, max-findings, sandbox, comment, fail-on-hold, github-token; the Markdown also lands in the job summary); `docs/ci.md` has the workflow. Verified: 18 unit tests (`src/release/cli/`), a real `check` on html5-boilerplate v9.0.0 vs v9.0.1 in the hardac2 sandbox (SHIP, exit 0, 22 s), the same through `--profile`, and `comment --dry-run`. Not yet run on GitHub's runners; no real PR was commented on.
8. [x] **README.md** at the repo root (2026-10-31): what it is, start, the command and the Action, what a report means, limits, tests, doc links.
9. [ ] Login and identity: decisions are attributed by a typed name; the server is local use only. Not needed for the hackathon.
10. [ ] Speed, next cut: run the compare phase's recordings through the pool (compare is now 60 to 90 percent of a check and is recording time, not install time); an npm/pnpm/yarn cache volume on hardac2 for first installs; Phase 3 floor cuts (small). Effort: 1 day for the pool part.

### Engine completeness
11. [x] **Explorer: retired from the pitch** (2026-10-31). The model-driven explorer stays in the repo as the earlier benchmark (`src/explorer.mjs`, `bench.mjs`) and is not part of the release check, the dashboard, the command or the video. The crawl (no model) is what finds the click paths. Nothing was deleted.
12. [x] **Canvas pixels wired into the main check** (2026-10-31, `src/release/canvas-check.mjs`, `shots.mjs`, `confirm.mjs`). The recorder now records every canvas as a fact (`@canvas`, its size). At the steps where a canvas shows (step 0 and the last canvas step of each flow, up to 8), the check photographs the good version twice and the candidate once through the build pool and compares the pixels inside each canvas box against the noise floor of the two good runs (`canvas.compared` event, one diff picture and one claim per changed canvas). A changed drawing with no DOM change closes the case as `canvas changed`, shown HOLD with "n canvas drawings changed beyond the noise floor"; it is person-visible evidence, not a repeatable test, and the record says so. Verified: 16 unit tests; not yet run end to end on Music Blocks (the hands and vision senses stay on their own pages).
13. [ ] Repeated runs per repo to measure flakiness (every bench number is one run).
14. [ ] An end-to-end test of server plus pipeline (808 unit tests, none end to end). A spend ledger across runs. Dashboard: Reports pagination, cases list cached by mtime, model key field (today it stays in `.env`).
15. [x] **Record integrity: the head is anchored outside the folder** (2026-10-31, `src/release/anchor.mjs`). When a case closes (and on every Ship/Hold decision) the hash of its newest event goes to `out/evidence/anchors.ndjson`, a chained ledger outside the case folder, and to a mirror file when `BEHIQUE_ANCHOR_MIRROR` names one. The report's view-model verifies the record against the ledger (`anchors`: ok, how many events are covered, problems) and the dashboard's "Verify chain" prints it after the chain result: "Anchored: all 35 events are covered by the ledger outside the case." An event edited or appended after the anchor shows as a mismatch. Still true: the ledger is a file on the same machine; a mirror on another machine (or a signed commit) is the next step.
16. [x] **Runs started from a terminal show in the dashboard** (2026-10-31, `src/release/ui/external-runs.mjs`, `GET /api/ui/runs/external`). The server lists open cases it did not start itself, with the phase and progress read from their own events; the hero card shows each as a row ("h5bp-ci v9.0.0 vs v9.0.1 (from the command line)", a bar, the phase, Open), stale ones dimmed after 30 minutes without events. Verified with a real `behique check` while the endpoint was polled.

### Hackathon
17. [ ] Confirm the deadline, track, criteria and video limit from the official page or email.
18. [ ] Record the video (`docs/DEMO-SCRIPT.md`; run `demo/prepare.mjs` first). The script predates the dashboard, the crawl and the six repos; refresh the beats to: set up a repo from zero in the dashboard, the FreshRSS regression found by the crawl and bisected, Ship/Hold.
19. [ ] Submission text and a public repo or a private one with judge access.
20. [x] **Blind bisect on real history** (2026-11-01, `docs/blind-bisect.md`, `docs/blind-bisect-runs.md`). Protocol: answer key written first, search range ends at the bad release so the fix is never in view, three separate grades (found the symptom, named the commit, the model explained it). Shortlist of five notable projects from three GitHub searches. VitePress #2949 (rc.10 to rc.12, 25 commits): the first run missed and each of three reruns closed one gap (direct loads in the crawl, state attributes recorded, an appearing attribute as a test, the bisect reading its failure); run 1d found the `inert` sidebar and bisected to 070fc0a, the exact commit the project reverted, parent verified. Hoppscotch #5693 from zero (2026-11-02): the model's set-up proposal failed (lifecycle hooks vs `--ignore-scripts`), repaired by hand outside the dashboard, verified second try; the check bisected to the exact culprit d67a85b in 5 steps but by following a scoped-style hash that moved in the same commit, recommended SHIP, and never saw the `overflow-auto` class change (`class` is not recorded, nothing scrolls). Run 2b, with class lists and a scroll probe recorded: HOLD on the overflow class change (five panes), the scroll probe saw the Settings pane stop scrolling, bisected to d67a85b for the right reason, 163 s cached. Next: group identical class changes across elements into one finding; Docusaurus #11213 overnight.

## Is it a wow product? What would make it one by Nov 4

Not yet. The engine is strong and unusual: no model in the loop, every claim backed by a test that passes on one version and fails on the other, the commit found, a record a person signs. The product is not yet a wow because a judge or a user sees a six-minute wait and then a flat list where a broken share link weighs the same as a changed `data-slot` attribute, and nothing runs it where releases happen.

In order, each one makes the next better, and the first three fit in four days:

1. DONE 2026-10-31: **ranked findings (item 1) plus "what cannot be seen" (item 2) plus third-party volatility (item 3).** A report now reads, for example, "2 reproduced behaviour changes (1 a person would notice, 1 markup churn)" and "1,223 of 15,259 recorded facts (8.0%) were masked as noise, mostly under body/div[1]/nav[1] (640)". That sentence is the product.
2. DONE 2026-10-31: **a command and a PR comment (item 7) and the README (item 8).** A judge can run it on their own repo in one line; the verdict lands on a pull request through the Action (written and tested here, not yet run on a GitHub runner).
3. **The video (item 18)**, built on FreshRSS (crawl, confirm, bisect, Hold) plus one of the six repos set up from zero in the dashboard, with the ranked report on screen. Three minutes.
4. DONE 2026-10-31 (Wave 4): login and seed data (item 6), canvas pixels in the main check (item 12), the explorer retired (item 11), anchored records (item 15), terminal runs in the dashboard (item 16). Still after the hackathon: more fact kinds (item 4), compare through the pool (item 10), a seed file run end to end.

What not to do before Nov 4: Firecracker or gVisor (isolation, not speed, and Docker is enough for the demo), the explorer, Phase 3 floor cuts, pushing the repo to GitHub before it is cleaned.

## Parked on purpose
- Firecracker, gVisor, Kata: only if a harder wall than Docker is wanted; measure first (`docs/speed-plan.md`, Phase 5).
- The vision-only Python experiment (`eval.py`, `probe.py`): kept as history.
- Baseline artifact for the explorer bench is out of date; the explorer is not in the pitch.

## Open questions
- Official hackathon deadline, track, criteria, video limit (see Hackathon above).
- Did Muse Code's session read `.env`? If unsure, rotate the keys.
- Credits: about $40 of $250 spent (estimates, prices unverified).
