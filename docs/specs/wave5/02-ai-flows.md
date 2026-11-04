# Wave 5, feature 2: the model proposes flows, code replays them

Written 2026-11-03. Code: `src/release/crawl/propose-flows.mjs`, tests: `src/release/crawl/propose-flows.test.mjs` (16 tests, all pass; the whole `crawl/` folder is 122 of 122).

## What it is

The crawler (`crawl/run.mjs`) is read-only: it follows single clicks and types nothing, so it cannot reach "open a menu, then pick an item" or "type in the field, press Enter". `propose-flows.mjs` adds that, with the rule the product is built on: **a model proposes, code verifies, a person approves.**

1. Muse Spark 1.3 (`llm.chat('meta', ...)`) is shown the accessibility tree and visible text of pages the crawl already recorded. No screenshots, no source code. It answers with flows as structured JSON steps and a one-line purpose. It never touches the browser.
2. Code checks every step against a closed schema (`validateSteps`): click, fill, press, check, uncheck, select, hover, goto, expect_visible; a role plus exact name (or a text); 2 to 6 actions; at least one `expect_visible`, and it must be last.
3. Code refuses unsafe flows (`safetyCheck`): destructive verbs (delete, remove, clear, reset, pay, buy, send, log out, upload, install and so on), file choosers, password and card fields, typed links or emails, paths that leave the site or look like logout or delete, and, in a read-only profile, write verbs (save, submit, publish ...) as the first word of a control. Replays also run with the Session's own read-only rule (only GET and HEAD get through, other hosts refused), so nothing the model said can change the app.
4. Code replays each remaining flow on the GOOD version, 3 times, each in a fresh browser. A flow is kept only if every replay completes, every `expect_visible` becomes visible, the page ends each step in the same state in all 3 replays (the crawl's state key plus a hash of all visible text), the expectations were not already true before the first action, and no step left the app.
5. Survivors are emitted as crawl-plan steps, `{type, selector, label}` with a `goto` start, the shape `confirm.mjs --steps` reads. Rejected flows stay in the result with `droppedBecause`.

The result is labelled `ai_hypothesis` everywhere. The verdict (SHIP, HOLD, REVIEW) and the exit code do not read it; the only thing it produces is extra steps for the existing, model-free fact recording and comparison.

## API

```js
import { run, combinePlans } from './crawl/propose-flows.mjs'

const r = await run({
  caseDir,            // out/evidence/<case>/ : its case.opened event holds the crawl plan. Or pass steps: [...] instead.
  base,               // URL the GOOD version is running at, with its base path (http://127.0.0.1:8300/i for FreshRSS)
  ask,                // (messages, { maxTokens, reasoning }) => { text, usage: { promptTokens, completionTokens } }; default Muse Spark 1.3
  maxUsd: 0.25,       // cap across all calls; a call whose prompt plus minimum answer would not fit is not made
  // optional: page, pages, startPath, login, readOnly (true), replays (3), maxFlows (6), rounds (1 or 2),
  //           maxPages (8), reasoning ('low'), maxTokens (8000), variant ('A' | 'B'), confirm, evidence, dryRun, log
})
```

Returns

```js
{ label: 'ai_hypothesis', model, provider,
  items: [{ flowId, round, purpose, steps, plan, replay: { runs, stable, passed, blockedWrites }, droppedBecause? }],
  plan,                // combinePlans(items): every kept flow as crawl-plan steps, one list
  calls: [{ model, provider, promptTokens, completionTokens, reasoningTokens, usd, reasoning, round, ms, finish }],
  spentUsd, notes: [],
  sent, fingerprint, estimate, sentRounds }   // the exact text, its fingerprint and projected cost
```

Pure helpers exported for tests: `validateSteps`, `safetyCheck`, `parseProposal`, `buildMessages`, `compactAria`, `estimate`, `fingerprint`, `selectorOf`, `actionOf`, `planOf`, `combinePlans`, `splitPlan`, `judgeRuns`. Also `capturePages`, `captureAfter`, `replayOnce`, `readCase`, `defaultAsk`.

Guard rails that follow `hypothesis.mjs` and `ask.mjs`:

- `run({ dryRun: true })` calls nothing and returns `sent` (the exact messages), `estimate` (expected and worst-case dollars) and `fingerprint`. `run({ confirm: fingerprint })` refuses to send if the text has changed since a person reviewed it. Only round 1 can be pre-approved this way; round 2's text depends on round 1's results and is returned in `sentRounds`.
- `evidence: openCase(dir)` records, as `hypothesis.mjs` does, an artifact with the prompt, a `model.requested` event, a `model.call` event (provider, model, tokens, estUsd, ms, finish) and an artifact with the raw reply. Nothing is written unless `evidence` is passed. No claim is written; the wiring decides whether to add one (it can only be an `ai_hypothesis`).
- Page text is wrapped in `<untrusted_page>` and the system prompt says to ignore instructions inside it; independent of that, every step is schema-checked and safety-filtered, so injected text cannot cause a destructive action.
- Cost uses the project's own estimate (`$1.25 / $4.25` per million tokens in/out, unverified third-party price), same as everywhere else.

## What replay needs

A running copy of the good version at `base`, because the case directory stores hashed facts, not page text or trees. Pages are read by replaying the recorded crawl plan in a fresh browser (`capturePages`). In a real check this is free: `crawl/cli.mjs` already has the good version up while it crawls.

## How to wire it in (not done, other agent owns it)

In `crawl/cli.mjs`, right after `crawlApp(...)` and before the steps file is written, while `build.base` is still up:

```js
import { run as proposeFlows } from './propose-flows.mjs'
import { combinePlans } from './propose-flows.mjs'
const ai = await proposeFlows({ steps: found.steps, base: build.base, startPath: options.startPath ?? '/', login, readOnly: true, rounds: 2, maxUsd: 0.25, variant: 'A', reasoning: 'low' })
found.steps = [...found.steps, ...ai.plan]                       // same shape; the recorder and compare run them on both versions unchanged
// write ai.items (with droppedBecause) next to the crawl file, and ai.calls/ai.spentUsd into the case
```

Then `evidence.openCase(...)` once the case exists: pass `evidence` or replay `ai.calls` as `model.call` events. Make it opt-in (`behique check ... --ai-flows`), as `--explain` is: it sends page text to Meta's standard model. In the dashboard: call with `dryRun: true`, show `sent`, `estimate` and the label "AI guess, not proof", and send with `confirm: fingerprint`. Pass the profile's `login` and keep `readOnly: true` unless the profile says otherwise. Because kept flows begin with `goto <startPath>` they pass through `withLogin` like crawl flows.

## Measured results (2026-11-03, live, Muse Spark 1.3, real apps)

Apps: FreshRSS 1.29.1 (local PHP, the built-in adapter), Docusaurus `cacb973` (Docker, OrbStack, cached image `bq-cache:docusaurus-cacb973...`), TodoMVC Backbone example from `v1.4` (static). Pages shown to the model: the crawl's own recorded plans (`out/crawl/*.steps.json`), up to 8 distinct page states, as a compact tree (start page in full, later pages as "controls not on the start page"). Prompt about 4,000 tokens for FreshRSS and Docusaurus, 800 to 950 for TodoMVC. Every number is from a run; the per-run JSON is in `out/ai-flows/`.

| App | Config (variant, reasoning, rounds) | Runs | Proposed per run | Stable per run (3 of 3) | Cost per run |
|---|---|---|---|---|---|
| FreshRSS | A, low, 1 | 6 | 5.2 | 3.0 (1 to 5) | $0.021 |
| FreshRSS | B, low, 1 | 4 | 5.2 | 4.0 (3 to 5) | $0.022 |
| FreshRSS | A, minimal, 1 | 4 | 3.8 | 2.5 | $0.013 |
| FreshRSS | B, minimal, 1 | 3 | 5.0 | 2.7 | $0.013 |
| FreshRSS | A, medium, 1 | 1 | 6 | 5 | $0.040 |
| FreshRSS | B, medium, 1 | 1 | 5 | 3 | $0.028 |
| FreshRSS | A, low, 2 rounds | 1 | 10 | 3 | $0.043 |
| FreshRSS | A, medium, 2 rounds | 1 | 11 | 4 | $0.084 |
| Docusaurus | A, low, 1 | 4 | 4.8 | 2.2 | $0.018 |
| Docusaurus | B, low, 1 | 4 | 4.8 | 3.0 | $0.019 |
| Docusaurus | A / B, minimal, 1 | 3 + 3 | 3.7 / 3.0 | 2.7 / 2.0 | $0.012 / $0.011 |
| Docusaurus | A, medium, 1 | 1 | 6 | 4 | $0.030 |
| TodoMVC | A / B, low, 1 round | 1 + 1 | 1 | 1 | $0.008 / $0.006 |
| TodoMVC | A / B, low, 2 rounds | 1 + 1 | 5 / 4 | 5 / 4 (0 dropped) | $0.018 each |

Rejections (code, not the model): FreshRSS 33 flows: 13 a named control was not clickable or not found, 11 the expectation was already true before any action, 5 the expected text never appeared, 4 a "Mark as read" click whose POST the read-only rule refused so the navigation failed. Docusaurus 25 flows: 18 expectation already true, 5 refused by the safety filter (all the same false positive: a card whose text says "How to install Docusaurus", filtered on the verb "install"; it is conservative on purpose), 2 expectation never appeared. TodoMVC 0.

Findings:

- **Reasoning level.** `low` is the best value: about $0.02 and 30 s. `minimal` is cheaper and a little thinner (fewer flows). `medium` costs about twice as much (60 to 80 s) for slightly more flows. `high` is useless here: with an output cap of 12,000 tokens it spent 11,998 on reasoning and returned nothing ($0.056). Muse Spark spends 85 to 95 percent of its output on reasoning at every level, so the cost is mostly thinking.
- **Prompt variant.** B (a worked example in the prompt) gave slightly more stable flows on FreshRSS and Docusaurus at `low` (4.0 vs 3.0, 3.0 vs 2.2) but the samples are 4 to 6 runs with a spread of 1 to 5 per run on FreshRSS; do not read it as proven. Recommended default: variant B, reasoning low. (The code default is A, `LIMITS.reasoning` is `low`; set `variant: 'B'` in the wiring.)
- **Rounds.** Round 2 (shows the page each kept flow ended in, asks to continue from there) is what makes a form-driven app work: TodoMVC goes from 1 stable flow (just "add a todo", the only control the empty page offers) to 4 or 5 (filter Active/Completed, mark all complete, add two). On FreshRSS it added little (3 vs 3 at low, 4 vs 5 at medium). It costs one more call, about $0.017 to $0.04.
- **FreshRSS Share path.** The saved read-only crawl already contains `clickable "Spike Feed Third post" > link "Share"` (the premise that it missed the Share path does not hold for that saved crawl, which had a 40-path budget). What the model adds is the same path with an expectation: "click the article, click Share, expect Clipboard / My labels / the article body". A kept flow that clicks the article and then the Share link was found in 7 of 19 one-round FreshRSS runs (36 percent) and in the 2-round A/low run. The model often tried it and lost it to the model's own mistakes: it copied the emoji in the link name wrongly (`♉️ Share` for `♻️ Share`), or expected text that was already visible.
- **Does a kept flow find the regression?** Yes, end to end. I took the 5 flows kept in one run (15 plan steps), ran them through the real `recordRun` / `buildBaseline` / `diffFacts` (read-only, 2 recordings of 1.29.1 for noise, 1 of 1.30.0). After the Share step, the diff contains exactly the two known changes: the share button's `data-url` went from `https://example.com/posts/third` to `https%3A%2F%2Fexample.com%2Fposts%2Fthird`, and `data-title` from `Third post - Spike Feed` to `Third%20post%20-%20Spike%20Feed`. The other 20 changed facts are the same release's markup change, found at every step. I did not run the full confirm.mjs (tests, bisect) on the plan; only the recording and diff.
- **Variability.** The same prompt gives 1 to 5 stable flows between runs at temperature default. Two rounds or two independent calls would cover more; each call is about $0.02.

## Money

Total spent on this feature: about **$0.98** of Meta credit, 51 calls (50 recorded in `out/ai-flows/*.json`, plus one early FreshRSS call whose file was overwritten). Cost per useful run: about $0.02 for one round, $0.04 for two.

## What was and was not verified live

- Live: FreshRSS 1.29.1 (local PHP, own worktree and feed port, so as not to collide with other runs), Docusaurus cacb973 in Docker on OrbStack (hardac2 not used), TodoMVC v1.4 static. All replays used real Chromium, 3 fresh browsers per flow.
- Not run: VitePress (no cached image, would need a long install), the full `confirm.mjs` with tests and bisect on AI-proposed steps, the dashboard flow, and wiring into `crawl/cli.mjs` or the check runner (left to the owner of that code). The `evidence` recording path is unit-covered only by shape, not exercised against a real case directory.
- Limits by design: a flow that needs a write to show its result cannot be kept (the app runs read-only); the model sees only tree and text, so it misreads emoji-only names and cannot propose flows through states the crawl never reached except via round 2; the safety filter is conservative and will drop some harmless flows (any "install", "clear", "post" as a first word).
- The only tests: unit tests with a fake `ask` and a local fixture page served in the test (menu, dialog, todo list, a destructive button, an external link, a POSTing form, an unstable control), run with `node --test src/release/crawl/propose-flows.test.mjs` (about 30 s, launches Chromium).
