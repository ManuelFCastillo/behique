# Wave 5, feature 3: AI description of visual diffs (built 2026-11-03)

Behique's principle holds: a model proposes, code verifies, a person approves. Nothing in this feature touches the verdict (SHIP/HOLD/REVIEW) or an exit code. Its output is labelled `ai_hypothesis`, carries its cost, and says "AI guess, not proof".

## What it does

For each good/candidate screenshot pair recorded in an evidence case:

1. Code diffs the two pictures (`pixels.mjs` conventions: exact per-channel difference, tolerance 0 as in `shots.mjs`), clusters the changed pixels into regions, and checks the total beats the recorded noise floor (`aboveFloor`). A pair at or under the floor, identical, or of different sizes gets no model call and a note.
2. Spark is shown the good and candidate pictures: the viewport-level view plus crops around the largest diff regions, each crop a good/candidate pair. It answers with a list of changes: a plain description, a `kind` (moved, resized, recolored, text, added, removed, other) and a 0..1 box.
3. Code maps each box back to the screenshot and counts the really-changed pixels inside it. The claim is kept only if the box holds at least 8 changed pixels (and more than the noise floor allows), is not a loose box on mostly unchanged page (changed pixels at least 0.4% of the box), and overlaps a diff region (at least 25%, measured as the better of "share of the box inside a diff region" and "share of the touched diff regions the box captures"). Otherwise it is dropped and counted as a hallucinated region.
4. For moved, added, removed and recolored claims code also measures the pixels (`shiftMatch`, `emptiness`, mean colour of the changed pixels) and records `kindCheck`: `agrees`, `unconfirmed`, `unchecked`, or `contradicts` (a claim of "added" where the pixels show the thing was removed): a contradicted claim is dropped. Where it can measure a move the offset is attached as `measured: {dx, dy}`, a code fact next to the AI sentence.
5. Changed pixels that no verified claim covers are returned as `unexplainedRegions` (a diff region is listed when more than 40% of its changed pixels lie outside every verified box; the largest 12 per pair).

What this proves and does not: code verifies WHERE (the described place really changed, above noise) and, for four kinds, that the direction of the change agrees. It cannot verify the WORDS. A verified description can still be wrong about what changed in a real diff region (see "Measured results", umami). That is why the output is an AI hypothesis, and why the unexplained list matters.

## Exact API

File: `src/release/visual/describe.mjs`

```js
import { run } from './src/release/visual/describe.mjs'
const result = await run({ caseDir, ask, maxUsd, ...options })
```

- `caseDir`: an existing `out/evidence/<case>/` folder (read only: it reads `events.ndjson` and `artifacts/<sha>`, never writes). Pairs come from `shots.recorded` events (good and candidate hashes, step, label, and the noise floor parsed from the recorded text), or for a check by picture from `good-picture.png`, `candidate-picture.png` and `floor.json`.
- `ask(messages, { reasoning, maxTokens })`: injectable, resolves `{ text, usage: { promptTokens, completionTokens, ... }, model?, provider? }` (`pt`/`ct` also accepted). Default `defaultAsk` calls `chat('meta', messages, { reasoning, maxTokens })` from `src/llm.mjs` (Muse Spark 1.3), images as `image_url` data URLs like `bench/mb-senses.mjs`.
- `maxUsd` (default 0.5): before each call the worst case (estimated prompt plus `maxTokens`) must fit under the cap with what is already spent, otherwise that pair is skipped with a note.
- Options (defaults): `strategy: 'both'` (`'page'`, `'crops'`), `prompt: 'pagecoords'` (`'box'`, `'point'`), `reasoning: 'low'`, `maxTokens: 6000`, `maxPairs: 4` (biggest diff first), `maxCrops: 5`, `maxSide: 1600`, `tolerance: 0`, `minPixels: 8`, `minDensity: 0.004`, `minOverlap: 0.25`, `margin: 1.5`, `unexplainedShare: 0.4`, `maxUnexplained: 12`, `snapPx: 0` (off).

Return value:

```js
{
  label: 'ai_hypothesis',
  items: [{ shotId, description, kind, view, region: {x,y,w,h} /* 0..1 of the whole screenshot */, box /* screenshot pixels */,
            verified, regionSource, overlapRatio, diffPixels, goodHash, candHash,
            kindCheck?, measured?, droppedBecause? }],
  unexplainedRegions: [{ shotId, box, region, changed, regionChanged, goodHash, candHash }],
  calls: [{ shotId, model, provider, promptTokens, completionTokens, usd, ms?, finish?, views, raw }],
  spentUsd, notes: [],
  dropped: { hallucinatedRegion, other /* contradicted by pixels */, unreadable /* malformed entries */ },
  pairs: [{ shotId, changedPixels, regions, claims, verified, unexplained, unexplainedPixels }]
}
```

`items` includes the dropped ones (`verified: false`, `droppedBecause`) so the count is auditable; show only `verifiedItems(result)`. `run` never throws for a model failure (a note instead) and never has a verdict field.

Pure helpers exported for tests and for the wiring: `analyzeDiff`, `matchRegion`, `checkKind`, `planViews`, `buildMessages`, `promptText` (the text of a prompt without image bytes, for the "review what would be sent" step), `estimatePrompt`, `parseResponse`, `findPairs`, `crop`, `shrink`, `toImageBox`, `toUnit`, `verifiedItems`, `defaultAsk`, `SYSTEM`.

Command line: `node src/release/visual/describe.mjs <caseDir> [--max-usd 0.5] [--strategy page|crops|both] [--reasoning low|medium|high] [--dry-run]` (`--dry-run` prints the exact prompt text and sends nothing).

## How to wire it in (not done here: another agent owns `src/release/cli/`, `bin/`, `check-runner.mjs`)

Follow the `--explain` pattern (`src/release/cli/explain.mjs`, `hypothesis.mjs`, `ask.mjs`):

1. Opt in only (a flag such as `--describe`, action input `describe: true` with the `meta-api-key` secret). Without it, no model call. Only for apps whose screenshots may leave the machine (public apps, `docs/model-use.md`); `run` does not check this, the wiring must.
2. After the shots are recorded (`shots.recorded` events exist), call `const r = await run({ caseDir: c.dir, maxUsd: 0.1 })`. A pair costs about $0.005 to $0.013, so 4 pairs fit well under $0.1.
3. Record it like the hypothesis: `c.event('model.requested', ...)` before; after, one `c.event('model.call', { provider, model, promptTokens, completionTokens, estUsd, ms, finish })` per `r.calls[i]`; `c.artifact('describe.json', r, 'application/json')`; for each verified item `c.claim('ai_hypothesis', item.description, { by: 'model', model, evidence: [item.goodHash, item.candHash], extra: { region: item.region, overlapRatio: item.overlapRatio, kindCheck: item.kindCheck, measured: item.measured, estUsd } })`. The report should show, for each, the region drawn on the good and candidate screenshot (the hashes are existing artifacts), "AI guess, not proof", the cost, and a line "N descriptions dropped: no changed pixels at that place" plus the unexplained regions.
4. For the dashboard, reuse the preview-then-confirm guard of `ask.mjs`: show `promptText(messages)` (build the messages with `planViews` and `buildMessages`) and the projected cost, send only with the fingerprint of what was shown.
5. The verdict code must not read `describe.json` or these claims.

## Measured results (Meta Muse Spark 1.3 via the Meta API, 2026-11-03)

Synthetic planted changes: a page rendered with Playwright (button, icon, headings, paragraph, card, toggle, input, star, nav, footer), one or more known changes per pair, ground truth from element bounding boxes. Easy set: 12 pairs, 14 planted changes (shift a button 12px, recolor a button, remove an icon, change a heading, recolor text, resize a card, add a badge, flip a toggle, three at once, a corner radius, remove an icon plus change a label, and an identical pair that must cost nothing). Hard set: 6 pairs, 10 planted changes (a 4px shift, a font weight change, a 2px border colour change, five changes at once, a longer text edit, two swapped nav items). "Found" means a verified item whose box lands on the planted element and whose description names the right change (judged by keywords, and read by hand for the later runs). Precision is verified items that match a planted change, divided by verified items. Hallucinated is claims dropped for no changed pixels there.

Variants (easy set 14 planted, hard set 10; one run each unless a list is given, which is repeat runs of the same config, so run to run variation is visible; five early runs of page plus crops with the box prompt and no reasoning flag found 9 to 11 of 14):

| strategy / prompt / reasoning | found (easy) | found (hard) | note |
|---|---|---|---|
| page only, box prompt, low | 14, 14, 14, 14, 13 (5 runs) | 6, 7 | best on easy, weaker on dense hard pairs |
| page only, medium | 12 | 5 | medium and high were not better than low, and cost more |
| page only, minimal | 12 | n/a | cheaper (3.3k completion tokens against 5.6k) |
| page only, high | 13 | n/a | 10.3k completion tokens, about 40% more cost |
| crops only, low | 10 | 8 | boxes in a small crop are placed less exactly |
| page plus crops, box in the crop's own frame, low | 9 to 12 | 8, 7 | many "REJECTED": the description was right, the box was 20 to 30 px off on small things |
| page plus crops, boxes always in the PAGE frame (`pagecoords`), low | 13, 13 | 8, 9 | the chosen default |
| page, point prompt, with or without snapping to the model's point | 12 to 14 | n/a | no gain over the box prompt, `snapPx` left off |

Final default configuration (strategy both, prompt pagecoords, reasoning low), run on the final code:

| set | planted found | verified items | of which match a planted change | hallucinated regions | contradicted | unexplained regions |
|---|---|---|---|---|---|---|
| easy, 1x | 14 of 14 | 14 | 14 | 0 | 0 | 0 |
| easy, device scale 2 | 13 of 14 | 13 | 13 | 0 | 0 | 2 |
| hard, run 1 | 9 of 10 | 9 | 9 | 0 | 0 | 1 |
| hard, run 2 | 9 of 10 | 9 | 9 | 0 | 0 | 2 |

So 45 of 48 planted changes found (94%), 45 of 45 verified descriptions on a real planted change (100% precision), 0 hallucinated regions. The three misses are all the same thing: the removed 28px red icon, when it was one of several simultaneous changes (one of five in both hard runs, one of three in the 2x run). Alone, the icon removal was found in every final run. Across all configurations (about 340 calls) hallucinated regions ranged from 0 (final runs) to 4 of 13 claims (a bad prompt variant), and the module dropped every one.

Trap pairs (pixels differ above tolerance 0 but nothing a person can see: a one-unit colour shift on a heading and footer, a one-unit text colour change, a 1px border tint), 3 pairs, 2 runs each: the model described nothing in all 6 calls, and the module listed the differing pixels as unexplained regions each time. No invented descriptions.

Real saved screenshots from `out/evidence/` (public apps only: Music Blocks v3.8.0 and v3.7.0 vs master, FreshRSS 1.29.1 vs 1.30.0, Excalidraw, Next.js blog, VitePress (two cases), umami, TodoMVC, Hoppscotch, Docusaurus, Slidev; the private codecosmos case and Behique's own fixtures were not sent). 13 cases, 17 calls (default configuration, up to 3 pairs per case): 47 descriptions, all 47 verified, 0 hallucinated, 0 contradicted by the pixels, 64 unexplained regions (most of them small leftovers in busy pages), $0.165. There is no ground truth for these, so I checked two cases by eye against the screenshots:

- Hoppscotch 2025.10.1 vs 2025.11.2 (step 9): "a new Enable Documentation toggle row appears under Enable Mock Servers" and "the accent colour row moved down and is partly cut off": both right, and the second is the real consequence of the first.
- umami v3.3.1 vs v3.4.1: logo larger, title larger, eye icon darker: right. A first-run claim that the "Login" label became larger and bolder was not something I could confirm by eye, and the model did not mention the form labels losing their bold weight or the fields moving up about 12px, which sit in the unexplained list. This is the limit of the approach: a verified description is at a place that changed, not proof its words are accurate.

Reading the other cases (Docusaurus, Music Blocks, VitePress) the descriptions were specific and plausible (version label changed from X to Y, new "bun" tab after "yarn", announcement bar background changed); I did not audit them one by one against the screenshots, so treat accuracy of the words on real pages as unmeasured beyond these two cases.

Latency: about 10 s per pair (average 9.8 s over the 17 real calls).

## Money spent

About US$2.35 of Meta API credit: roughly 340 calls (all variants, repeats, hard set, trap set, real cases) at the project's price estimate ($1.25 / $4.25 per million input / output tokens, an unverified third-party figure, see `src/llm.mjs`), against the allowed $20. A pair costs about $0.004 to $0.022 in the final configuration (the 15-region Docusaurus pair cost the most because the model wrote 12 descriptions). Two images per view cost about 1.5k to 3k prompt tokens at 1280x900; a pair with crops about 3k to 5k.

## Limits and honest gaps

- Verifies location and, for four kinds, direction. It cannot verify the wording (colour names, "bolder", exact pixel counts). The only numbers the page should show with authority are the code-measured ones (`measured`, `diffPixels`).
- Different-size screenshot pairs are skipped (a page that grew taller): no cropping to a common area yet. Spark fails on tall full-page screenshots, and shots are viewport size so this has not arisen; tiling would be the fix.
- Recall drops when many things change at once (five at once: it describes about four). Unexplained regions are the safety net: nothing a person should see is silently absent.
- Run-to-run variation is real (the same configuration found 9 to 11 of 14 in five early runs on the weaker prompt, 13 to 14 on the final one). A report should not promise the same sentences twice.
- The noise floor for step shots comes from the recorded text ("the same version differs from itself by N"), a single global count, not a per-pixel mask; a region is held to more than N times 1.5 changed pixels. With a floor of 0 (every recorded case so far) this does nothing extra.
- Privacy: nothing in the module checks that an app is public. The wiring must.
- Not wired into the CLI, the dashboard or the report page. Tests: `node --test src/release/visual/describe.test.mjs` (29 tests, no network, no browser).
