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
- [x] The old mock dashboard folder (`~/dev/behique-ui`) is no longer used; the fabricated confidence figure and the replay animation are gone. One leftover: the build panes still hold a drawn FreshRSS placeholder (`.mock` markup at about line 510 of `ui/behique-live.html`) for reports with no pictures; it should become a plain "no picture for this step" box (listed under Left, item 14).

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
5. [ ] **Turn a vanished element into a test** (an added or removed fact has no value to assert; assert presence instead). Effort: half a day.
6. [ ] **Apps behind a login or needing seed data** are out of reach (umami's crawl sees 2 pages). Seed data in the profile, a login step a person approves. Effort: 2 days.

### Where it runs
7. [x] **A command and a CI hook** (2026-10-31). `node bin/behique.mjs check <app> <good> <cand>` (package `bin`: `behique`) runs the pipeline, streams its log, prints the result as Markdown, writes `out/check/<case>.json` and `.md`, and exits 0 SHIP, 1 HOLD, 2 REVIEW, 3 incomplete. `--profile file.json --repo path` takes the profile from the repository under test. `behique comment --result ... --repo owner/name --pr N` posts it through `gh api` as one marked comment, updated on later runs (`--dry-run` prints it). `action.yml` is a composite GitHub Action (inputs: profile, app, good, cand, bisect, max-findings, sandbox, comment, fail-on-hold, github-token; the Markdown also lands in the job summary); `docs/ci.md` has the workflow. Verified: 18 unit tests (`src/release/cli/`), a real `check` on html5-boilerplate v9.0.0 vs v9.0.1 in the hardac2 sandbox (SHIP, exit 0, 22 s), the same through `--profile`, and `comment --dry-run`. Not yet run on GitHub's runners; no real PR was commented on.
8. [x] **README.md** at the repo root (2026-10-31): what it is, start, the command and the Action, what a report means, limits, tests, doc links.
9. [ ] Login and identity: decisions are attributed by a typed name; the server is local use only. Not needed for the hackathon.
10. [ ] Speed, next cut: run the compare phase's recordings through the pool (compare is now 60 to 90 percent of a check and is recording time, not install time); an npm/pnpm/yarn cache volume on hardac2 for first installs; Phase 3 floor cuts (small). Effort: 1 day for the pool part.

### Engine completeness
11. [ ] Explorer (model-driven) connected to the release pipeline, or retired from the pitch. Unaided it misses flows on real apps (0 of 2 on FreshRSS).
12. [ ] Canvas senses wired into the main check so a canvas app gets hands and pixels, not only the picture bisect.
13. [ ] Repeated runs per repo to measure flakiness (every bench number is one run).
14. [ ] An end-to-end test of server plus pipeline (681 unit tests, none end to end). A spend ledger across runs. Dashboard: Reports pagination, cases list cached by mtime, model key field (today it stays in `.env`), replace the drawn FreshRSS placeholder in the build panes with a plain "no picture" box.
15. [ ] Record integrity: the newest event is unprotected until another follows, and the head hash is not anchored outside the folder.
16. [ ] Runs started from a terminal are not tracked by the dashboard server.

### Hackathon
17. [ ] Confirm the deadline, track, criteria and video limit from the official page or email.
18. [ ] Record the video (`docs/DEMO-SCRIPT.md`; run `demo/prepare.mjs` first). The script predates the dashboard, the crawl and the six repos; refresh the beats to: set up a repo from zero in the dashboard, the FreshRSS regression found by the crawl and bisected, Ship/Hold.
19. [ ] Submission text and a public repo or a private one with judge access.

## Is it a wow product? What would make it one by Nov 4

Not yet. The engine is strong and unusual: no model in the loop, every claim backed by a test that passes on one version and fails on the other, the commit found, a record a person signs. The product is not yet a wow because a judge or a user sees a six-minute wait and then a flat list where a broken share link weighs the same as a changed `data-slot` attribute, and nothing runs it where releases happen.

In order, each one makes the next better, and the first three fit in four days:

1. DONE 2026-10-31: **ranked findings (item 1) plus "what cannot be seen" (item 2) plus third-party volatility (item 3).** A report now reads, for example, "2 reproduced behaviour changes (1 a person would notice, 1 markup churn)" and "1,223 of 15,259 recorded facts (8.0%) were masked as noise, mostly under body/div[1]/nav[1] (640)". That sentence is the product.
2. DONE 2026-10-31: **a command and a PR comment (item 7) and the README (item 8).** A judge can run it on their own repo in one line; the verdict lands on a pull request through the Action (written and tested here, not yet run on a GitHub runner).
3. **The video (item 18)**, built on FreshRSS (crawl, confirm, bisect, Hold) plus one of the six repos set up from zero in the dashboard, with the ranked report on screen. Three minutes.
4. After the hackathon: login and seed data (item 6), more fact kinds (item 4), compare through the pool (item 10), the explorer decision (item 11).

What not to do before Nov 4: Firecracker or gVisor (isolation, not speed, and Docker is enough for the demo), the explorer, canvas wiring, Phase 3 floor cuts.

## Parked on purpose
- Firecracker, gVisor, Kata: only if a harder wall than Docker is wanted; measure first (`docs/speed-plan.md`, Phase 5).
- The vision-only Python experiment (`eval.py`, `probe.py`): kept as history.
- Baseline artifact for the explorer bench is out of date; the explorer is not in the pitch.

## Open questions
- Official hackathon deadline, track, criteria, video limit (see Hackathon above).
- Did Muse Code's session read `.env`? If unsure, rotate the keys.
- Credits: about $40 of $250 spent (estimates, prices unverified).
