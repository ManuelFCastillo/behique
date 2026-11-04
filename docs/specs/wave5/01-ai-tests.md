# Wave 5, feature 1: the model writes the regression test, code decides whether it stays

Written 2026-11-03. Code: `src/release/aitest.mjs`. Tests: `src/release/aitest.test.mjs` (18 tests, all pass: `node --test src/release/aitest.test.mjs`).

## What it is

Today `findings.mjs` and `confirm.mjs` turn every changed fact into a Playwright test written by code (an xpath and an expected value). `aitest.mjs` adds a second author for the same difference:

1. Muse Spark 1.3 (`llm.chat('meta', ...)`) is shown one proven difference: the recorded facts that changed, the steps that reach it, other changes recorded near it, and the code-generated test as a reference. Optionally (variant `snapshot`) it also sees what the old page looked like at that step, read by code (the changed element's HTML and the accessibility tree around it).
2. It answers with a human name, a one-sentence reason, and the BODY of a test. The fixed part of the test (import, dialog handler, the reset hook, the block on requests to other hosts, the read-only rule when the reference had it, the page load) is copied by code from the reference and is not model text.
3. Code refuses unsafe source before anything runs (`checkTestSource`): one import only, `{ test, expect }` from `@playwright/test`; no `require`, `import()`, `fetch`, `XMLHttpRequest`, `WebSocket`, `process`, file access, `eval`, `createElement`; no `page.route`, `unroute`, `context`, `testInfo`; no script that changes the page address or opens a window; `goto` and `request.*` must be given a literal path on the app (a string starting with one `/`); no `test.skip/only/fail/fixme/slow/setTimeout` or hooks (they could hide a failure). A URL that is only an expected value in an assertion is fine. Together with the fixed route block, a generated test cannot reach any host but the app under test.
4. Code verifies each survivor with the same machinery `confirm.mjs` uses (it is a script, so its parts are reused, not the file): `startBuild` for a fresh build per run, `runPool` for the pool, `runExportedAsync` for the Playwright run, `judgeFindings` for the verdict. One look each way first (1 run on the good version, 1 on the candidate); a test that fails on the good version, or passes on the candidate, gets one repair call (the model is told what happened: Playwright's error and the page at the failure from the good version, or "it passed on the new version"); a test that passes the first look then runs the rest of `runs` (default 3) each way. Kept only if it passed every run on the good version and failed every run on the candidate (`confirmed`). Anything else is dropped with the reason: refused by the safety check, fails on the good version, passes on the candidate too, not consistent, could not be run, model call failed, reply unusable, spending cap.
5. Everything is labelled `ai_hypothesis`. The verdict and exit code never read it. Only items with `verified: true` are results; a dropped item keeps its text for debugging but must never be shown as a result (`verifiedItems(result)` is the filter).

## API (exact)

```js
import { run, verifiedItems } from './aitest.mjs'

const r = await run({
  caseDir,              // an existing out/evidence/<case>/ folder (required)
  ask,                  // (messages, { reasoning, maxTokens }) => Promise<{ text, usage: { promptTokens, completionTokens, ... } }>; default Muse Spark 1.3 via llm.chat('meta', ...)
  maxUsd,               // spending cap for the model calls of this run (default 0.5); a call whose worst case would pass it is not made
  // optional
  runs: 3, maxTests: 5, repairs: 1, variant: 'context', reasoning: 'low', maxTokens: 6000,
  only: 'confirmed',    // or 'all': which exported differences to write tests for
  outDir,               // where the specs are written (default out/aitest/<case>; must be inside the project so @playwright/test resolves)
  port: 8700,           // base port for builds; a port that is already taken is skipped (freePort)
  record: true,         // write model.requested, model.call, aitest.item, aitest.done events and a code claim per survivor into the case
  verify,               // test seam: async jobs => results, jobs = [{ id, side: 'good' | 'candidate' }], results = [{ passed, message } | { error }]
  adapter,              // override the app adapter (default: from the case)
  dryRun: false,        // build the prompts (and, for variant snapshot, read the old page), send nothing
  approve,              // async plan => boolean; called with the exact messages and the worst-case cost before the first call; false sends nothing
  log,
})
// r = {
//   label: 'ai_hypothesis',
//   items: [{ findingId, id: 'AI1', name, reason, testSource, verified: boolean,
//             runs: { verdict, good: { passed, total }, candidate: { failed, total }, total, candidateFailure, failureKind, goodFailure? },
//             attempts, firstTry: { good, candidate }, droppedBecause? }],
//   calls: [{ model, provider, promptTokens, completionTokens, usd, findingId, purpose: 'write' | 'repair' }],
//   spentUsd, notes: [],
//   plan: { prompts: [{ findingId, messages, worstUsd }], worstUsd },   // the exact text sent
//   caseId, goodRef, candRef, variant, reasoning, repairs, runs, dir
// }
verifiedItems(r)   // the items that survived: the only ones to show as results
```

Pure helpers, all exported and unit tested: `buildMessages(finding, { variant })`, `repairMessages`, `parseProposal(text, { finish })`, `checkTestSource(source, { body })`, `scanCode`, `assembleSource`, `referenceOf`, `preludeOf`, `stepsOf`, `probeSource`, `nearbyChanges`, `nearbyFacts`, `findingsOf(openCase(dir), { only })`, `worstCase`, `freePort`, `defaultAsk`, `defaultVerifier`. Command line: `node src/release/aitest.mjs <caseDir> [--max-usd 0.5] [--variant context] [--reasoning low] [--repairs 1] [--runs 3] [--only confirmed|all] [--dry-run] [--no-record]`.

Prices come from `llm.mjs` (`$1.25` in, `$4.25` out per million tokens, an unverified third-party estimate), so every dollar figure here is an estimate.

## How to wire it in

The wiring agent already did this through `src/release/cli/ai-stages.mjs` (stage `tests`, flag `aiTests`), which calls `run({ caseDir, ask, maxUsd, record: false })` and stores the result itself. Notes for whoever touches it:

- Call it after the check has finished its tests and before `close()` (and before `anchor`) if events are to be recorded into the case with `record: true`. With `record: false` the caller owns the recording.
- Show `r.plan` (the exact messages and the worst-case cost) in the existing "review what would be sent" step by calling `run({ dryRun: true })` first, or pass `approve`. For variant `snapshot` a dry run still builds the old version once per finding (no model spend), because the page reading is part of the text.
- Show only `verifiedItems(r)` as results. Label the name and reason "AI wording, not proof"; the proof is the run counts (`runs.good`, `runs.candidate`).
- Recorded events: `model.requested` and `model.call` per call (as `hypothesis.mjs` does), `aitest.item` per proposal (label `ai_hypothesis`, with the name, reason, run counts, or the reason it was dropped), one code-authored `reproduced_failure` claim per survivor that contains none of the model's words, and `aitest.done`. It deliberately does NOT write `ai_hypothesis` claims, because `hypothesis.mjs` counts every `ai_hypothesis` claim against the 3-guess limit of the "Ask the model why" card.
- The kept test files are in `out/aitest/<case>/AI<n>.spec.js` and run with `npx playwright test` in that folder (`BASE_URL` set), like `out/regression/*`.

## Measured results (real saved cases, real model, real builds)

2026-11-03. Cases: FreshRSS 1.29.1 vs 1.30.0 (the Share menu regression, and the scroll case), TodoMVC v1.4 vs master, Hoppscotch 2025.10.1 vs 2025.11.2, VitePress rc.10 vs rc.12, Slidev v52.15.2 vs v52.16.0, Docusaurus cacb973 vs v3.8.0. These are the cases with confirmed findings. Every run was made on a copy of the case (the originals in `out/evidence/` were not touched). Builds: FreshRSS on this Mac (php, sqlite); the other five in the Docker sandbox on hardac2 (`BEHIQUE_SANDBOX=docker:ssh://hardac2`, reachable on 2026-11-03), pool of 2. The local OrbStack engine was not needed. Verification used 3 runs on each version, each run on a fresh build, and one repair at most.

### By case (variant `context`, reasoning `low`, the default)

| Case | Proposed | Survived | Of which without a repair | Dropped | Cost | Time |
|---|---|---|---|---|---|---|
| FreshRSS Share | 2 | 2 | 2 | 0 | $0.0093 | 69 s |
| FreshRSS scroll | 1 | 1 | 1 | 0 | $0.0060 | 26 s |
| TodoMVC | 5 | 5 | 4 | 0 | $0.0319 | 128 s |
| Hoppscotch | 5 | 5 | 5 | 0 | $0.0412 | 152 s |
| VitePress | 5 | 5 | 5 | 0 | $0.0302 | 133 s |
| Slidev | 5 | 5 | 3 | 0 | $0.0440 | 204 s |
| Docusaurus | 5 | 5 | 5 | 0 | $0.0296 | 142 s |
| Total | 28 | 28 | 25 | 0 | $0.2022 | |

"Without a repair" counts a test that passed once on the good version and failed once on the candidate on the very first try. The three that needed a repair (one TodoMVC, two Slidev) had failed on the good version (a wrong locator or a wrong wait) and passed after the model was shown Playwright's error and the page.

### By prompt variant and reasoning level (all cases, 7 runs each, 28 tests each)

| Variant / reasoning | Survived (after one repair) | First-try survivors | Repair calls | Cost | Cost per kept test | Avg tokens in / out per call |
|---|---|---|---|---|---|---|
| basic / low (no steps, no nearby facts) | 28 of 28 | 25 (89%) | 3 | $0.188 | $0.0067 | 1187 / 1078 |
| context / low | 28 of 28 | 25 (89%) | 3 | $0.192 | $0.0069 | 1434 / 1038 |
| strict / low (adds a checklist) | 28 of 28 | 26 (93%) | 2 | $0.202 | $0.0072 | 1519 / 1138 |
| snapshot / low (adds the old page read by code) | 48 of 48 reported, see note | 42 (88%) | 5 | $0.376 | $0.0082 | 2073 / 1061 |
| snapshot / medium | 28 of 28 | 26 (93%) | 2 | $0.368 | $0.0131 | 2051 / 2283 |
| snapshot / high | 28 of 28 | 27 (96%) | 3 | $0.447 | $0.0160 | 1994 / 2807 |

Note on snapshot / low: it was run twice on the four sandbox cases (11 runs, 48 tests); the first pass had two replies the old parser could not read (the model wrote a fence labelled `test_body`), which is why 46 of 48 survived; the parser now accepts that and gets one more try, and the second pass kept 20 of 20 on those cases.

Reading: with one repair every variant keeps essentially every test, so the survival rate does not separate them at this sample size (differences of one or two tests out of 28). On first-try survival the best is snapshot / high (27 of 28), then strict, medium and snapshot (26), then basic and context (25); that is within noise. Reasoning higher than `low` costs 2 to 2.4 times as much for no measurable survival gain, and the snapshot variant costs an extra build per finding. The defaults are therefore `context` / `low` / 1 repair: tied for survival, cheapest after `basic`, no extra builds. If a team wants the best first-try rate regardless of price, use `snapshot` / `high`.

### Dropped tests, and why (honest accounting)

- In the runs kept as results, no test was dropped for being a bad test once the harness problems below were fixed. The only drops were two replies the first parser could not read (fixed, and the new parser plus the second try recovered them).
- Negative control: the same prompts with the candidate set to the good version itself, so no test can honestly fail on the candidate. Result: 0 of 8 survived (FreshRSS Share 0 of 2, FreshRSS scroll 0 of 1, VitePress 0 of 5): seven were dropped as "passes on the candidate too" and one VitePress test as "fails on the good version". Cost about $0.11. This is the check that survival is not rubber-stamping.
- Runs thrown away, and why. (a) A first batch had candidate builds that sometimes served the wrong version: tunnels left behind by runs I killed held the local ports, and the readiness probe cannot tell an old tunnel from a new one. That produced tests that looked "unstable" or "passing on the candidate". Fixed in `aitest.mjs` (`freePort`: a taken port is never reused, checked on every address) and every run after the fix was repeated. (b) A network outage on this machine made some Meta calls fail ("fetch failed", recorded as dropped with that reason, $0 spent) and some sandbox builds not start; those runs were repeated. (c) Chain runs on ports 9000 and up collided with a Jenkins container that publishes 9000 on this Mac ("did not answer on 127.0.0.1:9000"); repeated on other ports after `freePort` learned to check every address. None of these were test failures; all are counted in the spend.
- Not run: Music Blocks (its saved cases have canvas findings, no confirmed code-generated tests to base a test on), Excalidraw, Next.js blog (heavy builds, time), Umami (needs a login; `aitest.mjs` refuses to let the model write a flow that needs a secret).

### What the survivors look like

FreshRSS Share (variant `snapshot`, kept 3 of 3 runs each way):

```js
test("Clipboard share button copies an encoded URL instead of the real link", async ({ page, request }, testInfo) => {
  ...fixed start copied from the reference...
  try {
    // Open the first post to show its footer actions
    await page.locator('.flux .title:has-text("First post")').first().click();
    // Open the share menu for the current post
    await page.locator('.flux.current a[href^="#dropdown-share"]').first().click();
    // Check the Clipboard share button still holds the plain share URL
    const el = page.getByRole("button", { name: "Clipboard" }).first();
    await expect(el).toBeAttached();
    await expect(el).toHaveAttribute("data-url", "https://example.com/posts/first?utm=1&ref=a%20b");
  } catch (e) { ...added by Behique: also reports the page at the failure... }
})
```

On 1.30.0 it fails with `Received: "https%3A%2F%2Fexample.com%2F..."`, the real regression. The model replaced an xpath with `getByRole('button', { name: 'Clipboard' })` after reading the old page. FreshRSS scroll: "Clicking Scroll article 2 jumps the page back to the top" fails on the candidate with `Expected: 0 Received: -4033`. VitePress: "Guide sidebar is marked inert so it cannot be used", "Package manager tabs no longer grouped together", and so on, five readable names where the code-generated tests were named "inert of div[1]/aside[1] after step 8 is absent, as on the previous release".

Per run cost: about $0.0065 per kept test and 20 to 60 seconds of model plus build time per finding on a warm cache; a five-finding case takes 2 to 3 minutes end to end.

## Money

Meta Muse Spark 1.3, estimated at the project's price table: all recorded runs together 304 model calls, about $2.52, plus a few calls from runs I stopped before they wrote their result (I estimate under $0.3). Total about US$2.8 of the $20 allowance. No Baseten or other provider was used.

## Limits, said plainly

- "Survived" means the test passed on the good version and failed on the candidate in every run, as the code-generated tests must. It does not mean the failure is for the reason in the model's name or reason sentence. Those sentences are the model's reading of the difference ("AI wording, not proof") and can over-read it (for example "cannot be used" for an `inert` attribute). The record shows the actual failure message (`runs.candidateFailure`).
- About a fifth of the survivors (36 of 186 across the table above, by the final rule) fail on the candidate because the element is not found, not because a value differs. For a difference that is "this element vanished" that is the correct failure; for a model that chose a semantic locator it can also mean the locator no longer matches for another reason. `runs.failureKind` says which ('element not found' or 'assertion failed').
- The model mostly copies the check of the reference test, so survival is high because the difference was already proven. The value of the feature is readable names, readable locators and reasons, not new coverage: it does not find regressions the code-generated test did not find.
- Page text and the page reading are untrusted data fenced as such in the prompt; the safety check and the fixed route block are the defence, not the model's obedience.
- The cost figures are estimates at an unverified price. Verification time was dominated by sandbox builds; hardac2 was shared with other work during the runs and twice refused builds ("all predefined address pools have been fully subnetted", a busy Docker host); `defaultVerifier` retries a build that fails to start twice before calling it an error.
- Left on this machine by my stopped runs (a permission rule refused me removing them): ssh tunnels (pids 34105 and 34112, local ports 8780 and 8782) and two containers on hardac2 (`bq-ow9g7t94us-app`, `bq-863inx0a9k-app`). Harmless to results now (`freePort` skips taken ports), but they should be cleaned up (`node src/release/sandbox/clean.mjs --target ssh://hardac2 --minutes 30` or by hand).
- The original `out/evidence/` cases were not modified. Scratch copies and result JSON are under the session scratchpad; the generated specs of every run are in `out/aitest/` (about 1 MB).
