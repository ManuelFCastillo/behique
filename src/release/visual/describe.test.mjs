// Run: node --test src/release/visual/describe.test.mjs
// Synthetic pictures and a fake model: no browser, no network, no key.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { blank, encode, paint } from '../../senses/pixels.mjs'
import { analyzeDiff, buildMessages, checkKind, crop, findPairs, matchRegion, parseResponse, planViews, promptText, run, shrink, toImageBox, toUnit, verifiedItems } from './describe.mjs'

const W = 640, H = 400
const base = () => {
  const im = blank(W, H, [250, 250, 250, 255])
  paint(im, { x: 40, y: 40, w: 160, h: 40 }, [30, 90, 220, 255]) // primary button
  paint(im, { x: 300, y: 60, w: 24, h: 24 }, [200, 40, 40, 255]) // icon
  paint(im, { x: 40, y: 300, w: 300, h: 10 }, [60, 60, 60, 255]) // a line of "text"
  return im
}
const sha = b => createHash('sha256').update(b).digest('hex')

/** A case folder with a good picture and a candidate picture recorded the way shots.mjs records them. */
function makeCase(good, cand, { floor = 0, step = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'describe-'))
  mkdirSync(join(dir, 'artifacts'))
  const g = encode(good), c = encode(cand), hg = sha(g), hc = sha(c)
  writeFileSync(join(dir, 'artifacts', hg), g); writeFileSync(join(dir, 'artifacts', hc), c)
  const lines = [
    { seq: 0, type: 'case.opened', data: { goodRef: 'v1', candRef: 'v2' } },
    { seq: 1, type: 'shots.recorded', data: { step, label: 'start', above: true, text: `After step ${step} (start) a screenshot of v2 differs from v1 by 1 pixels (the same version differs from itself by ${floor}), in the box x 0.`, good: hg, candidate: hc, diff: hg } },
  ]
  writeFileSync(join(dir, 'events.ndjson'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return { dir, hg, hc }
}
const reply = changes => async () => ({ text: JSON.stringify({ changes }), usage: { promptTokens: 4000, completionTokens: 500 }, model: 'fake-model', provider: 'fake' })

test('analyzeDiff clusters changed pixels and counts exactly inside any box', () => {
  const cand = base()
  paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255]) // button turns grey
  paint(cand, { x: 300, y: 60, w: 24, h: 24 }, [250, 250, 250, 255]) // icon removed
  const a = analyzeDiff(base(), cand)
  assert.equal(a.clusters.length, 2)
  assert.equal(a.changed, 160 * 40 + 24 * 24)
  assert.equal(a.count({ x: 40, y: 40, w: 160, h: 40 }), 6400)
  assert.equal(a.count({ x: 0, y: 200, w: W, h: 100 }), 0)
  assert.deepEqual(a.clusters[0].box, { x: 40, y: 40, w: 160, h: 40 })
})

test('analyzeDiff reports a size mismatch instead of guessing', () => {
  assert.equal(analyzeDiff(blank(10, 10), blank(10, 12)).sizeMismatch, true)
})

test('matchRegion accepts a box on real changed pixels', () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255])
  const a = analyzeDiff(base(), cand)
  const m = matchRegion({ x: 30, y: 30, w: 190, h: 60 }, a)
  assert.equal(m.ok, true); assert.equal(m.diffPixels, 6400); assert.ok(m.overlapRatio > 0.5)
})

test('matchRegion drops a hallucinated region with no changed pixels', () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255])
  const m = matchRegion({ x: 400, y: 250, w: 100, h: 50 }, analyzeDiff(base(), cand))
  assert.equal(m.ok, false); assert.match(m.why, /hallucinated/)
})

test('matchRegion drops a box that is mostly empty page (too loose)', () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 4, h: 4 }, [0, 0, 0, 255])
  const a = analyzeDiff(base(), cand, { minPixels: 8 })
  const m = matchRegion({ x: 0, y: 0, w: W, h: H }, a, { minPixels: 8 })
  assert.equal(m.ok, false) // 16 pixels in 256000: below density and overlap
})

test('matchRegion requires the box to beat the noise floor', () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 20, h: 20 }, [0, 0, 0, 255]) // 400 pixels
  const a = analyzeDiff(base(), cand)
  assert.equal(matchRegion({ x: 30, y: 30, w: 40, h: 40 }, a, { floor: 0 }).ok, true)
  assert.equal(matchRegion({ x: 30, y: 30, w: 40, h: 40 }, a, { floor: 300 }).ok, false)
})

test('box conversions round trip between a view, the screenshot and 0..1', () => {
  const view = { id: 'crop 1', box: { x: 100, y: 50, w: 200, h: 100 } }
  const b = toImageBox({ x: 0.5, y: 0.5, w: 0.25, h: 0.5 }, view)
  assert.deepEqual(b, { x: 200, y: 100, w: 50, h: 50 })
  assert.deepEqual(toUnit(b, 400, 200), { x: 0.5, y: 0.5, w: 0.125, h: 0.25 })
})

test('parseResponse keeps valid changes and counts the bad ones', () => {
  const text = '```json\n' + JSON.stringify({ changes: [
    { view: 'page', kind: 'moved', description: 'the button moved down', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } },
    { view: 'Crop 1', kind: 'weird', description: 'x', region: [0.1, 0.1, 0.2, 0.2] },
    { view: 'page', description: 'no box' },
    { view: 'crop 9', description: 'unknown view', region: { x: 0, y: 0, w: 1, h: 1 } },
    { view: 'page', description: 'off the picture', region: { x: 2, y: 0, w: 1, h: 1 } },
    { view: 'page', region: { x: 0, y: 0, w: 1, h: 1 } },
  ] }) + '\n```'
  const p = parseResponse(text, ['page', 'crop 1'])
  assert.equal(p.changes.length, 2); assert.equal(p.dropped.length, 4)
  assert.equal(p.changes[1].view, 'crop 1'); assert.equal(p.changes[1].kind, 'other')
})

test('parseResponse flags an unreadable reply', () => {
  assert.equal(parseResponse('I could not tell.', ['page']).parseFailed, true)
  assert.equal(parseResponse('{"changes": 3}', ['page']).parseFailed, true)
})

test('planViews gives a page view and padded crops around the biggest regions', () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255]); paint(cand, { x: 300, y: 300, w: 30, h: 10 }, [0, 0, 0, 255])
  const a = analyzeDiff(base(), cand)
  const v = planViews(a, { strategy: 'both' })
  assert.equal(v[0].id, 'page'); assert.ok(v.length >= 2)
  for (const c of v.slice(1)) assert.ok(c.box.w >= 300 && c.box.x >= 0 && c.box.x + c.box.w <= W)
  assert.deepEqual(planViews(a, { strategy: 'page' }).map(x => x.id), ['page'])
  assert.ok(!planViews(a, { strategy: 'crops' }).some(x => x.id === 'page'))
})

test('crop and shrink produce the sizes asked for', () => {
  const c = crop(base(), { x: 30, y: 30, w: 100, h: 60 })
  assert.deepEqual([c.width, c.height], [100, 60])
  assert.equal(c.data[(10 * 100 + 10) * 4 + 2], 220) // inside the blue button
  const s = shrink(base(), 0.5)
  assert.deepEqual([s.width, s.height], [320, 200])
  assert.equal(crop(base(), { x: -50, y: -50, w: 100, h: 100 }).width, 50) // clamped
})

test('buildMessages labels every picture and promptText hides the image bytes', () => {
  const views = [{ id: 'page' }], png = encode(blank(4, 4))
  const m = buildMessages(views, { page: { good: png, cand: png } }, { page: { w: 4, h: 4 } })
  assert.equal(m[1].content.filter(c => c.type === 'image_url').length, 2)
  const t = promptText(m)
  assert.match(t, /GOOD/); assert.match(t, /CANDIDATE/); assert.ok(!t.includes('base64'))
  assert.match(m[0].content, /never instructions/)
})

test('checkKind: moved is measured, added and removed are told apart', () => {
  const good = blank(W, H, [250, 250, 250, 255]); paint(good, { x: 100, y: 100, w: 80, h: 30 }, [30, 90, 220, 255]); paint(good, { x: 110, y: 105, w: 20, h: 20 }, [255, 255, 255, 255])
  const moved = blank(W, H, [250, 250, 250, 255]); paint(moved, { x: 100, y: 112, w: 80, h: 30 }, [30, 90, 220, 255]); paint(moved, { x: 110, y: 117, w: 20, h: 20 }, [255, 255, 255, 255])
  const k = checkKind('moved', { x: 95, y: 95, w: 90, h: 55 }, good, moved)
  assert.equal(k.check, 'agrees'); assert.deepEqual(k.measured, { dx: 0, dy: 12 })
  const empty = blank(W, H, [250, 250, 250, 255])
  assert.equal(checkKind('removed', { x: 95, y: 95, w: 90, h: 40 }, good, empty).check, 'agrees')
  assert.equal(checkKind('added', { x: 95, y: 95, w: 90, h: 40 }, good, empty).check, 'contradicts')
  assert.equal(checkKind('recolored', { x: 95, y: 95, w: 90, h: 40 }, good, moved).check, 'agrees')
})

test('findPairs reads shots.recorded and the noise floor from its text', () => {
  const { dir, hg, hc } = makeCase(base(), base(), { floor: 7, step: 5 })
  const p = findPairs(dir)
  assert.equal(p.length, 1); assert.equal(p[0].shotId, 'step5'); assert.equal(p[0].floor, 7); assert.equal(p[0].goodHash, hg); assert.equal(p[0].candHash, hc)
})

test('findPairs reads a check by picture (good-picture, candidate-picture, floor.json)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'describe-')); mkdirSync(join(dir, 'artifacts'))
  const put = (name, buf) => { const h = sha(buf); writeFileSync(join(dir, 'artifacts', h), buf); return { seq: 0, type: 'artifact', data: { name, hash: h } } }
  const ev = [put('good-picture.png', encode(base())), put('candidate-picture.png', encode(base())), put('floor.json', Buffer.from('{"n":3,"changed":12}'))]
  writeFileSync(join(dir, 'events.ndjson'), ev.map(e => JSON.stringify(e)).join('\n'))
  const p = findPairs(dir)
  assert.equal(p[0].shotId, 'picture'); assert.equal(p[0].floor, 12)
})

test('run: verifies real descriptions, drops a hallucinated one, lists what nothing explained, adds up cost', async () => {
  const good = base(), cand = base()
  paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [250, 250, 250, 255]); paint(cand, { x: 40, y: 52, w: 160, h: 40 }, [128, 128, 128, 255]) // button moves down 12 and turns grey
  paint(cand, { x: 40, y: 300, w: 300, h: 10 }, [250, 250, 250, 255]) // the text line vanishes (nobody describes it)
  const { dir, hg, hc } = makeCase(good, cand)
  let seen
  const ask = async (messages, opts) => { seen = { messages, opts }; return reply([
    { view: 'page', kind: 'moved', description: 'The primary button moved down about 12 pixels and turned grey.', region: { x: 0.05, y: 0.08, w: 0.3, h: 0.17 } },
    { view: 'page', kind: 'recolored', description: 'The footer link turned green.', region: { x: 0.7, y: 0.8, w: 0.2, h: 0.1 } }, // nothing changed there
  ])() }
  const r = await run({ caseDir: dir, ask, maxUsd: 1 })
  assert.equal(r.label, 'ai_hypothesis')
  assert.equal(r.items.length, 2)
  const ok = r.items.find(i => i.verified), bad = r.items.find(i => !i.verified)
  assert.match(ok.description, /primary button/)
  assert.equal(ok.goodHash, hg); assert.equal(ok.candHash, hc); assert.equal(ok.shotId, 'step3')
  assert.ok(ok.overlapRatio > 0.25 && ok.diffPixels > 0)
  assert.match(bad.droppedBecause, /hallucinated/)
  assert.equal(r.dropped.hallucinatedRegion, 1)
  assert.equal(verifiedItems(r).length, 1)
  assert.equal(r.unexplainedRegions.length, 1) // the vanished line
  assert.deepEqual(r.unexplainedRegions[0].box, { x: 40, y: 300, w: 300, h: 10 })
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].model, 'fake-model')
  assert.equal(r.calls[0].promptTokens, 4000)
  assert.ok(Math.abs(r.spentUsd - (4000 * 1.25e-6 + 500 * 4.25e-6)) < 1e-9)
  assert.ok(r.notes.some(n => /AI guess, not proof/.test(n)))
  assert.equal(seen.opts.reasoning, 'low')
  assert.ok(seen.messages[1].content.some(c => c.type === 'image_url'))
})

test('run: a claim whose crop-relative box points at real pixels is mapped back to the screenshot', async () => {
  const cand = base(); paint(cand, { x: 300, y: 60, w: 24, h: 24 }, [250, 250, 250, 255])
  const { dir } = makeCase(base(), cand)
  const ask = async messages => {
    const text = promptText(messages)
    assert.match(text, /crop 1/)
    // the icon is at 300..324 x 60..84; a crop starts at x<=252 and y<=12 so a box in the crop's own 0..1 frame must be mapped
    return { text: JSON.stringify({ changes: [{ view: 'crop 1', kind: 'removed', description: 'The red icon was removed.', region: { x: 0.44, y: 0.24, w: 0.12, h: 0.2 } }] }), usage: { promptTokens: 100, completionTokens: 100 } }
  }
  const r = await run({ caseDir: dir, ask, maxUsd: 1, strategy: 'crops', minDensity: 0.001 })
  assert.equal(r.items.length, 1)
  const it = r.items[0]
  assert.ok(it.box.x > 250 && it.box.x < 330, JSON.stringify(it.box))
  assert.equal(it.verified, true); assert.equal(it.diffPixels, 576)
})

test('run: a claim of "added" for something that was removed is dropped as contradicted by the pixels', async () => {
  const cand = base(); paint(cand, { x: 300, y: 60, w: 24, h: 24 }, [250, 250, 250, 255])
  const { dir } = makeCase(base(), cand)
  const r = await run({ caseDir: dir, maxUsd: 1, ask: reply([{ view: 'page', kind: 'added', description: 'A red icon was added.', region: { x: 0.45, y: 0.14, w: 0.07, h: 0.07 } }]) })
  assert.equal(r.items[0].verified, false); assert.match(r.items[0].droppedBecause, /contradict/)
})

test('run: no call when the pictures differ only within the noise floor', async () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 2, h: 2 }, [0, 0, 0, 255])
  const { dir } = makeCase(base(), cand, { floor: 10 })
  let called = false
  const r = await run({ caseDir: dir, maxUsd: 1, ask: async () => { called = true; return { text: '{}', usage: {} } } })
  assert.equal(called, false); assert.equal(r.calls.length, 0); assert.ok(r.notes.some(n => /noise floor/.test(n)))
})

test('run: no call when the pictures are identical, or differ in size', async () => {
  let called = 0
  const ask = async () => { called++; return { text: '{}', usage: {} } }
  await run({ caseDir: makeCase(base(), base()).dir, ask, maxUsd: 1 })
  const r = await run({ caseDir: makeCase(blank(100, 100), blank(100, 120)).dir, ask, maxUsd: 1 })
  assert.equal(called, 0); assert.ok(r.notes.some(n => /different sizes/.test(n)))
})

test('run: the cost cap stops a call before it is made', async () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255])
  const { dir } = makeCase(base(), cand)
  let called = false
  const r = await run({ caseDir: dir, maxUsd: 0.001, ask: async () => { called = true; return { text: '{}', usage: {} } } })
  assert.equal(called, false); assert.equal(r.spentUsd, 0); assert.ok(r.notes.some(n => /cost cap/.test(n)))
})

test('run: a failing or unreadable model answer is a note, never a throw, and costs are still counted', async () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255])
  const { dir } = makeCase(base(), cand)
  const r1 = await run({ caseDir: dir, maxUsd: 1, ask: async () => { throw new Error('HTTP 500') } })
  assert.ok(r1.notes.some(n => /call failed/.test(n))); assert.equal(r1.items.length, 0)
  const r2 = await run({ caseDir: dir, maxUsd: 1, ask: async () => ({ text: 'sorry', usage: { promptTokens: 10, completionTokens: 5 } }) })
  assert.ok(r2.notes.some(n => /could not be read/.test(n))); assert.ok(r2.spentUsd > 0)
  assert.equal(r2.unexplainedRegions.length, 0) // nothing was claimed, and no verdict is touched either way
})

test('run: a case with no screenshots says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'describe-')); writeFileSync(join(dir, 'events.ndjson'), JSON.stringify({ seq: 0, type: 'case.opened', data: {} }) + '\n')
  const r = await run({ caseDir: dir, ask: async () => { throw new Error('should not be called') } })
  assert.ok(r.notes[0].includes('no good/candidate')); assert.equal(r.calls.length, 0)
})

test('analyzeDiff.tight and residual: the changed pixels inside a box, and what a set of boxes leaves out', () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255])
  const a = analyzeDiff(base(), cand)
  assert.deepEqual(a.tight({ x: 0, y: 0, w: 120, h: 400 }), { x: 40, y: 40, w: 80, h: 40 })
  assert.equal(a.tight({ x: 400, y: 200, w: 50, h: 50 }), null)
  const [r] = a.residual([{ x: 40, y: 40, w: 80, h: 40 }]) // half the button is claimed
  assert.equal(r.changed, 3200); assert.equal(r.of, 6400); assert.deepEqual(r.box, { x: 120, y: 40, w: 80, h: 40 })
  assert.equal(a.residual([{ x: 0, y: 0, w: W, h: H }])[0].changed, 0)
})

test('matchRegion: a box round a whole button when only its label changed still verifies (captures the whole diff region)', () => {
  const cand = base(); paint(cand, { x: 60, y: 55, w: 60, h: 8 }, [255, 255, 255, 255]) // label pixels only
  const a = analyzeDiff(base(), cand)
  const m = matchRegion({ x: 40, y: 40, w: 160, h: 40 }, a)
  assert.equal(m.ok, true); assert.equal(m.overlapRatio, 1)
})

test('run: a unexplained region is reported only when a verified claim leaves more than the share outside', async () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255])
  const { dir } = makeCase(base(), cand)
  const claim = w => reply([{ view: 'page', kind: 'recolored', description: 'The button turned grey.', region: { x: 40 / W, y: 40 / H, w: w / W, h: 40 / H } }])
  assert.equal((await run({ caseDir: dir, maxUsd: 1, ask: claim(160) })).unexplainedRegions.length, 0)
  assert.equal((await run({ caseDir: dir, maxUsd: 1, ask: claim(120) })).unexplainedRegions.length, 0) // 75% captured
  const part = await run({ caseDir: dir, maxUsd: 1, ask: claim(40) }) // 25% captured: the rest is unexplained
  assert.equal(part.unexplainedRegions.length, 1); assert.equal(part.unexplainedRegions[0].changed, 4800)
})

test('run with the page-coordinates prompt: crops are shown but boxes are read in the page view', async () => {
  const cand = base(); paint(cand, { x: 300, y: 60, w: 24, h: 24 }, [250, 250, 250, 255])
  const { dir } = makeCase(base(), cand)
  let sent
  const ask = async messages => { sent = promptText(messages); return { text: JSON.stringify({ changes: [{ view: 'page', kind: 'removed', description: 'The red icon was removed.', region: { x: 295 / W, y: 55 / H, w: 34 / W, h: 34 / H } }] }), usage: { promptTokens: 1, completionTokens: 1 } } }
  const r = await run({ caseDir: dir, ask, maxUsd: 1, strategy: 'both', prompt: 'pagecoords' })
  assert.match(sent, /View "crop 1"/); assert.match(sent, /EVERY box in the coordinates of the "page" view/)
  assert.equal(r.items[0].verified, true); assert.equal(r.items[0].kindCheck, 'agrees')
  // a reply that still says "crop 1" is read as the page view in this mode
  const r2 = await run({ caseDir: dir, maxUsd: 1, prompt: 'pagecoords', ask: reply([{ view: 'crop 1', kind: 'removed', description: 'The red icon was removed.', region: { x: 295 / W, y: 55 / H, w: 34 / W, h: 34 / H } }]) })
  assert.equal(r2.items[0].verified, true)
})

test('run with the point prompt and snapPx: a box that misses is rescued only when the point lands on changed pixels', async () => {
  const cand = base(); paint(cand, { x: 300, y: 60, w: 24, h: 24 }, [250, 250, 250, 255])
  const { dir } = makeCase(base(), cand)
  const off = { x: 360 / W, y: 200 / H, w: 30 / W, h: 30 / H } // the box is in the wrong place
  const claim = point => reply([{ view: 'page', kind: 'removed', description: 'The red icon was removed.', region: off, point }])
  const miss = await run({ caseDir: dir, maxUsd: 1, prompt: 'point', snapPx: 20, ask: claim({ x: 375 / W, y: 215 / H }) }) // the point is wrong too
  assert.equal(miss.items[0].verified, false)
  const hit = await run({ caseDir: dir, maxUsd: 1, prompt: 'point', snapPx: 20, ask: claim({ x: 312 / W, y: 72 / H }) })
  assert.equal(hit.items[0].verified, true); assert.equal(hit.items[0].regionSource, 'model point'); assert.deepEqual(hit.items[0].box, { x: 300, y: 60, w: 24, h: 24 })
  const off0 = await run({ caseDir: dir, maxUsd: 1, prompt: 'point', ask: claim({ x: 312 / W, y: 72 / H }) }) // snapping is off by default
  assert.equal(off0.items[0].verified, false)
})

test('run: the result never carries a verdict and always the AI label', async () => {
  const cand = base(); paint(cand, { x: 40, y: 40, w: 160, h: 40 }, [128, 128, 128, 255])
  const r = await run({ caseDir: makeCase(base(), cand).dir, maxUsd: 1, ask: reply([]) })
  assert.equal(r.label, 'ai_hypothesis'); assert.ok(!('verdict' in r)); assert.equal(r.unexplainedRegions.length, 1)
})
