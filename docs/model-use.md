# Where Meta's model is used, what it costs, and what a judge sees

Written 2026-10-31, updated 2026-11-03 (wave 5: the AI stages in the command, sections 5 to 9) for the Meta Global AI Developer Hackathon submission (indie track, judged on creativity, technical ambition and whether it works; submissions due Nov 4, 9:00 PM Eastern). Every figure below is from the code, the evidence records or `docs/STATUS.md`; the price table is Meta's published one ($1.25 input, $4.25 output per million tokens, matched against dev.meta.ai on 2026-10-29).

## Models and providers (`src/llm.mjs`)

| Provider | Model | Used for |
|---|---|---|
| `meta` (Meta Model API) | `muse-spark-1.3`, the standard variant ("not used to improve our products") | every call the product makes from the dashboard; the canvas senses; the explorer by default |
| `baseten` | `meta-models/muse-spark-open-1026` (open weights) | the canvas bench and the explorer bench, as the second model |

Every call goes through one client with token and cost accounting; every call made from an evidence case is recorded as a `model.call` event with the model, provider, tokens, time and estimated cost.

## The principle

The verification loop has no model in it. A model proposes; code verifies; a person approves. That is a design choice, not a gap: a claim in a report is a test that ran, a diff that was recorded, or a decision a person signed, and the one kind of claim a model makes is labelled `ai_hypothesis` and called a guess on the page. The model is used where proposing is the right job: how to run an app it has never seen, why a proven regression happened, and what a canvas drawing contains.

## Runtime call sites

### 1. Set up an app: the model proposes how to run a repository

- Code: `src/release/onboard/propose.mjs`, `onboard.mjs` (`defaultAsk`), `repair.mjs`; dashboard flow `src/release/ui/onboard-flow.mjs`.
- Call: Spark 1.3, reasoning low, 4,000 output tokens at most. Sent: the facts Behique read from the repository without running anything (package manager, frameworks, workspaces, env templates, compose, static roots) plus the skill text in `docs/skills/onboard-app.md`. Not sent: source code.
- Cost: about $0.008 per proposal. The repair loop (propose, verify by building, feed the failure back, at most 3 rounds, cost cap) set up 6 real repositories for about $0.10 in all; the loop added umami's Postgres sidecar on its own.
- What a judge sees: in the dashboard, "Set up an app" shows the exact text that would be sent, word for word, and the projected cost before anything is sent; then "The model proposed this profile. It is a proposal, not a result"; then Behique builds both versions and takes pictures to verify it, and saves the profile only if that passed. Each command the proposal wants to run is approved by the person.

### 2. Ask the model why: one guess about the culprit commit

- Code: `src/release/hypothesis.mjs` (the call), `src/release/ask.mjs` (the guard), dashboard card "Ask the model why".
- Call: Spark 1.3, reasoning low, 4,000 output tokens at most, 3 per case at most. Sent: the observed difference (the recorded values that changed) and the one commit's message and diff, capped at 12,000 characters. Not sent: the repository, screenshots, the exploration.
- Cost: measured $0.0062 (692 prompt, 1,256 completion tokens, 7.6 s). Shown before sending as "about $0.007 expected, $0.018 worst case".
- What a judge sees: the card shows "n of 3 guesses used" and what has been spent; "Review what would be sent" shows the full text, the model and provider ("To muse-spark-1.3 (meta)"), the projected cost and a fingerprint; "Send and spend about $x" posts that fingerprint, and the server refuses unless it matches the text it would send right now. The answer appears in the evidence chain as an AI Hypothesis claim with the model's name, its quoted line (checked by code against the change: "found" or "NOT found"), how to check it, and the cost. It is a guess, never proof, and it cannot change the recommendation.

### 3. Canvas senses: the model lists the controls in a screenshot

- Code: `src/senses/vision.mjs` (the only model call among the senses); `pixels.mjs`, `hands.mjs`, `canvas-qa.mjs` are code. In the main check: `src/release/cli/canvas-senses.mjs` (below, section 9).
- Call: one screenshot at device scale 2, viewport only; the model returns the controls it sees with coordinates as 0 to 1 decimals. About 4,000 to 6,000 tokens in and 1,300 to 2,000 out, about $0.01 to $0.02 a call. Measured on Spark 1.3 over 139 calls (about $1.34): points to within about 1 pixel, says "not found" honestly (0 invented in 59 queries), fails on tall full-page screenshots.
- Cost of the scored runs: canvas fixture 3 calls about $0.03 per model; Music Blocks v3.8.0 vs master 4 calls about $0.07.
- What a judge sees: the `/senses` explainer page and the `/watch` page on the demo server (a saved or live run; the live run on the test app makes no model calls); the Music Blocks results in `docs/canvas-senses-plan.md`; and, since 2026-11-03, the "AI guesses" section of a `behique check ... --ai-canvas` result. Only public apps are screenshotted to a model.

### 4. The explorer: a model drives a browser to find bugs on its own

- Code: `src/explorer.mjs`, `src/release/explore-app.mjs`, `bench.mjs`.
- Call: each step sends a full-page screenshot, the accessibility tree and the network, dialog and console events since the last action; up to 20 steps, 150,000 tokens, a cost cap. About $0.0073 to $0.0097 a step; a 20-step run about $0.19.
- What a judge sees: the bench on the todo app with planted bugs (`bench/final-results.json`, `bench/baseline*.html`). Not in the dashboard. Unaided it found 0 of 2 flows on FreshRSS, which is why the release pipeline uses a read-only crawler with no model instead (checklist item 11: connect it or retire it from the pitch).

### 5. AI-written tests (`--ai-tests`): the model writes the test, code decides whether it stays

- Code: `src/release/aitest.mjs`, run through `src/release/cli/ai-stages.mjs`.
- Call: Spark 1.3, reasoning low, up to 6,000 output tokens, for each proven difference (at most 5 per case) plus at most one repair. Sent: the observed difference, the steps that reach it, nearby recorded facts and the code-generated test as a reference. Not sent: the repository.
- What code does: runs the model's test on fresh builds of both versions, 3 runs each, with the same judge as the generated tests (`judgeFindings`); it stays only if it passes every run on the good version and fails every run on the candidate. The others are dropped with the reason.
- Measured (2026-11-03, VitePress rc.10 vs rc.12, sandbox on hardac2): 5 proven differences, 5 tests written, all 5 kept (each passes 3 of 3 on the good version and fails 3 of 3 on the candidate, fresh builds); 5 calls, about $0.028 and $0.032 in two runs. One case, one app: no claim about how often a written test survives.

### 6. AI-proposed click paths (`--ai-flows`): the model proposes flows the read-only crawl cannot reach

- Code: `src/release/crawl/propose-flows.mjs`.
- Call: Spark 1.3, reasoning low, up to 8,000 output tokens, one call. Sent: the accessibility tree and visible text of pages the crawl already recorded (no screenshots, no source code).
- What code does: validates every step against a closed schema, refuses unsafe steps (destructive verbs, other hosts, uploads, passwords, writes in a read-only profile), replays each flow 3 times on the good version and keeps it only if it completes every time with the same trace. A kept flow has not been run on the candidate yet; it is a proposal for the next check, not a finding.
- Measured (VitePress, three runs): 6, 5 and 3 flows proposed in one call each (about $0.016 to $0.020); 5 of 6, 4 of 5 and 3 of 3 replayed identically 3 of 3 times on the good version; the dropped ones failed on a text that was not visible (a search dialog). None has been run on the candidate yet.

### 7. AI description of the pictures (`--ai-describe`): the model says what differs in the screenshots

- Code: `src/release/visual/describe.mjs`.
- Call: Spark 1.3, reasoning low, up to 6,000 output tokens, one call per good/candidate screenshot pair that differs above the noise floor (at most 4 pairs). Sent: the two pictures (a page view and crops around the largest differing regions). Screenshots of the app leave the machine, which is why it is opt-in.
- What code does: maps each described place back to the pixels and keeps the description only where the pixels really changed above the floor (and agree with "moved", "added", "removed", "recolored"); pixels no verified description covers are listed as unexplained.
- Measured: Hoppscotch settings screen, 1 call about $0.008, 2 descriptions, both on pixels that really changed and both agreeing with the kind of change claimed (an added toggle row, a moved row); VitePress rc.10 vs rc.12, 2 calls about $0.016, 5 descriptions on changed pixels (a version label, a bun tab added, two third-party ad cards that changed; for three of them the kind of change was not measured). "Verified" here means the place changed, not that the description is right.

### 8. AI ranking of unproven differences (`--ai-triage`): the model orders what a person has to look at

- Code: `src/release/triage.mjs`.
- Call: Spark 1.3, reasoning low, one call. Sent: the differences that were seen but not proven by a test (the REVIEW pile). Not sent: screenshots, source.
- What code does: accepts only valid JSON with real finding ids, each once; ids the model leaves out are appended as "not ranked"; the ranking is compared with the deterministic notice class and the agreement is reported. Nothing reorders the findings or the verdict.
- Measured: the Music Blocks case (3 differences that failed on both versions), 1 call about $0.003, a ranking of 3 with one-line reasons; every item shows as unverified. Nothing was run on the two runs that had no REVIEW pile ("nothing to rank", no call).

### 9. How the stages sit in the command, and canvas senses in the main check

- Code: `src/release/cli/ai-stages.mjs` (the seam), `src/release/cli/canvas-senses.mjs`, `bin/behique.mjs` (`check --ai ...`, `ai <caseId> ...`), `action.yml` inputs.
- The seam: each stage module is loaded with a guarded dynamic `import()`; an absent or broken module is a skipped line, not a crash. Stages run only after the recommendation and exit code are computed. One cap (`--ai-budget`, default $0.25, `--explain` counted) is checked before every call; every call is recorded in the case as a `model.call` event, the stage's output as `ai-<stage>.json`, one `ai.stage` event per stage. The result gets a section titled "AI guesses (a model wrote these; none of it changes the verdict or the exit code)" with the model, the stage's cost and the verification status of each item. A test (`ai-stages.test.mjs`, "PROOF") compares the recommendation, exit code, summary, counts and findings with and without the flags.
- Canvas senses (`--ai-canvas`, not part of `--ai`): for an app with regions or anchors in its profile (Music Blocks), after the verdict: builds both versions, takes ONE settled screenshot of the good version (2560 by 1600), one Spark call lists the controls, code clicks up to 10 clickable ones on each version twice in fresh browsers (external hosts blocked) and reports a control only when its two runs agree on each version and the versions differ. Refused unless GitHub says, without a login, that the repository is public. The projected cost is logged before the call (about $0.016). Measured (Music Blocks v3.8.0 vs master, three real calls, $0.014 to $0.018 each): the model listed 0 clickable controls once, then 51 and 46 controls (about 10 to 15 buttons or icons, the rest cards or sliders); 10 were clicked, 8 and 9 gave a steady result on both versions, none reacted differently on master. So the stage ran end to end and found no difference; it has not been shown to find a regression in the main check. The same check run twice gave HOLD and then SHIP with 99.9% of the facts masked, which is a property of the pipeline on an animated canvas, not of the senses. The first end-to-end `behique check` on Music Blocks (checklist item 12 said it had not been run); samples: `docs/pr-comment-sample-canvas.md`.

## Build-time use: Spark wrote modules from specs

`tools/muse-build/` had Muse Spark 1.3 build modules from written specs (`docs/specs/`), each with its tests, in rounds until the tests passed: the Music Blocks parts (about $0.57), the findings, regions and shots modules (about $0.25), the seven wave-3 modules including the crawler and the repair loop (about $0.55), the three wave-2 UI modules (about $0.17). About $1.5 in all. `docs/specs/musicblocks/BUILD-LOG.md` and `docs/overnight-log.md` record what Muse wrote and what a person changed; every module needed hand fixes, and one review found a real bug (the onboarding proposal was sending different text from the text previewed). Muse Code, the coding agent, was also used on this repository.

## Totals

| | |
|---|---|
| Spent so far | about $38 to $40 of about $250 in credits (Meta Model API $150, Baseten $100; Modal and Fireworks unconfirmed) |
| Of which runtime product calls | under $1 (set-up proposals about $0.25 across the baselines, ask-why once for real) |
| Canvas senses | about $2.0 of a $10 allowance |
| Wave 5 (2026-11-03): the AI stages, real runs on VitePress, Hoppscotch, Music Blocks | about $0.19 in all (the cases' `model.call` events: tests about $0.06, click paths about $0.05, picture descriptions about $0.02, ranking and canvas senses about $0.05, one ask-why $0.007) |
| Explorer bench | the rest, mostly the 27-case bench runs on two models |

## What a judge sees today, plainly

- In the dashboard: Spark proposes the app profile (visible, with the text and price first) and explains the culprit on request (visible, with the text and price first, labelled a guess).
- In the report page: the AI Hypothesis claim with model, quote check and cost, in the same chain as the tests.
- In the command and the GitHub Action: a pull request comment with the "AI guesses" section, from `--explain` and the `--ai*` flags (sections 5 to 9; samples `docs/pr-comment-sample-ai.md`, `docs/pr-comment-sample-canvas.md`). The paragraph below is about `--explain` alone: only with `--explain` (action input `explain: true` with `bisect: true` and a `meta-api-key` secret). Without it the CI path makes no model call. With it, after the bisect names a first bad change, one Muse Spark 1.3 call (about $0.008) is added to the result and the pull request comment, labelled "AI guess, not proof", with its quoted line checked against the diff and its cost; the verdict and exit code never depend on it (`src/release/cli/explain.mjs`, built 2026-11-02). It sends the observed difference and that one commit's message and diff to Meta's standard (not contributor) model; on a private repository that is code leaving the runner, which is why it is opt-in. Checked once on a scratch copy of the VitePress rc.10 vs rc.12 case: the guess named the inert binding in the culprit commit 070fc0a, quote found in the diff, $0.0077.
- On the demo server: the canvas senses pages.

## Options for the submission

1. **Say the principle out loud and show the three roles.** The pitch is "Spark proposes, code proves, a person decides": set-up (Spark reads the repo and proposes how to run it), explain (Spark reads one commit and says why), see (Spark reads a canvas). Plus: Spark built about a third of the modules from specs, with a log of every hand fix. Theme: Build for Your World (release go/no-go is the author's own domain, fourteen years of QA).
2. **Put the explanation in the CI path** (done 2026-11-02, extended 2026-11-03 with the four AI stages and the canvas senses): `behique check --explain` makes the one ask-why call after a bisect names a culprit, and the pull request comment carries the hypothesis with the model's name, its quoted line and the cost. Then the Meta model is visible where releases happen, at about $0.006 a pull request, and the comment still says it is a guess.
3. **Show set-up and ask-why on screen in the video**, not only the crawl and the bisect.

Not recommended: putting a model into the verification loop to look more on-theme. The whole claim of the product is that the verdict is reproducible without one.
