---
part: visual-view
owns:
  - src/release/ui/visual-view.mjs
  - src/release/ui/visual-view.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/visual/evidence.mjs
  - src/release/viewmodel.mjs
  - src/release/evidence.mjs
test: node --test src/release/ui/visual-view.test.mjs
allow: []
---
# Part 11: what the dashboard shows for a visual check

A visual check keeps its result in the evidence store (see `src/release/visual/evidence.mjs`). The dashboard needs that result as plain data: which regions differ, by how
many pixels against what noise, the pictures, and the first commit if a search ran. This part is one pure function that reads a case and returns that data. A person
merges it into the dashboard view-model afterwards. It never writes to the case, creates no folders and calls no network or model.

## The record it reads

An evidence case `c` (from `openCase`) has `c.read()` (the events), `c.artifactPath(hash)` (a file path or `null`) and artifacts named in `artifact` events (`{ hash, name, mediaType }`).
A visual case has `case.opened` with `kind: 'visual'`, and (written by a person right after this spec is built, so build against this shape) one event
`visual.regions` with data `{ regions: [{ name, box: { x, y, w, h }, inRegion, floor, above }], anchorsFailed: [string], scale }` (`inRegion` pixels that differ, `floor` the noise for that region, `above` true when it differs by more than noise, `box` in CSS pixels).
Artifacts: `good-picture.png`, `candidate-picture.png`, `floor.json` (`{ n, changed, regions }`), `diff-<region name>.png` for each region that differs, and after a conclusive search `parent-picture.png` and `first-bad-picture.png`, plus `bisect.json` (`{ result, log }`).
Claims with label `reproduced_failure` mean the first changed commit was proven (the search result in `bisect.json` has `commit`, `parent`, `subject`, `author`, `date`, `files`, `url`, `changes`, `steps`, `conclusive`, `verified`). Older visual cases may have no `visual.regions` event.

## `visual-view.mjs` must export

### `visualView(c, { caseId }) -> object | null`
Return `null` when the case is not `kind: 'visual'` (including an empty case). Otherwise return:
```
{
  kind: 'visual',
  regionsKnown: boolean,            // false when there is no visual.regions event (an older case)
  regions: [{ name, box, changed, floor, differs, diff }],   // from visual.regions; diff is a picture URL or null; differs = above
  anchorsFailed: [string],
  pictures: { good, candidate, parent, first },              // URLs or null
  floor: { loads, changed } | null,                          // from floor.json: loads = n, changed = whole-picture noise
  summary: string,
  search: null | { found, proven, commit, subject, author, date, files, url, changes, steps }
}
```
- URLs are `/api/artifact-image?id=<encodeURIComponent(caseId)>&hash=<hash>`, only for an artifact whose `mediaType` is `image/png` and whose hash is 64 lowercase hex characters; otherwise `null`. Find artifacts by their exact `name` (the last one with that name wins).
- `regions[].diff` is the URL of `diff-<name>.png` for that region, if it exists.
- `summary` (no long dash character, plain words): with regions known and at least one differing: `<k> of <n> regions differ by more than the noise: <names, comma separated, in the order given>.`; none differing: `No region differs by more than the noise.`; regions unknown: `This report predates the region data; see the claims for the details.`. When `anchorsFailed` is not empty append ` The anchor regions <names> also differ, so the app may be broken, not only changed.`
- `search`: `null` when there is no `bisect.json`. Otherwise read it (parse errors give `null`, never throw) and fill from `result`; `found` is `result.conclusive === true`; `proven` is `found && result.verified === true` AND at least one `reproduced_failure` claim cites the `bisect.json` artifact hash in its `evidence` list (a claim that does not cite it never makes a search `proven`). `commit` is the full sha or `null`.
- Never throw on a damaged or partial case: a missing artifact file, bad JSON or an unknown event just leaves that part `null` / empty.
- Text from the record (`subject`, `author`, region names) is returned as it is, never as HTML.

### `regionLabel(name) -> string`
`'left-edge'` gives `'Left edge'`: dashes become spaces and the first letter is upper case. Anything that is not a string gives `''`.

## Tests (offline)

Build real cases in a temporary directory with `openCase` (`mkdtempSync(join(tmpdir(), ...))`), using `blank` and `encode` from `src/senses/pixels.mjs` for pictures and the same `claim`/`artifact`/`event` calls `recordVisualCase` makes. Cover: a case with two regions where one differs (names, boxes, `differs`, diff URL for the differing one only, summary text); no region differs; an older case with no `visual.regions` event (`regionsKnown: false`); a case that is not visual and an empty case return `null`; a search that is conclusive and verified with a `reproduced_failure` claim citing `bisect.json` (`proven: true`), the same without the claim (`proven: false`, `found: true`), and an inconclusive one; anchors failed text; a non-PNG artifact never becomes a URL; a damaged `bisect.json` gives `search: null`; `regionLabel` cases.
