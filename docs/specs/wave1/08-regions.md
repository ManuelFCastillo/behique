---
part: regions
owns:
  - src/release/visual/regions.mjs
  - src/release/visual/regions.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/senses/pixels.mjs
  - src/release/visual/picture.mjs
  - src/release/onboard/profile.mjs
test: node --test src/release/visual/regions.test.mjs
allow: []
---
# Part 8: propose the regions to compare

The visual check compares named regions of two pictures of an app, and today a person draws those regions by hand. This part looks at two pictures
(the good version and the candidate) and PROPOSES the regions where they differ. It only proposes: a person looks at the boxes and approves them
before they are saved into a profile. It is pure computation on PNG buffers, with no browser and no I/O, so every test is offline.

## `regions.mjs` must export

### `proposeRegions(refPng, png, options) -> { regions, total, sizeMismatch, ignored }`
Options: `{ scale = 2, noisePngs = [], cell = 8, pad = 4, minPixels = 4, maxRegions = 6, tolerance = 0 }`.
Use `decode` from `src/senses/pixels.mjs` and compare pixels yourself (you need a per-pixel mask; `diff` only returns counts). `scale` is the device scale factor: pictures
have `scale` times as many pixels as CSS pixels, and every box you return is in CSS pixels.
1. **Noise mask.** `noisePngs` are other pictures of the SAME version as `refPng` (a person or the check takes them when it measures the noise floor). A pixel
   that differs between `refPng` and any noise picture, or between any two noise pictures, is volatile: it is never counted. `ignored` is the number of volatile pixels.
2. **Changed pixels.** A pixel is changed when any channel differs by more than `tolerance` between `refPng` and `png` and it is not volatile. If the two pictures
   have different sizes, return `{ regions: [], total: 0, sizeMismatch: true, ignored: 0 }` (a size change is not something to box).
3. **Cluster.** Cut the picture into square cells of `cell * scale` image pixels. A cell is "on" if it holds at least one changed pixel. Join "on" cells that touch,
   including diagonally, and ALSO join "on" cells separated by exactly one empty cell (so a thin strip with small gaps stays one region). Each group is one region.
4. **Box.** The bounding box of the changed pixels of the group (not of the cells), divided by `scale`, grown by `pad` CSS pixels on every side, clamped to the
   picture, and rounded to whole CSS pixels (`x`, `y`, `w`, `h`, with `w` and `h` at least 1). `changed` is the number of changed pixels in the group.
5. **Merge, filter, order.** Merge any two boxes that overlap after padding (add their `changed`, take the union box) until none overlap. Drop a region with
   fewer than `minPixels` changed pixels (they still count in `total`). Order by `changed` descending, keep at most `maxRegions`.
6. Each region is `{ name, box: { x, y, w, h }, changed, share, where }`: `share` is `changed / total` (0 to 1), `where` is the plain-English place from the rules below,
   and `name` is the slug of `where` (see `slug`), with `-2`, `-3` added when two regions would get the same name. `total` is all changed pixels in the picture.

### `placeOf(box, width, height) -> string`
`width` and `height` are the picture's size in CSS pixels. First match wins:
- the box covers 60 percent or more of the picture's area: `'most of the page'`
- touches the left edge (`x <= 2`), is at most 10 percent of the width wide and at least 50 percent of the height tall: `'left edge'`; same on the right side (`x + w >= width - 2`): `'right edge'`
- touches the top (`y <= 2`), is at most 15 percent of the height tall and at least 50 percent of the width wide: `'top strip'`; same at the bottom: `'bottom strip'`
- otherwise by the box's centre in a 3 by 3 grid: `'top left'`, `'top'`, `'top right'`, `'left'`, `'center'`, `'right'`, `'bottom left'`, `'bottom'`, `'bottom right'`

### `slug(text) -> string`
Lower case, runs of anything that is not a letter or digit become one `-`, no leading or trailing `-` (`'left edge'` gives `'left-edge'`).

### `toProfileRegions(regions) -> { [name]: { x, y, w, h } }`
The exact shape of `regions` in an app profile (see `validateProfile` in `profile.mjs`; read it so your output passes it). Only the box, nothing else. The result must pass the
profile's region checks: whole numbers, `w` and `h` at least 1.

### `drawProposals(png, regions, { scale = 2 } = {}) -> PNG Buffer`
A copy of the picture with each region's box drawn as a 3 image pixel red outline (255, 0, 0, 255), so a person can see what is being proposed. Use `decode`, `paint` and `encode`
from `pixels.mjs`. Do not change the input buffer. Boxes are CSS pixels: multiply by `scale`. Clip to the picture.

## Tests (offline; build pictures with `blank`, `paint` and `encode`)

- Two identical pictures give no regions and `total: 0`.
- A 7 by 800 CSS-pixel strip painted at the far left of an 1280 by 800 picture (scale 2) gives ONE region named `left-edge`, whose box contains the strip and is at most `pad` bigger on each side.
- Two strips painted on opposite edges give two regions, `left-edge` and `right-edge`, ordered by size.
- Two small squares closer than one empty cell apart become one region; far apart they are two.
- A volatile spot (differs between `refPng` and a noise picture) inside a changed area is not counted, and `ignored` says how many pixels were masked.
- A region under `minPixels` is dropped but `total` still counts it; `maxRegions` is honoured; overlapping padded boxes merge.
- Different sizes give `sizeMismatch: true`.
- `placeOf` for each rule, `slug`, duplicate names get `-2`, `toProfileRegions` output passes `validateProfile` when put into an otherwise valid profile (copy the shape of the profile in
  `src/release/onboard/profile.test.mjs`), and `drawProposals` paints red on the outline and leaves the input unchanged.
