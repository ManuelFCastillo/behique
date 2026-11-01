---
part: canvas-check
owns:
  - src/release/canvas-check.mjs
  - src/release/canvas-check.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/senses/pixels.mjs
  - src/release/shots.mjs
test: node --test src/release/canvas-check.test.mjs
allow: []
---
# Part 30: canvas regions in the main check

The main check records facts from the DOM, so a `<canvas>` is one element with no content to compare, and a canvas app only gets the separate visual bisect. This part gives every large canvas on a recorded page its own pixel verdict inside the main check: the canvas boxes are measured on the page, the screenshots the check already takes (two of the good version, one of the candidate) are compared inside each box, the second good screenshot is the noise floor, and the result is recorded as a verified fact. A changed drawing is something a person would notice, so it ranks like a text change. No model, no browser in the tests: the page script is exported as a self-contained function to pass to `page.evaluate`, and everything else works on PNG buffers from `src/senses/pixels.mjs`.

## `canvas-check.mjs` must export

### `measureCanvases()`
A function with no free variables (it runs inside the page through `page.evaluate(measureCanvases)`), returning for every `<canvas>` element `{ x, y, w, h, visible, id, cls }` from `getBoundingClientRect()` (viewport coordinates in CSS pixels, rounded), `visible` false when the rect has no area or the computed style has `display: none` or `visibility: hidden`, `id` the element id or `''`, `cls` the class attribute or `''`. The tests call it with a fake `document` passed by binding `globalThis.document` and `globalThis.getComputedStyle` before the call, so it must use only those two globals.

### `pickCanvases(list, viewport, { minW = 200, minH = 150, max = 4 } = {})`
From the measured list, keep the visible ones, clip each box to the viewport (`{ width, height }`), drop boxes smaller than `minW` by `minH` after clipping, sort by area descending, keep at most `max`, and return `[{ x, y, w, h, label }]` with `label` = `canvas 1 (800x600 at 100,80)` numbered in that order (the id, when present, replaces "canvas n": `#stage (800x600 at 100,80)`).

### `compareCanvases({ goodA, goodB, cand, boxes, dpr = 1, minPixels = 4, margin = 1.5 })`
`goodA`, `goodB`, `cand` are PNG buffers of the same size (the check's screenshots at the step), `boxes` from `pickCanvases`, `dpr` the device scale factor the screenshots were taken at (boxes are CSS pixels; scale them with `scaleBox`). For each box: `floor` = `diff(goodA, goodB, { region }).changed` (two runs of the same version), `changed` = `diff(goodA, cand, { region }).changed`, `ratio` = changed pixels over the box area, `above` = `changed > Math.max(minPixels, Math.ceil(floor * margin))`. Returns `[{ box, label, floor, changed, ratio, above, text }]` where `text` is `<label>: <changed> pixels changed in the candidate (noise floor <floor>), a drawing a person would notice` when above, or `<label>: no change beyond the noise floor (<changed> of <floor> allowed)` otherwise, numbers with `toLocaleString('en-US')`. When the three PNGs differ in size, throw `the screenshots differ in size`. When `boxes` is empty, return `[]`.

### `diffCanvasPng(goodA, cand, box, dpr = 1)`
The diff picture (`diffImage` from pixels.mjs) cropped to the scaled box, as a PNG buffer: decode, diff, then copy the box's pixels into a new image of the box's size with `blank` and a pixel loop (no new dependency).

### `recordCanvases({ ev, step, label, goodRef, candRef, results, pngs: { goodA, cand }, dpr = 1 })`
Writes to the evidence case: one `canvas.compared` event with `{ step, label, results: [{ label, box, floor, changed, ratio, above }] }` (always, even when nothing is above the floor), and for each result that is above the floor, the cropped diff picture as an artifact named `canvas-<step>-<n>-diff.png` (`image/png`) and one `verified_fact` claim whose text is `At step <step> (<label>), <result.text>. Good: <goodRef>. Candidate: <candRef>.` citing that artifact. Returns `{ changed: <count above>, claims: [seq...] }` where `seq` is what `ev.claim` returns. `ev` has `event(type, data)`, `artifact(name, buffer, mediaType) -> hash`, `claim(label, text, { evidence }) -> seq`, exactly as `openCase` returns.

### `canvasNotice(result)`
`{ cls: 'visible', why: 'a drawing changed on the canvas' }` when `result.above`, else `{ cls: 'churn', why: 'the canvas drawing is within its noise floor' }`.

## Tests (offline, synthetic PNGs built with `blank`, `paint` and `encode` from pixels.mjs)

Cover: `measureCanvases` against a fake document with three canvases (one hidden, one zero-size, one visible) using the two globals; `pickCanvases` clipping, size filter, order, `max`, labels with and without id; `compareCanvases` with a box where only the candidate differs (above), one where goodB differs as much as cand (not above, floor), one with fewer than `minPixels` changed, an empty box list, and a size mismatch; `diffCanvasPng` returns a PNG of the box's size with the changed pixels inside; `recordCanvases` with a fake `ev` that collects calls: one event always, one artifact and one claim per changed box, none when nothing changed, the claim cites the artifact's hash; `canvasNotice` both ways.
