---
part: picture
owns:
  - src/release/visual/picture.mjs
  - src/release/visual/picture.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/senses/pixels.mjs
  - src/senses/hands.mjs
  - src/release/onboard/profile.mjs
test: node --test src/release/visual/picture.test.mjs
allow: [external_network]
---
# Part 2: settled pictures of an app

Takes a picture of a running app that is stable enough to compare, and compares regions of two pictures against a measured noise floor.
This is the visual counterpart of the page "facts" the FreshRSS checks use. It works on any app profile (part 1; read `profile.mjs` for the shape:
`viewport`, `setup`, `regions`, `anchors`, `blockHosts`).

## `picture.mjs` must export

- `openSettled(browser, url, profile) -> Promise<{ ctx, page, png, settled, ms, errors, blocked }>`
  Creates a context with `profile.viewport` (`width`, `height`, `deviceScaleFactor`), blocks every request whose host is not `127.0.0.1` or `localhost`
  (unless `profile.blockHosts === false`; `data:` and `blob:` URLs stay allowed) and records each blocked URL in `blocked`, records page errors (`pageerror`, message cut to 120 characters)
  in `errors`, goes to `url`, then waits with `settle(page, { stableMs: 1500, pollMs: 300, maxMs: 40000 })` from `src/senses/hands.mjs`. Then runs each `profile.setup` step in order:
  `click_at` does `page.mouse.click(x, y)`, `wait` waits `ms`, `press` presses `key` on the keyboard; after each step it settles again (`stableMs: 1500, pollMs: 300, maxMs: 20000`).
  `png` is the last settled picture and `settled` is true only if every settle reached a stable picture. The caller closes `ctx`.
- `pictureOf(url, profile, { browser = null } = {}) -> Promise<{ png, settled, ms, errors, blocked }>`: uses the given browser or launches and closes its own (`chromium` from `playwright`), always closes the context.
- `measureFloor(url, profile, { loads = 3, browser = null } = {}) -> Promise<{ n, changed, regions }>`: takes `loads` separate pictures of the SAME url (separate fresh contexts, one after another) and returns the noise floor:
  `changed` is the largest whole-picture difference between any two of them (use `noiseFloor` from `pixels.mjs`), and `regions` maps each name in `profile.regions` and `profile.anchors` to the largest number of changed pixels
  INSIDE that region between any two pictures. Regions are in CSS pixels; pictures are `deviceScaleFactor` times larger, so scale them with `scaleBox`. Throws if a load did not settle.
- `regionReport(refPng, png, name, region, { floor = null, scale = 2, tolerance = 0 } = {}) -> { name, region, changed, inRegion, above }`
  `inRegion` is `diff(refPng, png, { tolerance, region: scaleBox(region, scale) }).inRegion` and `changed` the whole-picture count. `above` is `aboveFloor({ changed: inRegion }, { changed: floor?.regions?.[name] ?? 0 }, { minPixels: 4 })`.
  If the two pictures have different sizes, `above` is true and `inRegion` is the whole picture.
- `anchorsOk(refPng, png, anchors, { floor = null, scale = 2 } = {}) -> { ok, failed }`: every anchor (a region that should not change between versions, such as the part of the workspace that did not change) must not be `above`; `failed` lists the names that are.
  An app whose anchors differ is probably broken, not changed in the region of interest.
- `unitBox(box, viewport)`: not needed. Do not export anything else.

## Tests (`picture.test.mjs`)

Pure functions first, with synthetic pictures from `blank`, `paint` and `encode` in `pixels.mjs`: `regionReport` counts changes only inside the region and applies the floor and the 4 pixel minimum, scales a CSS region by `scale`, and treats a size mismatch as above;
`anchorsOk` lists failing anchors. Then browser tests with headless Chromium against a tiny local `http://127.0.0.1` server the test starts (an HTML page with a coloured box and, for the setup test, a button that changes the colour when clicked):
`pictureOf` returns a settled picture of the expected size (viewport times scale); two pictures of the unchanged page differ by 0 pixels; `measureFloor` of the static page gives `changed: 0` and 0 for each region;
a `click_at` setup step changes the picture (compare with and without the step); a request to an external host (`http://example.invalid/x.png` in an `<img>`) is blocked and listed in `blocked`; a page that keeps changing (a CSS animation or a timer that changes the colour every 100 ms) returns `settled: false` after a short `maxMs`
(make `maxMs` for the load settle overridable through an optional `profile.settle` object, `{ stableMs, pollMs, maxMs }`, so the test is fast; default values as above).
