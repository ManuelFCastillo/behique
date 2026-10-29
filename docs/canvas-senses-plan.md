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
- **Phase 0: DONE 2026-10-29** (139 calls, about $1.34 estimated; budget now up to $5, ask before more). Canvas fixture and pointing bench built; Spark points well enough, so no Fireworks or Modal. Results below.
- **Phase 1 (DONE 2026-10-29, `pngjs` 7.0.0 added with scripts disabled; the `pixels` assertion kind and session wiring are still to do):** `pixels.mjs` and `hands.mjs`: coordinate actions, before/after capture, A/A noise floor, verdicts; `pixels` assertion; replay of a coordinate action from a fresh browser. Test on the fixture with a scripted click, no model.
- **Phase 2 (DONE 2026-10-29, evidence-store wiring still to do):** `vision.mjs` with the chosen model; propose, then Márohu verifies; one planted bug found by vision and confirmed by a fresh replay, with its evidence in the store (proposal as `ai_hypothesis`, result as code-authored fact). [If pointing is poor: keep only `diff()` and say so.]
- **Phase 3, Sat to Sun:** `semantic.mjs`: a11y findings and `blindPct`; the explorer switches on the visual senses when `blindPct` is high. [Cut first if time is short.]
- **Phase 4, Sun:** apply to Music Blocks (needs the clone go-ahead): canvas-region diff between v3.8.0 and master as release facts (v3.7.1 does not start cleanly; see Music Blocks findings), next to the DOM facts, plus a "load example project, press play, compare exports" scenario if time allows. Evidence tiles show before, after and diff.
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

## Phase 0 results (2026-10-29)
139 model calls to Muse Spark 1.3 (`meta` provider), about $1.34 by the project's unverified price table. Scripts: `bench/canvas-bench.mjs` (experiments `tokens`, `frames`, `stability`, `notfound`, `tall`, `small`, `state`, `diff2`, `mb`, `mbblocks`) on the fixture `bench/fixtures/canvas-app/`. Raw answers and screenshots are in `bench/canvas-runs/` (ignored by git).

**Verdict: Muse Spark can point well enough to click, with the settings below. No Fireworks or Modal is needed to locate objects.**

| Question | Measured answer |
|---|---|
| Coordinate frame | It answers in whatever frame you ask for. Over 36 calls per frame: 0 to 1 decimals ("unit") hit the object 98.9% of the time, median error 0.8 px, 90th percentile 3 px. 0 to 1000 hit 91.7%, median 1.0 px, but a heavy tail (90th percentile 28 px). Pixels hit 91.7%, median 6.0 px, with a steady 2.3% scale bias at 820x900. **Use the 0 to 1 frame.** |
| Image size | Images of about 2 million pixels or more were stable (1920x1080: 9 of 9 calls at 100% hits; 2560x1600: 100% hits, median 0.5 to 1.1 px). Images of about 1 million pixels or less (820x900, 1280x800 at 1x) sometimes came back with one error shared by every object in that call (best calls 100%, worst 20% hits, median 86 px). **Capture at device scale factor 2.** A single DOM anchor cannot correct this: the Help button near the top was fine while the canvas objects in the same call were off. |
| Reasoning level | `low` halves the reasoning tokens (about 620 versus 1,400) with no accuracy loss at 2x (5 of 5 calls perfect both ways). **Use `low`.** |
| Token cost | Text only 15 tokens. One image: 820x900 about 990, 1280x800 about 1,260, 1920x1080 about 2,690, 2560x1600 about 4,000, and 820x6498 about 3,960 (it levels off near 4,000). A typical pointing call is about 4,000 in and 1,300 out, about $0.01 on the unverified price table. |
| Tall pages | 820x2098 worked (3 px error). 820x3498 and 820x6498 failed in every frame (213 to 840 px off), and when asked, the model misstated its own image size ("800x8000"). The limit is between 2,098 and 3,498 px tall; not pinned. **Never send a tall full-page screenshot. Send viewport-sized screenshots or tiles of at most about 2,000 px on the long side, and add scroll offsets in code.** Today's `observe()` uses `fullPage: true`, which must change for the visual senses. |
| "Not found" | 59 queries for objects that are not there: 0 invented. On a blank canvas (Music Blocks v3.7.1, which failed to draw its blocks) it answered "not found" for 42 of 42 asked-for blocks and invented none. |
| Small objects | At 1920x1080 the 14 to 16 px checkbox, gear and slider knob: 100% hits, median 0.6 px, from the full image. Zoomed crops (480x300) did worse: 50% hits, median 11.7 px. **Resolution helps, cropping does not.** At 2x, small objects were fine. |
| Confidence | Not calibrated. 960 answers: the 0.98 to 1.0 bucket hit 98%, but answers more than 50 px off averaged confidence 0.970 (higher than correct answers, 0.966), and 50 of 73 misses had 0.95 or more. **Confidence cannot catch gross errors; verification by Márohu must.** |
| State reading | 12 of 12 renders read correctly on all four properties (toggle on or off, checkbox, selected colour, status line text). |
| Two images | Before and after in one request: all 4 real changes listed in 5 of 5 calls (5 to 6 items each, counting changed labels), and 0 differences listed on 3 identical pairs. Only large changes tested; small and subtle changes are not measured, so the plan keeps the code pixel diff as the detector and uses the model only to describe. |
| Real app, DOM icons | Music Blocks toolbar, truth from DOM: v3.7.1 9 of 9 icons, v3.8.0 8 of 8, all calls 100% hits, median 0.5 to 1.1 px at 2x. It also answered "not found" for the Stop icon in v3.8.0 (3 of 3), where the DOM confirms it is not shown when idle. |
| Real app, canvas blocks | v3.8.0 with `examples/pi.tb` loaded; truth from the app's own block model (checked once against an overlay). At 2x: 100% hits, median 2.2 to 2.7 px (3 of 3 calls). At 1x: 100% hits but median 3.8 to 15 px. Absent objects never invented. |

Not answered by measuring (still open): data retention and training use, rate limits, the stated maximum image size.

## Music Blocks findings (2026-10-29)
Upstream `sugarlabs/musicblocks` is cloned at `~/dev/behique-apps/musicblocks` (partial clone, 327 MB), with worktrees `mb-v3.6.2`, `mb-v3.7.0`, `mb-v3.7.1`, `mb-v3.8.0` beside it. `mb-serve.mjs` serves any checkout with the same `/env.js` override as the project's own `index.js` and needs no install (`npm install --omit=dev --ignore-scripts` was run once in the v3.7.1 and v3.8.0 worktrees to compare against the official server; not needed afterwards).

- **Corrects my earlier advice.** The comparison pair should be **v3.8.0 vs master** (e7214ff3, 2026-10-29, 695 commits later), not v3.7.1 vs v3.8.0. Both v3.8.0 and master start cleanly. v3.7.1 starts with `_ is not defined` in `js/logoconstants.js` and draws only the toolbar and an empty workspace, even under the official server. v3.7.0 and v3.6.2 do not start from source here (several script errors).
- **"No install" was wrong for v3.8.0 as plain files.** Its static `env.js` says production and the page then fails with `docById is not defined`; with the development `/env.js` (what `index.js` serves) it starts. That is a difference in how it is served, not a claim about the release.
- **Semantic changes, v3.7.1 to v3.8.0.** Toolbar entries went from unnamed list items (accessible text is the icon name, such as `play_circle_filled`) to named buttons ("Play project", "Save project"); the tour became a labelled dialog; a "Block Palettes" region appears. v3.8.0 shows no Stop icon when idle.
- **Semantic changes, v3.8.0 to master.** Canvas blocks now appear in the accessibility tree as a "Workspace Blocks" region with one `... block` element each (31 on the default project), but each element has zero height and no position (static at the bottom of the page). So Macocael can say WHAT is on the canvas and Boinayel can say WHERE: this is the semantic-versus-visual consistency check. Also on master: a new "Start tracking my project" button, "Find and share projects" renamed "Git Planet", Fullscreen moved.
- **App model.** v3.7.1 exposes `window.activity`; v3.8.0 and master removed it (deprecation warning) in favour of `ActivityContext.getActivity()`. Block positions from `block.container.localToGlobal(0, 0)` match the drawn blocks. Project files in `examples/*.tb` load with `activity.blocks.loadNewBlocks`.

## How the senses get added to Behique (build order)
1. **`src/senses/pixels.mjs`** (no model). PNG decode, masked region diff, A/A noise floor, changed-region boxes. Needs `pngjs` (and maybe `pixelmatch`): ask before adding.
2. **Capture policy** (a small function used by every sense): device scale factor 2, viewport-sized screenshots or tiles of at most about 2,000 px on the long side, scroll offsets recorded so every point maps back to the page. Replaces `fullPage: true` for the visual path only; the existing explorer is untouched.
3. **`src/senses/vision.mjs`** (Boinayel). `locate(shot, queries)` returns Targets in the 0 to 1 frame, reasoning `low`, `found:false` allowed, one retry on a parse failure, never a confidence taken at face value. `describeDiff(a, b)` is optional narration; the detector is `pixels.mjs`.
4. **`src/senses/hands.mjs`** (Márohu). `clickAt`, `dragTo`, `key`, each with before and after capture, a region diff above the noise floor, requests and console since the action, and a verdict. A target is trusted only after its verdict matches the prediction.
5. **Session and replay.** New action types `click_at` and `drag` (normalised points plus viewport and scale factor), kept out of `ACTION_TYPES` until they replay reliably; new assertion kind `pixels`; replay re-captures at the same viewport and scale factor.
6. **`src/senses/semantic.mjs`** (Macocael). `blindPct` (share of the page covered by canvases with nothing accessible inside), a11y findings, and the semantic-versus-visual check (the tree lists N blocks, vision finds M).
7. **Release pipeline.** Canvas-region diffs above the noise floor, plus the a11y tree diff, as release facts for v3.8.0 vs master. The model's locations are recorded as hypotheses; Márohu's verdicts as code-written facts.
8. **UI.** Evidence tiles with before, after and the diff; the senses page (`/senses`) updated as each piece lands.

Cut first if time runs short: Guabancex (after Phase 2), then step 6 findings, then step 8. Keep: steps 1 to 5 and the Music Blocks run.

## Phase 2 results (2026-10-29)
Built: `src/senses/vision.mjs` (Boinayel: one call lists the controls it sees, in the 0 to 1 frame, from a viewport screenshot at device scale 2, reasoning low), `src/senses/canvas-qa.mjs` (rules per kind of control, the hands, replay) and `bench/canvas-find.mjs` (the scored run). The fixture got seven planted behavioural bugs behind `?bug=<id>` (`bench/fixtures/canvas-app/bugs.json`); every variant is pixel-identical to the clean app at load (checked, 0 pixels). The model is told nothing about bugs. Each finding is a verdict from the pixels (a click on a button changed nothing; a switch, checkbox, swatch or icon did not change at its own spot; a slider or card was dragged and its destination did not change), then repeated in 3 fresh browsers.

| Run | Model | Bugs found, reproduced 3 of 3 | Clean app | Other findings | Cost |
|---|---|---|---|---|---|
| 1 (4 bugs, 3 reps) | Spark 1.3 | 12 of 12 | 0 of 3 runs flagged | 0 | $0.03 |
| 2 (6 detectable bugs, 3 reps; 3 new bugs added after run 1) | Spark 1.3 | 18 of 18 (6 of 6 on the two held-out bugs) | 0 of 3 | 0 | $0.03 |
| 2 | Spark Open | 18 of 18 | 0 of 3 | 0 | $0.03 |

Note on run 2: 7 bugs are planted, 6 are detectable by the rules, so 6 bugs times 3 reps is 18. The 3 added bugs (`toggle-dead`, `reset-dead`, `start-typo`) were written after the rules were fixed, and the rules caught both detectable ones (6 of 6 runs). `start-typo` (Start sets the status text to a wrong word) is a KNOWN BLIND SPOT: the screen changes, so pixel rules see nothing wrong; it was flagged in 0 of 3 runs on both models. Catching it needs the model to read the screen and compare it with what the app should say.

Vision on the clean screenshot: both models listed 15 controls every time, all 15 on a real object, 0 invented, covering 14 of 14 real canvas controls (the 15th is the page's own DOM Help button, which the hands skip as "not a canvas target" and leave to the semantic sense). Code guards: a target that is not on a canvas, or is over nothing but background (an invented control), is skipped and never clicked.

What this does NOT show:
- The fixture is easy: 15 clearly drawn controls on a plain background, bugs of two kinds (a control does nothing, a control acts on the wrong thing), one screenshot reused for all reps, so the three vision calls differ only by the model's own noise.
- The "own spot" radius (32 CSS px) was chosen after the first oracle run showed a swatch's selection ring sits outside a 24 px radius. It is a per-app heuristic. Held-out bugs used the same rule types, so they test the hands and the guards, not a new idea.
- A perfect-vision oracle test (`src/senses/canvas-qa.test.mjs`, controls taken from the fixture's own layout) finds every detectable bug and nothing on the clean app: the hands and rules are sound without a model; the model's contribution is knowing where the controls are.
- Not tried: a real app (Music Blocks), animation (the noise floor is 0 only because the fixture is static), tall pages, apps where controls look unusual.
- Evidence store: done afterwards, see `docs/STATUS.md` (canvas section). Not done: giving the hands to the explorer.

## Music Blocks results (2026-10-29)
Real app, two versions: v3.8.0 (port 8814) against master e7214ff3 (8815), both served locally. Script `bench/mb-senses.mjs`, run `bench/canvas-runs/2026-10-29T20-31-20-mb-meta`, Spark 1.3, 4 model calls, about $0.07. Only the public, open-source app is sent to the model, and external requests are blocked.

**Noise floor (measured first, and it was not zero).**
- Idle, one browser at a time: 0 pixels of difference across 4 loads at each of 4 checkpoints (loaded, tour closed, 1 s and 4 s after Play, after stop), on both versions.
- With 8 browsers at once: 6,977 pixels differed 0.7 s after Play (both versions) and 598,285 on master 2.2 s after Play, and pages were still booting when a fixed 6 s wait ended. A fixed wait is a guess about timing. So `hands.settle()` now waits until the viewport stops changing, every page load settles before any picture is taken, and the run uses 2 browsers at a time.
- With that, repeating the same click in fresh pages (A against B): after-screens identical for 26 of 31 controls on v3.8.0 and 31 of 33 on master. The differences: 3.9k to 6.1k pixels for the home, fit-to-screen and zoom buttons, 801k for two palette flyouts (Pitch, Intervals) that did not render the same twice, and 1.3k to 1.6k on two master icons. One of 32 verdicts flipped on v3.8.0 because that page was still on its loading screen; 0 of 33 on master. Controls that flip are now excluded from the comparison and listed.

**Vision on a real app.** The model listed 48 and 49 controls on v3.8.0 and 55 and 52 on master (toolbar, palette, canvas blocks and more); 32 and 33 clickable ones were probed, the rest (the blocks) are draggable and were not clicked.

**The rule that works on the test app does not work here.** 129 of 130 clicks changed pixels (1 was skipped on the loading screen). On Music Blocks almost every click opens a menu, dialog or mode, so "did anything change" cannot find a dead control. There are no planted bugs in Music Blocks, so this run says nothing about recall on a real app.

**Version comparison.** The useful output is the difference between versions, found by matching controls and comparing:
- 30 controls matched; 6 toolbar controls moved (master groups fullscreen, help and menu at the right and reorders the rest);
- 1 control exists only on master: a version-control icon whose page label is "Start tracking my project", and clicking it changes 136k pixels;
- the model described the same palette tab icons with different words in the two versions, so 4 controls showed up as added or removed that were not: label matching is noisy, and the page's own label for the element (when it has one) is the better key;
- outside the toolbar, the restyled welcome tour and a dark strip on the left and right edges of master (7k and 16k pixels), the canvas is pixel-identical: the blocks did not change.
None of this says a difference is a bug. A person judges each one.

Not done: planting bugs in Music Blocks, dragging blocks, example projects, anything on a tall page. Not tried: Spark Open on Music Blocks.

## Models: what we use and why (2026-10-29)
Meta's product page lists Muse Spark 1.3 as the newest standard model (older: 1.2 and 1.1; the cheaper "contributor" tiers are used to improve Meta's products, so we never use them). So `meta` / `muse-spark-1.3` already IS the most capable standard model we can call. The remaining choice is the reasoning level and which job gets which model.

| Job | Model and setting | Evidence |
|---|---|---|
| Explorer (finding bugs) | Spark 1.3, default reasoning | Found 13 of 27 planted bugs against 10 of 27 for Spark Open (one run each). Tuning found no setting that beat the default; `low` is 30% cheaper. |
| Hypothesis on the bisected commit | Spark 1.3, reasoning low | One call, about $0.006. |
| Pointing (Boinayel) | Spark 1.3 or Spark Open, screenshots at device scale 2, 0 to 1 frame, reasoning low | Both perfect at 2x (Spark 1.3: 15 of 15 calls; Spark Open: 5 of 5, median 0.5 to 1.0 px). |

**More reasoning does not help perception.** On the unstable case (1280x800 at 1x, 5 calls each), hits per call were: low 100/20/87/100/53%, high 53/60/40/87/60%, xhigh 60/93/60/100/93%. It also nearly doubled the output tokens (about 2.9k to 3.5k versus 1.3k to 2.0k). On tall pages xhigh still failed (92 to 272 px off at 3,498 px tall, 476 to 717 px off at 6,498). The errors come from how the image is encoded, so the fix is resolution and framing, not more thinking.

**The best model depends on the job.** At 1280x800 at 1x, Spark Open on Baseten hit 98.7% (5 calls, 75 answers) while Spark 1.3 on Meta's API hit 75.2% (30 calls). Spark 1.3 is better at bug finding and equal at 2x. So pick per job and measure, not by leaderboard.

## Leviathan ideas that fit the senses
Leviathan's lessons (a completion check instead of the model's own "done", a script that verifies rather than the model, a judge that gets no tools, different models whose misses differ) map onto the senses without building the ring itself:
- **Cross-model agreement catches bad pointing.** At 1280x800 at 1x, Spark 1.3's missed answers disagreed with Spark Open by more than 15 px 96% of the time (79 of 82), against 23% of its correct answers (56 of 248; a fixed 15 px is strict for large objects, so the threshold should scale with the object). Self-reported confidence caught none of them. Use it as a safety net when an image is small or tiled; at 2x one call is enough. Small sample: 5 Spark Open calls, one resolution.
- **A completion check for canvases.** The explorer already tracks untouched DOM controls. The canvas version: every target Boinayel locates must be clicked by Márohu at least once, and every block the accessibility tree lists must have a located twin (semantic versus visual).
- **Verification stays a script.** Márohu's verdict is code. A text-only judge model may narrate the evidence, as the hypothesis step does, and gets no tools.
- **Not worth building before the deadline:** wiring Behique into the Leviathan ring UI or its orbs.

## Measuring performance
Two separate things.

**1. How well do the senses work (a scorecard for Behique).** `bench/canvas-bench.mjs` already measures most of it; a `scorecard` experiment would collect it in one table, tracked per commit:
| Measure | Today |
|---|---|
| Pointing: hit rate, median error, 90th percentile | measured (Phase 0) |
| "Not found" false positives | 0 of 59 |
| Stability across repeats | measured on pointing; not on verdicts |
| Verdict accuracy: the click did what the target predicted | built (`hands.act`); tested on the fixture only, not yet scored on model targets |
| Replay reliability: a verified click reproduces N of N on a fresh browser | 3 of 3 on the fixture (`hands.replay`) |
| Noise floor: pixels that differ between two runs of the same version | 0 pixels on the fixture across 3 loads; not measured on Music Blocks |
| Finding bench: planted canvas bugs found, with replays that fail on the bug and pass on the clean app (recall, false alarms) | not built; needs `mutations.json` for the canvas fixture |
| Latency per call | about 6 to 9 s per pointing call (logged) |
| Tokens and cost per call and per finding | logged |
| End to end on Music Blocks: difference found, commits to bisect | not built |

**2. How does the app under test perform (Guabancex, proposed).** See below.

## Proposed fourth sense: Guabancex (performance)
Proposed by Manny: a separate performance sense. Canvas and WebGL apps are exactly where frame rate and load time regress between releases, and accessibility and pixels cannot see it.
- **File (planned):** `src/senses/performance.mjs`. No model.
- **What it measures:** page load time, long tasks, JavaScript heap growth, requests and bytes transferred, and frame rate or frame time during a scripted action (Playwright plus the Chrome DevTools `Performance.getMetrics` call, a `PerformanceObserver` for long tasks, and a `requestAnimationFrame` sampler).
- **How it judges:** repeat each measurement N times per version, compute the A/A noise floor (rule 5), and report a regression only when it exceeds the floor. Results are written as code-authored `statistical` claims.
- **Caveats:** numbers are only meaningful as version against version on the same machine. Headless Chromium uses software rendering unless GPU flags are set, which matters for WebGL and WebGPU apps. Music Blocks logs "Idle mode: Throttling to 1 FPS", so frame rate must be sampled while something is running, not at rest.
- **Where it sits (decided by Manny, 2026-10-29):** after Phase 2, and it is the first thing cut if time is short (before the Macocael findings in step 6). It has a card on the `/senses` page.

## Open decisions
- ~~Is Guabancex in scope?~~ Decided: after Phase 2, cut first. Card added to `/senses`.
- Add `pixelmatch` and `pngjs` as dependencies (small), or write the diff by hand?
- Canvas fixture lives in `bench/fixtures/canvas-app/`: confirm the name.
- Whether Fireworks and Modal credits are actually claimed.
