# Where Meta's model is used, what it costs, and what a judge sees

Written 2026-10-31 for the Meta Global AI Developer Hackathon submission (indie track, judged on creativity, technical ambition and whether it works; submissions due Nov 4, 9:00 PM Eastern). Every figure below is from the code, the evidence records or `docs/STATUS.md`; the price table is Meta's published one ($1.25 input, $4.25 output per million tokens, matched against dev.meta.ai on 2026-10-29).

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

- Code: `src/senses/vision.mjs` (the only model call among the senses); `pixels.mjs`, `hands.mjs`, `canvas-qa.mjs` are code.
- Call: one screenshot at device scale 2, viewport only; the model returns the controls it sees with coordinates as 0 to 1 decimals. About 4,000 tokens in and 1,300 out, about $0.01 a call. Measured on Spark 1.3 over 139 calls (about $1.34): points to within about 1 pixel, says "not found" honestly (0 invented in 59 queries), fails on tall full-page screenshots.
- Cost of the scored runs: canvas fixture 3 calls about $0.03 per model; Music Blocks v3.8.0 vs master 4 calls about $0.07.
- What a judge sees: the `/senses` explainer page and the `/watch` page on the demo server (a saved or live run; the live run on the test app makes no model calls); the Music Blocks results in `docs/canvas-senses-plan.md`. Not yet in the main check (checklist item 12). Only public apps are screenshotted to a model.

### 4. The explorer: a model drives a browser to find bugs on its own

- Code: `src/explorer.mjs`, `src/release/explore-app.mjs`, `bench.mjs`.
- Call: each step sends a full-page screenshot, the accessibility tree and the network, dialog and console events since the last action; up to 20 steps, 150,000 tokens, a cost cap. About $0.0073 to $0.0097 a step; a 20-step run about $0.19.
- What a judge sees: the bench on the todo app with planted bugs (`bench/final-results.json`, `bench/baseline*.html`). Not in the dashboard. Unaided it found 0 of 2 flows on FreshRSS, which is why the release pipeline uses a read-only crawler with no model instead (checklist item 11: connect it or retire it from the pitch).

## Build-time use: Spark wrote modules from specs

`tools/muse-build/` had Muse Spark 1.3 build modules from written specs (`docs/specs/`), each with its tests, in rounds until the tests passed: the Music Blocks parts (about $0.57), the findings, regions and shots modules (about $0.25), the seven wave-3 modules including the crawler and the repair loop (about $0.55), the three wave-2 UI modules (about $0.17). About $1.5 in all. `docs/specs/musicblocks/BUILD-LOG.md` and `docs/overnight-log.md` record what Muse wrote and what a person changed; every module needed hand fixes, and one review found a real bug (the onboarding proposal was sending different text from the text previewed). Muse Code, the coding agent, was also used on this repository.

## Totals

| | |
|---|---|
| Spent so far | about $38 to $40 of about $250 in credits (Meta Model API $150, Baseten $100; Modal and Fireworks unconfirmed) |
| Of which runtime product calls | under $1 (set-up proposals about $0.25 across the baselines, ask-why once for real) |
| Canvas senses | about $2.0 of a $10 allowance |
| Explorer bench | the rest, mostly the 27-case bench runs on two models |

## What a judge sees today, plainly

- In the dashboard: Spark proposes the app profile (visible, with the text and price first) and explains the culprit on request (visible, with the text and price first, labelled a guess).
- In the report page: the AI Hypothesis claim with model, quote check and cost, in the same chain as the tests.
- In the command and the GitHub Action: only with `--explain` (action input `explain: true` with `bisect: true` and a `meta-api-key` secret). Without it the CI path makes no model call. With it, after the bisect names a first bad change, one Muse Spark 1.3 call (about $0.008) is added to the result and the pull request comment, labelled "AI guess, not proof", with its quoted line checked against the diff and its cost; the verdict and exit code never depend on it (`src/release/cli/explain.mjs`, built 2026-11-02). It sends the observed difference and that one commit's message and diff to Meta's standard (not contributor) model; on a private repository that is code leaving the runner, which is why it is opt-in. Checked once on a scratch copy of the VitePress rc.10 vs rc.12 case: the guess named the inert binding in the culprit commit 070fc0a, quote found in the diff, $0.0077.
- On the demo server: the canvas senses pages.

## Options for the submission

1. **Say the principle out loud and show the three roles.** The pitch is "Spark proposes, code proves, a person decides": set-up (Spark reads the repo and proposes how to run it), explain (Spark reads one commit and says why), see (Spark reads a canvas). Plus: Spark built about a third of the modules from specs, with a log of every hand fix. Theme: Build for Your World (release go/no-go is the author's own domain, fourteen years of QA).
2. **Put the explanation in the CI path** (half a day): `behique check --explain` makes the one ask-why call after a bisect names a culprit, and the pull request comment carries the hypothesis with the model's name, its quoted line and the cost. Then the Meta model is visible where releases happen, at about $0.006 a pull request, and the comment still says it is a guess.
3. **Show set-up and ask-why on screen in the video**, not only the crawl and the bisect.

Not recommended: putting a model into the verification loop to look more on-theme. The whole claim of the product is that the verdict is reproducible without one.
