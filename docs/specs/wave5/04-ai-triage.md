---
part: ai-triage
owns:
  - src/release/triage.mjs
  - src/release/triage.test.mjs
test: node --test src/release/triage.test.mjs
---
# Part 04: model triage of REVIEW findings

A model proposes, code verifies, a person approves. When a check ends in REVIEW, differences were seen but no repeatable test proved them. Today a person gets them as a list. `triage.mjs` asks Meta Muse Spark to RANK that list by how likely a person is to care, with one plain sentence each. The ranking is a separate view, labelled `ai_hypothesis` ("AI guess, not proof"). It is computed after the verdict, reads nothing back into it, and can never change the verdict, a notice class, a finding or the exit code.

## What was built

`src/release/triage.mjs` (about 270 lines) and `src/release/triage.test.mjs` (18 tests, no network, no browser).

What the model is shown, per difference: what changed (element, attribute or text, old and new value, each cut at 160 characters), the page and the step it was seen after, the noise-mask context (whether the fact sits under an area where facts were masked as noise, and the case's masked sentence), and optionally the code's own notice class and why. The test outcome is NOT shown by default (`withRuns: false`), so the model ranks on content, not on a number that already tells it which tests were flaky. Page values are wrapped in `<untrusted_findings>` and the system prompt says they are data, not instructions.

What code does to the answer:

1. Reads one JSON object `{"ranking": [{"id", "reason"}]}` (fenced JSON and a bare array are accepted).
2. Drops ids that are not real findings, repeated ids and malformed entries, and caps each reason at 280 characters. Each drop is a line in `notes`.
3. Every finding appears exactly once. Ones the model omitted are appended by code at the bottom in `notRanked`, in the code's own order (visible, churn, third party), with the reason `not ranked by the model`.
4. If the reply is not usable JSON, or the call fails, or the projected worst case is over `maxUsd`: nothing is ranked, every difference is listed as not ranked, a note says why, and nothing throws.
5. Computes `agreement` with the deterministic notice class and `agreesWithCode` per item.

## API

```js
import { run } from './src/release/triage.mjs'
const r = await run({ caseDir: 'out/evidence/<case>', ask, maxUsd: 0.05 })
```

`run({ caseDir, ask, maxUsd = 0.1, scope = 'review', record = true, reasoning, withCodeClass = true, rubric = true, withRuns = false })`

- `caseDir`: an existing `out/evidence/<case>/` directory. It is read only; the findings come from `test.exported` and `test.judged`, the old and new values from the `facts-diff.json` artifact, the page from `baseline.json`, the noise context from `masking.summary`.
- `ask`: `(messages, { reasoning, maxTokens }) => Promise<{ text, usage }>`; `usage` is `{ promptTokens, completionTokens, reasoningTokens?, ms?, finish?, model?, provider? }` (`pt`/`ct` also accepted). Default: Muse Spark through `llm.chat('meta', ...)`, `reasoning: 'minimal'`, `maxTokens: 4000`. A missing `META_API_KEY` is a note, not a throw.
- `scope`: `'review'` (default) keeps findings whose verdict is `not_reproduced`, `unstable`, `fails_both` or `error`; `'all'` ranks every tested finding (used for measurement and demos). A case with nothing in scope makes no call and says so.
- `record`: when true, the exact messages are saved as the `triage-prompt.json` artifact, and `model.requested`, `model.call` and `triage.ranked` events are appended (the last one `by: 'model'`). No claim is written, so the three-guess limit of the "why did it regress" call (`ask.mjs`) is not used up, and no decision is touched. The AI-stage runner passes `record: false` and records the stage itself.

Returns:

```js
{ label: 'ai_hypothesis', meaning, 
  items:     [{ findingId, rank, reason, codeClass, agreesWithCode }],           // the model's order
  notRanked: [{ findingId, rank, reason: 'not ranked by the model', codeClass, agreesWithCode: false, notRanked: true }],
  agreement: { top1, pairwise, comparablePairs, n },
  calls:     [{ model, provider, promptTokens, completionTokens, reasoningTokens, finish, ms, usd }],
  spentUsd, notes: [], sent: messages }
```

`agreement.top1` is true when the model's first pick is in the best code class present. `agreement.pairwise` is, over the pairs the code puts in different classes, the share the model orders the same way (null when there is no such pair). `agreesWithCode` is true when an item sits in the band of positions its class occupies. These are calibration numbers against the code's rule, not a score of truth.

Pure exports for tests and reuse: `buildMessages`, `describeFinding`, `validateResponse`, `completeRanking`, `agreementOf`, `maskedUnder`, `estimate`, `loadFindings`, `rankWith` (the core of `run` on findings you pass in, no case read or written), `renderMarkdown`.

## How to wire it in

Nothing in `src/release/cli/`, `bin/` or `check-runner.mjs` was touched. `src/release/cli/ai-stages.mjs` already lists this module as the `triage` stage (`--ai-triage`, or `--ai`): it imports `src/release/triage.mjs`, calls `run({ caseDir, ask: counted, maxUsd, record: false })`, and reads `items`, `notes`, `calls`, `sent` from the result. This module matches that contract. Two things for the wiring owner:

1. Show `notRanked` too if the report lists the ranking: the stage runner only normalizes `items`. The count and ids of omitted differences are in `notes`.
2. Run the stage only after the recommendation and exit code were computed (the runner already does), and print `renderMarkdown(result)` or the stage's rows under a heading that says "AI guess, not proof".

Standalone: `node -e "import('./src/release/triage.mjs').then(async m => console.log(JSON.stringify(await m.run({ caseDir: process.argv[1], record: false }), null, 1)))" out/evidence/<case>`.

## Measured results

The honest summary: **the model does not beat the deterministic notice class, it comes close when it can see that class, and what it adds is a plain-language reason for each item.** It is far better than random.

### Ground truth

Every tested finding in the 118 saved cases under `out/evidence/` (FreshRSS, VitePress, Docusaurus, Hoppscotch, Slidev, Excalidraw, umami, TodoMVC, a Next.js blog, a release-notes demo, and the planted-mutation bench), deduped by app and fact key: 64 distinct findings. Labels:

- positive (50): `confirmed` by a reproducing test AND code class visible (42), or a planted regression of the mutation bench (8, three of which the code calls churn: `data-id`, `data-step`);
- negative (14): confirmed but churn or third-party by the code's rule (13: generated ids, `data-v-*`, `data-slot`, version labels, class changes outside the layout list, a Twitter iframe), or never reproduced (1: a rotating ad image, `unstable` and `not_reproduced`).

Two honest limits. First, the recorded data holds almost no REVIEW cases: nearly every tested finding was eventually confirmed, so only one finding is independent evidence of "did not reproduce". Second, the churn labels come from the same rule the baseline uses, so the baseline is close to perfect on them by construction. The independent signals are the planted regressions and the unreproduced ad. Treat the code column as an upper reference, not as a rival that was fairly beaten.

Pools: 24 mixed pools of 8 (4 positives, 4 negatives, drawn so every negative is used about equally, shuffled so the baseline's ties are random), plus 5 natural per-app pools. Metrics: top-1 (is the first pick a positive) and pairwise (share of positive/negative pairs with the positive ranked higher; random is 0.5, random top-1 is 0.5 on mixed pools). Code baseline: the notice class order, ties split at random.

### Mixed pools (24 pools, 331 positive-over-churn pairs; mean of one run per setting unless noted)

| setting | top-1 | pairwise | cost / 24 calls |
|---|---|---|---|
| random | 0.50 | 0.500 | 0 |
| code notice class (baseline) | 1.00 | 0.983 | 0 |
| class shown, rubric, minimal reasoning (3 runs: 0.958, 0.948, 0.961) | 1.00 | 0.956 | $0.10 |
| class shown, rubric, low | 1.00 | 0.951 | $0.18 |
| class shown, rubric, medium | 1.00 | 0.948 | $0.36 |
| class shown, rubric, high | 1.00 | 0.927 | $0.47 |
| class shown, no rubric, low | 1.00 | 0.964 | $0.15 |
| class hidden, rubric, minimal (3 runs: 0.893, 0.880, 0.883) | 1.00 | 0.885 | $0.10 |
| class hidden, rubric, low / medium / high | 1.00 | 0.901 / 0.883 / 0.898 | $0.18 / 0.35 / 0.44 |
| class hidden, no rubric, low / medium / high | 0.83 / 0.83 / 0.92 | 0.857 / 0.852 / 0.862 | $0.13 / 0.26 / 0.31 |

Findings:

- With the class hidden, the model still puts a positive first in every pool when it has the short rubric, and orders about 89% of positive/negative pairs correctly (random 50%). Without the rubric it is worse (top-1 0.83 to 0.92, pairwise 0.86). The rubric is worth keeping.
- With the class shown, the model mostly copies it: agreement with the code is 0.91 to 0.96 pairwise, and accuracy lands 2 to 3 points under the baseline, inside run-to-run noise (0.948 to 0.961 across three identical runs).
- More reasoning does not help. `minimal` is as accurate as `high` at a fifth of the price (about $0.004 a call against $0.019). The default is `minimal` with the class shown and the rubric on.
- Where the model disagrees with the code, it is mostly by ranking a class-attribute change (a grid or flex-column switch, an overflow change) above a confirmed positive. Those items are labelled churn only because the code's layout list does not contain the class, so some of these "errors" are arguably the model being right; this is also where it earns its keep as a second opinion.
- The three planted regressions the code calls churn (a `data-id` renumbered after a list item is removed, a `data-step`): the model ranks them above churn negatives 72% to 79% of the time against the code's 78% (ties counted half). Between planted-churn and real churn, nobody can tell them apart from the fact alone (model 0.46 to 0.54, code 0.50). The model has no way to know a planted `data-id` is a bug.
- The one never-reproduced item (the rotating ad image): ranked below the positives in 96% to 100% of pairs, but the code's `third_party` class already skips it before it becomes a finding, so this adds nothing today.

### Natural per-app pools (5 apps, 3 runs each, 15 calls)

Class shown: top-1 1.00, pairwise 0.983 (code 1.00). Class hidden: top-1 0.87, pairwise 0.78 (code 1.00). Small pools (5 to 11 items), so this is anecdote, not a statistic.

### Does it help a person?

It gives what the code cannot: a reason in plain language, for example "Pane changed from overflow-auto to overflow-hidden, possibly blocking scrolling", "Only a Vue scoped attribute was removed in a noisy area". It does not find anything the class missed on this data, and on this data it cannot be shown to rank better than the class. The claim to make is: an AI guess that agrees with the rule about 95% of the time and explains itself, at under half a cent a case, labelled and walled off from the verdict.

End to end on real cases with the default ask (not recorded in the cases): the VitePress case with one unstable ad image ranked it as third-party content users ignore ($0.0010); the Hoppscotch case ranked the five tested differences with agreement top-1 true and pairwise 1.0 ($0.0034).

## Money

414 live Muse Spark calls in the measurement grid and repeats, plus a handful of smoke runs: about US$3.62 in total (estimated at the project's $1.25 and $4.25 per million input and output tokens, an unverified third-party price). A single triage call in the product is about $0.001 to $0.01. The measurement harness, pools, per-call results and scoring scripts are in `out/triage-bench/` (git-ignored scratch): `node build-set.mjs`, `node build-pools.mjs`, `node measure.mjs <variant> <reasoning> [reps] [pools.json]`, `node score.mjs results/*.json`, `node breakdown.mjs results/*.json`.

## Not done

- The dashboard card and the report section for the ranking.
- A measurement on real REVIEW cases: none were saved with more than one unreproduced finding. When some exist, re-run `scope: 'review'` and compare the ranking with what a person looked at first.
- Untested differences beyond the five-finding cap are not sent: only findings that were turned into tests and judged are ranked.
