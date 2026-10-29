# Canvas senses plan (2026-10-29)

Asked 2026-10-29: the accessibility tree is not enough. Split Behique's perception into three senses so canvas apps (Music Blocks, codecosmos, lonestar-flight) can be tested.

- **Macocael**: semantic perception. Roles, names, states, relationships of what the page declares.
- **Boinayel**: visual perception. Screenshots, objects and shapes, differences, target coordinates with confidence.
- **Márohu**: action and verification. Mouse, drag, click, keys, then capture the new state and check the action worked.

Status: PLAN ONLY. Nothing here is built. Deadline for the whole project is Wed 2026-11-04 9PM ET, and the recording needs Mon 11/02 and Tue 11/03, so the canvas work has until about Sun 11/01.

## Where Behique is blind today (read from the code)
- `src/session.mjs` `act()`: every action needs a Playwright `selector`. There is no mouse position, no drag, no pointer action. A canvas is one element, so the whole drawing is a single click target.
- `observe()` already takes a full-page screenshot and the model sees it, but the model can only describe it. It cannot point at it, and nothing stores pixels as evidence.
- `src/assert.mjs`: kinds are text, value, visible, count, checked, style, dialog, attr, api. None looks at pixels.
- Default viewport is 820x900, device scale factor 1. Replays use a fresh browser, which is good for determinism.

## Rules carried over (do not break these)
1. **Perception proposes, the runtime verifies.** A vision model can say "a button is at (412, 300)". Only a deterministic check (the click changed these pixels, or fired this request, or did not) can certify anything. This matches the evidence store: model-authored claims are `ai_hypothesis` only, code-authored claims can be `verified_fact` or `reproduced_failure`.
2. **Assertions are data.** New assertion kinds are declared fields the runtime evaluates, never model-written code.
3. **"Not found" is a first-class answer.** Boinayel may return no target. It must never invent one to look useful.
4. **Confidence comes from verification, not from the model.** A model's own confidence number is not calibrated. A target is only trusted after Márohu's click changes the state as predicted. A click that changes nothing is low confidence whatever the model said.
5. **Measure the noise first.** Run the same version twice (A/A) and record how many pixels differ by themselves. Only report A/B differences above that floor.

## Contracts between the senses
All coordinates are stored twice: absolute pixels plus the viewport and device scale factor, and normalised 0..1 inside the canvas rectangle. Replay uses the normalised point so a layout shift of the whole canvas does not break it.

- `Target`: `{ id, label, source: 'a11y'|'vision'|'probe', canvas: rect, box, point, confidence, why }`
- `Observation`: `{ pngRef (content hash), viewport, dpr, canvasRects, blindPct }` where `blindPct` is the share of the viewport covered by canvases or other regions with no accessible children. The orchestrator turns Boinayel and Márohu on when this is high.
- `ActionResult`: `{ action, beforeRef, afterRef, diffRef, changedPct, inRegionPct, requests, console, verdict: 'changed'|'unchanged'|'error' }`

## The three modules (plain names in code, Taíno names in headers and the UI)
| Sense | File | Needs a model? | Job |
|---|---|---|---|
| Macocael | `src/senses/semantic.mjs` | no | Wraps `ariaSnapshot`; adds a11y findings (unnamed controls, duplicate names, canvas with no role or label) and the `blindPct` metric. Optionally axe-core. |
| Boinayel | `src/senses/vision.mjs` | yes, for locating; no for diffing | `locate(png, query)` returns candidate Targets; `diff(a, b)` is pure pixels. Zoomed-tile pass for small objects. |
| Márohu | `src/senses/hands.mjs` | no | `clickAt`, `dragTo`, `key` with before/after capture, region diff against the noise floor, and a verdict. |
| shared | `src/senses/pixels.mjs` | no | PNG decode, masked diff, noise floor, changed-region boxes. Likely `pixelmatch` + `pngjs` (small, pure JS): check `package.json` and ask before adding. |

New action types (`click_at`, `drag`, `key_at`) are NOT added to `ACTION_TYPES` until they work, so the explorer never offers them early. New assertion kind: `pixels` `{ region, compare: 'vs_previous_step'|'vs_reference', minChangedPct?, maxChangedPct? }`. Design point to confirm before building: the replay engine must keep the region snapshot after each coordinate action so an assertion can refer to it.

## Canvas bench (the ground truth the models are scored on)
Same idea as the todo-app bench, in a NEW fixture so past comparisons stay valid (`bench/fixtures/todo-app/` and `bench/mutations.json` are not touched).

`bench/fixtures/canvas-app/`: one small app drawn entirely on a canvas: three buttons, a toggle, a slider, a draggable card, a swatch grid, a text label, with an internal hit-test map. Every object has a known true box.

Planted canvas bugs (each a mutation, plus a clean variant for false alarms):
- hit area offset from the drawn shape
- button drawn but no handler
- drawn state disagrees with real state (toggle shows ON, state is off)
- label clipped or overlapping
- wrong colour after an action
- drag drops at the wrong place
- coordinates wrong at device scale factor 2 (a classic canvas bug)

Two scores: **pointing** (hit rate and pixel error of `locate` against the true boxes, at several viewports and DPRs) and **finding** (does the agent report each planted bug, with a replay that fails on the bug and passes on the clean app).

## Models and hosting: decide by measuring, not first
Phase 0 runs the pointing bench on the models already wired, and the result picks the hosting.

| Option | Pick it when | Cost / risk |
|---|---|---|
| **Meta Muse Spark 1.3** (`meta` provider, already in `src/llm.mjs`) | It points well enough: say 90% hits within about 15 px on a 1280x800 page | $150 credit, claimed. Best story for a Meta hackathon. Earlier single-screenshot test: 94% on planted visual bugs. |
| **Baseten Spark Open** (already wired) | Same test, as a cheaper second opinion | Weaker on the earlier visual test (80%). |
| **Fireworks** | Spark cannot point. OpenAI-compatible, so adding it is a few lines like Baseten, and a Qwen-VL class model with grounding may be served | $25 credit, NOT confirmed claimed. I have not checked their current catalog. Need a key in `.env` (Manny adds it, never pasted in chat). |
| **Modal** | We want a real detector with calibrated scores (open-vocabulary detector, segmentation) that no API serves | $100 credit, NOT confirmed claimed. A deploy to write and test, cold starts. Probably not worth it before 11/04. |
| **hardac2** (RTX 4080 SUPER) | Free local experiments with an open VLM while developing | Judges cannot reach it, so not for anything the submission depends on. |

Check the hackathon rules on which models are allowed before leaning on anything that is not Meta's. They are still unverified.

## Phases (cut lines in brackets)
- **Phase 0, Thu night to Fri morning, cap $1.50:** build the canvas fixture and the pointing bench; run Spark and Spark Open (`--dry-run` first). Output: a pointing table and the hosting decision. [If both fail, add Fireworks, then stop after one more round.]
- **Phase 1, Fri, CPU only, no spend:** `pixels.mjs` and `hands.mjs`: coordinate actions, before/after capture, A/A noise floor, verdicts; `pixels` assertion; replay of a coordinate action from a fresh browser. Test on the fixture with a scripted click, no model.
- **Phase 2, Sat:** `vision.mjs` with the chosen model; propose, then Márohu verifies; one planted bug found by vision and confirmed by a fresh replay, with its evidence in the store (proposal as `ai_hypothesis`, result as code-authored fact). [If pointing is poor: keep only `diff()` and say so.]
- **Phase 3, Sat to Sun:** `semantic.mjs`: a11y findings and `blindPct`; the explorer switches on the visual senses when `blindPct` is high. [Cut first if time is short.]
- **Phase 4, Sun:** apply to Music Blocks (needs the clone go-ahead): canvas-region diff between v3.7.1 and v3.8.0 as release facts, next to the DOM facts, plus a "load example project, press play, compare exports" scenario if time allows. Evidence tiles show before, after and diff.
- **Mon 11/02 and Tue 11/03:** no new features. Recording and submission.

## Spend and safety
- Whole plan cap about $10 of the remaining credits (about $10 of $250 is spent so far; the price table is unverified).
- Every paid run prints a projection first and accepts `--dry-run`.
- `.env` is never read or printed. A new provider key is added by Manny.
- Screenshots of a private app go to the model's API. Phase 0 and 1 use only the fixture, which is public and ours.

## Questions to put to Muse directly
1. Can you point or ground? Output format: boxes or points? Which coordinate frame (normalised 0 to 1000, or pixels of which image size after your internal resize)?
2. Maximum image size, how large images are downscaled or tiled, and the token cost per image.
3. Can two images go in one message to compare before and after, and how reliable is the difference description compared with a pixel diff?
4. Is there any calibrated confidence or logprob? If not, what is the best way to ask for one?
5. How accurate are you on small objects (under 20 px)? Is zooming into tiles recommended?
6. Does the reasoning level change pointing accuracy?
7. Are screenshots sent to `api.meta.ai/v1` kept or used for training, for `muse-spark-1.3`?
8. Rate limits and concurrency for image requests.

## What Muse Code answered (2026-10-29) and what it means
Muse Code answered from this repo, not from knowledge of its own model: every spec (image limits, token formula, resize or tiling, coordinate frame, accuracy, retention, rate limits) came back "unknown", and only facts about our own code were marked observed. So nothing is documented yet and Phase 0 has to measure it. Nothing it said contradicts the plan. Its useful contribution is the test design below.

## Phase 0 protocol
Fixture screenshots at three sizes (820x900, 1280x800, 1920x1080), about ten known objects each, all in one request per image. Every call asks for JSON `{"targets":[{"label","point","box","found"}]}`.
1. **Frame test.** Ask for three frames on the same images: absolute pixels of the image sent, normalised 0 to 1000, normalised 0 to 1. Keep the frame with the lowest median error. If the pixel error grows with image size, the model is answering in a resized frame, not ours.
2. **Pointing score.** Hit rate (point inside the true box) and median pixel error against the fixture's true boxes. Proposed pass line: at least 90% hits within about 15 px on 1280x800.
3. **Not found.** Clean images where the asked-for object does not exist, about 20 queries. Any coordinate returned with `found:false`, or any invented target, counts as a failure. Proposed pass line: at most 1 in 20.
4. **Stability.** Same image and prompt five times; report the largest pairwise pixel distance and the spread. Then the same with `reasoning_effort` low versus default.
5. **Token cost.** Same text with and without the image; the image cost is the difference in `usage.prompt_tokens`, per size. Read the tall-page case (820x4000) with a marker near the bottom to see whether it is downscaled, tiled or rejected.
6. **Small objects.** Objects under 20 px, full image versus a zoomed crop. Crop mapping is `full = left + x1000/1000 * crop_w` (same for y), done in code.
7. **Confidence.** Ask for a 0 to 1 confidence, bucket the answers, compare each bucket with its real hit rate. Expect it to be uncalibrated.
8. **State reading.** Twenty toggle renders, on and off, count how many it reads correctly.
About 100 calls. The script prints the real projection first and accepts `--dry-run`; the cap stays $1.50.

Not answerable by measuring, so they stay open until Meta's API documentation or terms (or the hackathon organisers) say: data retention and training use for `muse-spark-1.3`, rate limits, and the stated maximum image size. Until then only public fixture screenshots are sent.

## Open decisions
- Add `pixelmatch` and `pngjs` as dependencies (small), or write the diff by hand?
- Canvas fixture lives in `bench/fixtures/canvas-app/`: confirm the name.
- Whether Fireworks and Modal credits are actually claimed.
