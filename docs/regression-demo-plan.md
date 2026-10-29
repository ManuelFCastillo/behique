# Two-release regression demo: scope and plan

Status: plan plus a passed feasibility spike (2026-10-28). Pipeline not built. Written 2026-10-27. Hackathon deadline Wed 2026-11-04 9PM ET.

## Target app and regression (verified on GitHub, not yet reproduced locally)

App: FreshRSS (PHP, SQLite, no build step, `cli/do-install.php` for headless install).
Regression: sharing links (FreshRSS/FreshRSS#9302).
- Good build: tag 1.29.1 (2026-05-20). Bad build: tag 1.30.0 (2026-09-09). Fixed in 1.30.1 (PR #9303).
- Cause: PR #9146 "Security: apply encodeURIComponent to share template", merged 2026-07-28, commit 1b7178a1. One file (`p/scripts/main.js`), +5 -5.
- Symptom: Share > Clipboard gives `https%3A%2F%2F...` instead of `https://...`.
- 227 commits between the two tags, so a bisect is about 8 steps (fewer on first-parent).
- Story: a well-meant security change silently broke a feature, found by users after release.

Second case for the "dormant bug" story: #9285, scroll position rewritten on every article toggle, caused by PR #8870 (merged 2026-06-05), shipped in 1.30.0, found 2026-09-10. Fallbacks if the spike fails: #9285, then other FreshRSS regressions (26 closed issues with "regression" in the title).

## Pipeline

1. Seed: install a given build headless, serve a fixed local RSS feed (a few static articles) so both builds see identical data.
2. Explore the GOOD build (1.29.1) with the existing Behique explorer. The oracle is the old build, not the model's opinion of what is correct.
3. Record: at each recorded step, store a normalized snapshot of the page facts (visible text, key attributes such as hrefs and data-urls). Run the good build twice and mask fields that differ between the two runs (timestamps, ids). That masking is also the flaky-detection evidence.
4. Replay the same steps on the candidate build (1.30.0) and diff the snapshots. Each surviving difference is a "behavior change".
5. Reproduce: turn the change into an exported Playwright test; run it 3 times on each build. Pass on good and fail on bad, every time, or it is not reported as a regression.
6. Bisect: binary search over first-parent commits between the tags, running that test on each checkout (`git checkout`, start `php -S`, seed, run). Commits that do not start are skipped, like `git bisect skip`. Finish by confirming the first bad commit fails and its parent passes.
7. Hypothesis: the model reads only the diff of the first bad commit (about 2 KB) and writes a possible cause. It is labelled as a hypothesis.
8. Report page: every claim carries its label and links to its evidence. It ends with "Decision: pending human", and the human's ship/hold verdict is stored as an event.

## Evidence store

Append-only `events.ndjson` (same idea as Leviathan's ledger) plus content-addressed artifacts under `evidence/<sha256>` (screenshots, snapshots, test files, logs).

Claim record: `{ id, label, statement, evidence: [artifact hashes], produced_by: script|model, build: tag+sha, command, exit_code, at }`.

Labels and who may emit them:
- `verified_fact`: deterministic code only (for example "commit X changes file Y").
- `reproduced_failure`: the exported test, with 3 of 3 results at both endpoints.
- `statistical`: k-of-n counts (flaky rates, repeat runs).
- `suspected_cause`: bisect result; fact about the commit, never about intent.
- `ai_hypothesis`: the model's only allowed label.

The model has no way to write any other label. A claim without evidence is rejected at write time.

## What exists vs what must be built

Exists: explorer, session, assertions, replay, Playwright export, scoring on two builds.
New: build runner (checkout/install/serve/seed), snapshot recorder with run-twice masking, diff, `attr` assertion kind (read an attribute), bisect driver with skip, evidence store, report page.
Not building: Leviathan integration, CI/commit ingestion, continuous learning, flaky-test analysis beyond the run-twice masking.

## Cost

Bisect and replay use no model tokens. Model use: one exploration run (about $0.20) plus one hypothesis call (cents). Whole demo well under $1.

## Timeline (8 days)

- D1 (spike, about 1 hour first): install PHP, run 1.29.1 and 1.30.0, confirm the share link differs in headless Chromium, confirm `php -S` works at an old commit.
- D1-2: build runner and seeded feed.
- D2-3: recorder, masking, diff, `attr` assertion.
- D4: bisect driver and evidence store.
- D5: report page. D6: second regression (#9285) and recording of the demo. D7-8: buffer and submission text.

## Risks

- The share menu may not be easy to find on a dense UI. Mitigation: the oracle is the old build, so the explorer only needs to cover the area, and a hint to open menus is allowed.
- Snapshot diffs can be noisy. Mitigation: run-twice masking, and report only differences that reproduce 3 of 3.
- Old commits may not start on a current PHP. Mitigation: the skip rule, and the fallback regression.
- The spike could fail on headless clipboard behavior. Mitigation: assert the link in the menu's DOM attribute, not the clipboard.
- Unverified: official hackathon rules and track criteria.


## Spike result (2026-10-28): passed

Throwaway scripts in `spike/` (`build.sh`, `probe.mjs`, `bisect.sh`); FreshRSS worktrees in `~/dev/freshrss-spike/`. PHP 8.5.12 from Homebrew.
- Reproduced in headless Chromium. Share > Clipboard button `data-url` for the first article:
  - 1.29.1: `https://example.com/posts/first?utm=1&ref=a%20b`
  - 1.30.0: `https%3A%2F%2Fexample.com%2Fposts%2Ffirst%3Futm%3D1%26ref%3Da%2520b` (also double-encodes the space). Same result on 3 of 3 runs.
- A scripted bisect over the 227 commits (linear history) took 8 steps and 45 seconds and landed on 1b7178a1, "Security: apply encodeURIComponent to share template (#9146)". No model involved.
- Build, seed and probe take about 5 seconds per commit. The midpoint and every bisect commit started on PHP 8.5.

Setup facts the pipeline must handle:
- A fresh install subscribes to external feeds, which makes data non-deterministic. The seed step deletes them and imports one local feed.
- 1.30.0 blocks fetching from 127.0.0.1 (new SSRF check). Set `INTERNAL_HOST_ALLOWLIST=127.0.0.1:<feed port>` when refreshing. Older builds ignore it.
- The Share menu is empty on a default install. The seed adds a Clipboard sharing service to the user config, so this is a known configuration, not something the explorer discovers.
- The symptom is an attribute (`data-url`), so the planned `attr` assertion kind is required.

Not yet tested: the Behique explorer on FreshRSS, the real clipboard copy, run-twice masking on a full page.


## Build log

2026-10-28, pieces 1 and 2 built:
- `src/release/build.mjs` + `src/release/adapters/freshrss.mjs`: check out a ref (identified by sha), wipe `data/`, install, seed one local feed, serve on a fixed port. About 2 s per build.
- `src/release/facts.mjs`: page facts (path -> attribute or visible text) after every step; `buildBaseline` (run-twice masking) and `diffFacts`.
- `src/release/diff-builds.mjs`: baseline twice + candidate + control. Result for 1.29.1 vs 1.30.0 on the share-menu flow: 1090 stable facts, 174 volatile (13.8% masked), control 0 differences, candidate 62 differences = 2 changed (`data-url` and `data-title`, both URL-encoded), 39 added, 21 removed. The added/removed ones are real markup refactors between versions (buttons moved into forms, CSRF inputs relocated), not volatile data.
- Known gap: moved elements show up as removed + added. Next step is to pair them and collapse them, and to rank `changed` first.

2026-10-28, piece 3 built (moved elements, ranking, exported test):
- `rankDiffs` in `src/release/facts.mjs`: a removed + added pair with the same step, attribute and value becomes `moved` (paired by count, so a real lost or gained copy still shows). Order: changed, added, removed, moved. 1.29.1 vs 1.30.0 now reads 2 changed, 18 added, 0 removed, 21 moved (was 2/39/21).
- `src/release/compare.mjs`: the record-twice + candidate + control logic, shared by `diff-builds.mjs` and `confirm.mjs`.
- `attr` assertion kind added to `src/assert.mjs` and `src/export.mjs` (not offered to the explorer's prompt). Exporter takes an optional `start` path (FreshRSS lives at `/i/`).
- `src/release/confirm.mjs`: top changed fact -> finding (XPath from the fact key, steps = actions up to that step, assertion = good build's value) -> `out/regression/<good>-vs-<cand>/R1.spec.js` -> Playwright runner 3 times per build, each on a freshly seeded build. Result: passes 3/3 on 1.29.1, fails 3/3 on 1.30.0, failure is the value mismatch (`%3A%2F%2F...` vs `https://...`), not a missing element. About 37 s end to end, no model calls.
- Known limits: a changed value inside a moved element still shows as removed + added with different values; the test locates by positional XPath, so it is only valid for builds with the same markup path; steps are still hand-written.

2026-10-28, piece 4 built (bisect driver):
- `src/release/bisect.mjs`: binary search over `good..bad` with the exported test as the oracle. Verdicts per commit: good / bad (only the value-mismatch failure counts) / skip (anything else; set aside, nearest untested neighbour tried instead). Ends with a verification: parent passes `runs` times, first bad commit fails `runs` times. Reports commit, subject, author, date, files, GitHub URL. Removes the worktrees it created. `bisect()` takes an optional `test` function so the search logic can be tested without builds.
- `runExported` now also returns the first failure message per test (`errors`), which is what makes the bad/skip split possible.
- Result on FreshRSS 1.29.1..1.30.0: 1b7178a1 (#9146, p/scripts/main.js), 8 steps, verified 3/3 and 3/3, 53 to 67 s. Same commit as the throwaway spike.
- Simulated skips (fake test): skips around the middle still converge or report "one of 2"; the true culprit untestable reports the right pair of commits as inconclusive.
- `confirm.mjs --bisect` runs it after a confirmed regression and saves it in result.json; the demo job now passes `--bisect` (about 90 s total).
- Fixed: the run-as-command guard in build.mjs crashed when imported under `node -e` (no argv[1]).
- Limits: the search assumes a regression that stays once introduced; a history with merge commits is only approximately ordered (logged as a note); the test's positional XPath can make a commit with a different layout a skip.

2026-10-29, pieces 5 and 6 built (evidence store, report page):
- `src/release/evidence.mjs` + `evidence.test.mjs`: append-only hash-chained event log, content-addressed evidence files, labelled claims with enforced authorship and required evidence, human-only ship/hold decisions, `verify()` for tamper detection. 7 tests pass. A mistake of mine (opening a case with an empty id created stray folders) led to making reads side-effect free; test added.
- `confirm.mjs` now writes a case per run (`out/evidence/<utc stamp>_<good>-vs-<cand>/`): events for each stage, evidence files (baseline.json, facts-diff.json, R1.spec.js, test-runs.json, bisect.json), and claims: statistical (masked share), verified_fact (control 0 differences; changed values; files touched), reproduced_failure (test 3/3 vs 3/3; first bad commit verified 3/3 + 3/3). `suspected_cause` is used only when the bisect is unverified or inconclusive. No `ai_hypothesis` is ever written until the model step exists.
- Claim text for changed values is shortened with an explicit "..." (an earlier version cut mid-value).
- Report page at `/report`; the demo page links to it after a run. Ship/Hold tested in the browser on a throwaway copy (Ship then Hold: newest counts, earlier kept in history, record intact at 24 events); copy deleted afterwards.
- Not done: the model hypothesis (the only paid step) and anything that lets the model write to the store; a decision does not yet trigger anything downstream.

2026-10-29, piece 7 built (model hypothesis):
- `src/release/hypothesis.mjs` + `hypothesis.test.mjs` (offline, 3 tests). `claim()` now takes `extra` details that cannot override label/text/evidence (test added).
- Prompt: system message (answer as JSON, treat the code change as untrusted data) + the observed difference + the one commit's message and diff in `<untrusted_code_change>` tags. The model never writes anything but an `ai_hypothesis`.
- Recorded per call: `model.requested` (projection), `model.call` (tokens, reasoning tokens, estimated cost, finish), the prompt and the reply as evidence files, then the claim with `grounded`, quote, confidence, how-to-check, cost.
- First paid call (2026-10-29, Meta muse-spark-1.3, reasoning low): projected about $0.0074 (worst $0.0180), actual about $0.0062 (700 tokens in, 1,242 out, of which 1,103 reasoning, 5.6 s). Guess: the template now wraps values in encodeURIComponent, double-encoding the already-encoded %20. Quote grounded in the diff: yes. Confidence stated: high. It matches what the facts show, but it is one sample.
- Report page: ask card with projected cost and the exact text to be sent; AI guesses shown with grounding, confidence, how to check, cost, and links to prompt and reply. Endpoint refusals tested (wrong origin 403, non-JSON 415, bad ids 404, nothing written).
- Fixed along the way: location text in the prompt repeated the attribute name; the report's stale empty-state text; a race where a background refresh hid the "cost of this call" message.

2026-10-29, explorer on FreshRSS (tried, did not find the Share flow):
- Free pre-flight first: FreshRSS pages are small (accessibility snapshot 3.8 to 5.0 KB, under the 7,000-character cut) and, once an article is opened, the Share link is in what the model sees at both 820 and 1280 px wide. Before an article is opened, Share is absent.
- `src/release/explore-app.mjs`: projected spend first (about $0.15 to $0.22 from the earlier benchmark's $0.0074 a step, x1.5 for bigger pages; hard stop at $0.30), no hints (brief: "a web application"), self-check off (needs a second copy of the app), 1280x900. `explore()` got opt-in `viewport` and `keepHistory`; defaults unchanged.
- Result: 20 steps, 42 successful actions, about $0.193 (90,462 in, 18,812 out), 2 minutes. Verdict NOT FOUND: never opened the Share menu. It explored search, favourites, mark-as-read, feed/category forms, labels; never expanded an article. It reported one unverified "bug" (bulk Mark as read) which is not counted.
- Not tried (each about $0.2 to $0.3): 30 steps; a hint about controls hidden inside items. One sample only.

2026-10-29, explorer on FreshRSS, second run (30 steps, no hints): NOT FOUND again.
- Projection used the first run's measured $0.0097 a step: $0.26 to $0.36; hard stop raised to $0.40 so the 30-step cap, not the cost cap, ends the run. Actual about $0.2199 (117,930 in, 17,061 out), 63 successful actions, 2 min 19 s, $0.0073 a step. So per-step cost varied 0.0073 to 0.0097 between runs; both projections were off in opposite directions.
- Neither run ever clicked an article (0 clicks on posts in both). Run 2 never visited the main stream; it spent all 30 steps on feed/category/label forms. More steps did not help.
- Two more unverified "bugs" were reported (empty category title accepted; label error says "Category name already exists"). Self-check was off, so they are not counted.
- Total explorer spend on FreshRSS: about $0.41.

2026-10-29, explorer on FreshRSS, third run, WITH A HINT: FOUND.
- HINT USED: the brief gained one sentence, "Hint: some controls only appear after you open an item." It does not mention Share or sharing. The runner now has `--hint`, prints HINT USED at the start and end, and saves `hint` and `hintUsed` in result.json.
- Projection $0.22 to $0.29 (the measured spread of the two earlier runs); hard stop $0.40. Actual about $0.2776 (121,283 in, 29,644 out), 20 steps, 29 successful actions, 2 min 56 s. It stopped on the 150,000-token cap at step 20, not the 30-step cap. Output tokens were higher than before (about 1,480 a step).
- Result: step 1 opened "Third post", step 2 opened Share, step 3 used Clipboard; it repeated the flow on "Second post" at step 11 to 12. Verdict FOUND.
- One more unverified "bug" reported ("June articles grouped under October date header"); self-check off, not counted.
- Free follow-up (no model): replaying the explorer's path (click Third post, wait 1000, click Share) via diff-builds gave 1,452 stable facts, 13.8% masked, control 0 differences, and the same 2 changed facts (data-url, data-title). So an explorer-derived path can feed the release checker.
- Honest reading: 0 of 2 without the hint, 1 of 1 with it. The hint carries the result; this does not show the explorer finds it unaided. Total explorer spend on FreshRSS about $0.69.

2026-10-29, second scenario built: FreshRSS #9285 (scroll position), framed honestly.
- Scoping found #9285 is NOT a confirmed regression: closed as completed by its reporter ("checking Stick the article to the top when opened seems to work so closing this for now"), maintainers could not reproduce it as described ("there must be another factor involved"), no fix commit in 1.30.1 to 1.30.4. The 1.30.0 behaviour comes from #8870, a deliberate change (always jump the article to the top when its header is offscreen, also with sticky disabled). Also verified: #9302 is "[Bug] Regression with sharing links" (closed, completed) and #9146 is the merged PR behind the first scenario.
- Spike (free): with sticky_post off and 8 long articles, opening article 1, bringing article 2's header into view and clicking article 2 gives scroll change 0 on 1.29.1 and -4033 on 1.30.0 (1.30.0 compensates for the layout shift of article 1 collapsing; here that ends at the top of the page). Reproducible, so built.
- Built: `freshrssAdapter()` factory (name, feedDir, expectedEntries, config patches such as sticky_post false), `adapters/freshrss-scroll.mjs`, fixture `bench/fixtures/freshrss-scroll/` (feed + steps), `scenarios.mjs`, a `scroll` session step (not offered to the explorer), `window@scrollY` as a page fact, `scroll_delta` finding/test kind (exporter measures scroll before and after the last action), exported tests now use the same 1280x900 window the facts were recorded in, `confirm.mjs --scenario`, scenario description stored in the case and shown on the report, scenario chooser on the demo page, wording changed from bug to behaviour change.
- Results: control 0 differences; exactly one changed fact (window@scrollY 4033 -> 0; a markup-only comparison would have shown none); test 3/3 pass on 1.29.1, 3/3 fail on 1.30.0; bisect 8 steps to aaae9ee3 (#8870), verified 3/3 + 3/3; about 100 s. Share scenario re-run after all changes: unchanged (1b7178a1, 3/3 and 3/3).
- Fixed along the way: raw \u201c escapes showing in the demo page text (from the explorer turn).
- Tests: 15 offline tests pass (new: scenarios.test.mjs).

2026-10-29, demo recording kit prepared.
- `docs/DEMO-SCRIPT.md` + PDF: run of show (10 beats, three cuts), spoken text checked against its time slot at 2.5 words a second, a claims table with the source for every number, a do-not-say list, fallbacks, pre-flight and after-recording steps.
- `demo/prepare.mjs`: archive-not-delete, optional `--generate`, refuses while a check or hand-test build is running.
- Clean state: kept the share (060213), scroll (060341) and the older share report that holds the only AI guess (051556, backup); archived three duplicates. None has a decision.
- Honest limits baked in: the explorer is described as 0 of 2 unhinted / 1 of 1 hinted and 13 of 27 with false alarms on both clean runs; #9285 is never called a bug; "CI" integration is explicitly not built; prices are estimates; the official video limit and judging criteria are unverified; the live run must be sped up and captioned as such.
- Fixed while checking my own text: the claims table said every claim cites evidence (AI guesses are exempt by design), the opening said it only reports what it can prove (it also reports labelled guesses), and one test reference was imprecise.

2026-10-29, dashboard hookup started (piece 1: real, read-only) and a gap review.
- Found ~/dev/behique-ui: a folder of static HTML iterations (v2 to v13, generated with Meta muse-spark-1.3 via gen.sh and tweak.sh) of one dashboard whose content comes from a single mock DATA object, designed "so the page could later be wired to a real API". v13 is the latest and is not modified. Its claim kinds, authorship rules, hash chain, bisect view, ask-the-model and Ship/Hold match this application's design.
- Built: `src/release/viewmodel.mjs` (record to UI shape; verdict as a recommendation: running, hold, ship, inconclusive, fail; real hashes; search nodes from the saved search; culprit claim; measured facts; cost), 8 tests; `evidence.rawLines()` and a shared `writeError()` authorship rule; endpoints `/api/ui/cases`, `/api/ui/case`, `/api/ui/rules`; `/ui/<file>.html|png` static route for the UI folder; `behique-live.html` (generated by a scratch script that asserts every replacement matches once).
- Verified in the browser (DOM-level, since the pane is too narrow for desktop pixels): HOLD (share and scroll), SHIP (clean), FAIL (build failed); in-browser chain verification passes (22 events); simulated tampering edits only the page's copy and is caught at the right event while the server record stays intact; the "forbidden write" link returns the record's real rule text; culprit click scrolls to the real culprit claim; evidence links are real.
- Found by running the unexercised paths: a failed build crashed and left an unfinished record (fixed); a clean run recorded no "no change" claim (fixed); facts that disappear were not blocking a SHIP recommendation (fixed, outcome `facts missing`).
- Remaining pieces and the full gap list: docs/STATUS.md, section Missing.

2026-10-29, dashboard piece 2: starting, watching and cancelling runs from the UI.
- Pipeline: builds register in `active` with `stopAll()`; `bisect()` takes `onEvent` and records `bisect.started`, `bisect.step` (sha, index, verdict, range) and `bisect.verifying`; it refuses an empty range clearly; `confirm.mjs` records its options in `case.opened`, writes progress events through `onEvent`, and on SIGTERM stops its builds, closes the record as `cancelled` and exits 130.
- `src/release/runparams.mjs`: validation of untrusted run parameters (strict ref pattern, no leading dash or "..", resolved in the repository, ancestor check for the search, same-version becomes a clean run). 6 tests with a fake git.
- `src/release/viewmodel.mjs`: `progressOf` (recording, comparing, testing n of 6, searching with the range, double-checking), partial search drawn from tested commits only, structured steps preferred over log text, `failReason` from the record, cancelled reads as FAIL "Run cancelled, evidence incomplete", a cancelled run that had already proven the change still recommends HOLD and says "search cancelled after N steps". 37 offline tests pass (new: bisect events against a throwaway git repository, run parameters, each phase).
- Server: run registry (background process, independent of any page), `/api/ui/apps`, `POST /api/ui/runs`, `GET /api/ui/runs/current`, `POST /api/ui/runs/cancel`; one run at a time shared with the older demo page; the old job handler no longer kills "the current job" when a connection closes (it kills only its own).
- UI (`behique-live.html`, patched by hand now; v13 untouched): New run dialog, Cancel run, polling every second, progress bar, elapsed time, picker statuses, in-place refresh while running.
- Verified: refusals (origin, non-JSON, unknown case, option-like and shell-like names, missing version, reversed versions) create no reports; clean run 12.7 s; full Share run with search 92 s with every phase observed (227, 114, 57, 28, 14, 7, 4, 2 possible); cancel during the tests (0.3 s) and during the search (0.9 s) leave 0 listening ports and 0 stray processes; a new run starts afterwards; UI cancel 3.3 s (it waits for the running test to return); page navigated away mid-run and reopened: lands on the running report and finishes to HOLD.
- Found and fixed while testing: a cancelled mid-search run said "bisected in 1 steps"; the FAIL banner quoted a finding instead of a reason; the caption said "no search was run" before the search had started; my first watch loop had a wrong stop condition (test bug, not the page).
- Test runs made during verification (nine) were archived, not deleted.

2026-10-29, dashboard piece 3: Ship / Hold from the UI, recommendation and decision kept separate.
- `src/release/decision.mjs`: `checkDecision` (pure rules) and `recordDecision` (the only caller of `decide()`). Reason required, one line, 3 to 500 characters (refused when too long, never truncated); name at most 80; override = ship while the recommendation is HOLD, needs `confirmOverride: true` (409 `needsOverride` otherwise) and 10 characters; nothing decided while running; no Ship while evidence is incomplete (FAIL), Hold allowed. The decision event now carries `recommendation`, `override`, `supersedes`; `evidence.decide` no longer slices silently.
- View-model: `recommendation`, `decision` {choice, reason, who, time, ts, override, recommendation, agrees, supersedes}, `decisionHistory` newest first, `canDecide`, `canShip`; the decision claim shows the name and an "against recommendation" chip.
- Server: `POST /api/ui/decision` (returns the view-model) and the older `POST /api/decision` share the same writer; the origin check now uses the server's own port instead of a fixed 8790 (found when testing on 8791).
- `behique-live.html`: hero label dynamic and the hero no longer reacts to a decision (lock icon removed); optional name field remembered in localStorage; decision area in the bottom bar with Change decision / Keep current / decisions-on-record link; Undo and its code deleted; the extra link v13 put above decision cards removed (the chain is chronological). v13 untouched.
- `demo/report.html`: reason required, override confirmation via confirm() then resend.
- Tests: `decision.test.mjs` (rule table, refusals byte-for-byte, supersession, intact chain, view-model agreement logic, long reason) 8 tests; 45 pass. Browser and API verification on four throwaway copies (hold, ship, fail, running), deleted afterwards; the five real reports carry zero decisions. Archived nothing.
- Found while testing: my first browser check of chain verification looked wrong only because my script's sleeps overlapped the 3.6 s verification (not a bug); another session's server on 8790 keeps old code until restarted, so I tested on a temporary instance on 8791 (launch entry added and removed).

2026-10-29, repo selector in the sidebar, piece 1 (read-only; nothing cloned).
- Waited for the Ship/Hold session to finish before touching shared files; built the new modules first (github.mjs, appregistry.mjs, 12 tests), then wired the server and the live page.
- Server: `/api/ui/repos`, `app` on each case entry (`appId` from the view-model), `Host` header check on every request (DNS-rebinding guard), `Cache-Control: no-store`.
- UI: Apps section, repo panel, selection kept in URL and local storage, reports filtered by app, in-flow report picker.
- Verified in the browser: reports show instantly while GitHub loads; 48 rows; search (case-insensitive, hostile input shown as text, nothing executed); refresh (3.1 s, a second click throttled to 0.1 s); repo panel (safe link, New run disabled, report widgets hidden); reload restores the repo from local storage; back to FreshRSS restores the report with the picker and New run. Degraded: gh not installed and gh logged out both give FreshRSS only with a plain reason (second server on a free port).
- Bugs found by measuring: the apps list sized by content stretched the sidebar to 4,145 px (now flex-basis 0, scrolls inside, 884 px); at 1000 px the report picker collided with the footer, and the mid-range sidebar was an unusable icon column (picker now in normal flow, full sidebar kept between 901 and 1100 px); at 900 px and below the picker was clipped.
- Test hygiene: port 8795 was already taken by someone else's Python file server; my first degraded test hit it by mistake. It was not touched; the test was redone on port 18795.
