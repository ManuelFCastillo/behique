# Overnight log (2026-10-30)

Budget: hard stop at $20 of model spend (you said $20 to $25). Nothing is committed or pushed. Public repos only.

## Phase 0 (done as far as it could go)
Six public repos cloned as partial clones into `~/dev/behique-apps` (html5-boilerplate, tailwind-nextjs-starter-blog, excalidraw, vitepress, umami, todomvc). Proposals collected twice ($0.15).
The verification run was blocked by the safety check (it would install dependencies and start dev servers from third-party repos unattended), so nothing from those repos was executed. I did not try to get around that.
Findings from the proposals alone are in `docs/onboarding-baseline.md`, with the two commands ready for when you decide how to run them.

## Phase 1 (done, 164 onboard tests)
Built by Muse from specs (`docs/specs/wave3`): `inspect-more.mjs` (workspaces, package manager, frameworks, .env.example, compose, static roots, read without running anything), `toolchain.mjs` (package manager detection, installs with scripts disabled, corepack shims, safe env from templates), `repair.mjs` (propose, verify, feed failures back, 3 rounds, cost cap, approval for any new command).
Reviewed by hand: fixed a test design flaw, a wrong ANSI pattern, replies that only reword the notes, hardened env classification, resolved two contradictory tests. By hand: profile v2 (`serve.env`, `serve.root`, static `install`, `allowScripts`), the adapter (env, shims, scripts disabled, readiness settings), `build.mjs` (keeps the app's last output, fails fast when the server dies, stops the whole process tree), `verify.mjs` (logs on failing checks), `inspect.mjs` (adds `more`), the skill text.

## Phase 2 (done, crawl proven on FreshRSS)
Built by Muse (`docs/specs/wave3/16..18`): `crawl/enumerate.mjs` (what is safe and useful to click), `crawl/plan.mjs` (breadth-first bookkeeping), `crawl/run.mjs` (the browser crawler: read-only, no request but GET, nothing typed, dialogs dismissed, a fresh browser per path).
Changed by hand after reading them: the state fingerprint is now one short hash and ignores generated query values (FreshRSS puts a random `rid` in every URL, which made every visit a new page); elements that only look clickable (pointer cursor, no role) are found; candidates are taken round-robin across roles so thirty links cannot push out every button; a long text is content, not a label, so common words in it ("post", "send") no longer mark a list row risky; controls a click just revealed are explored first.
By hand: `crawl/cli.mjs` (`node src/release/crawl/cli.mjs <app> [ref]` writes steps), `check-app.mjs` (crawl then compare, one command), `confirm.mjs --app <profile> --steps <file>`, `facts.mjs` (a step that cannot be performed is recorded as a fact instead of crashing the check), `findings.mjs` (a test replays only its own flow), the server (`kind: "crawl"` runs) and the dashboard (a "Check" choice in New run).
**Result:** with NO hand-written steps, `check-app.mjs freshrss 1.29.1 1.30.0 --bisect` crawled 1.29.1 (61 s, 30 page states, 37 steps), confirmed the same two changed facts as the hand-written Share case (`data-url` and `data-title`, 3 of 3 and 3 of 3), and bisected to `1b7178a` in 8 steps, verified 3 of 3 and 3 of 3. Started from the dashboard (New run, Check: Behaviour) the same comparison gave HOLD with 2 reproduced changes and a screenshot.
Two failed attempts on the way, both honest: the first run called both findings `fails_both` (the test failed on both versions) because recorded steps shared state across flows (a filter set in an earlier flow changed which article was first); fixed by replaying each flow alone, read-only, with cookies and storage cleared at each flow boundary.

## Phase 5: cloning (built, wired, only previewed)
`ui/clone-flow.mjs` built by Muse and reviewed: preview shows the exact `git clone` command and size, the clone runs only with the preview's fingerprint. From the page only repos in the connected GitHub account can be cloned (the GitHub reader takes no input from the page). Checked by preview and by the refusals (stale fingerprint, name outside the list, bad name); NO repository was cloned through it.

## Not done tonight
Phase 3 (seed data), Phase 4 (container isolation, would need OrbStack started and your say-so), the real verification of the six repos, and a real repair of a failing repo.

## Spend (estimated)
- Proposals: about $0.15
- Muse builds: Phase 1 $0.29, Phase 2 $0.22, clone flow $0.04, total about $0.55
- Total tonight: about $0.75 of the $20 limit
