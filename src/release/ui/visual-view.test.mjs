// Offline tests for the visual dashboard view. Run: node --test src/release/ui/visual-view.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCase } from '../evidence.mjs'
import { blank, encode } from '../../senses/pixels.mjs'
import { visualView, regionLabel } from './visual-view.mjs'

const png = () => encode(blank(4, 4, [1, 2, 3, 255]))
const freshDir = () => mkdtempSync(join(tmpdir(), 'visual-view-'))

function openVisual({ regions = null, anchorsFailed = [], floor = { n: 2, changed: 5, regions: {} } } = {}) {
  const c = openCase(freshDir())
  c.event('case.opened', { kind: 'visual', goodRef: 'v1', candRef: 'v2' })
  c.artifact('good-picture.png', png(), 'image/png')
  c.artifact('candidate-picture.png', png(), 'image/png')
  c.artifact('floor.json', JSON.stringify(floor), 'application/json')
  if (regions) c.event('visual.regions', { regions, anchorsFailed, scale: 2 })
  return c
}

const twoRegions = () => ([
  { name: 'header', box: { x: 0, y: 0, w: 4, h: 2 }, inRegion: 42, floor: 3, above: true },
  { name: 'sidebar', box: { x: 0, y: 2, w: 2, h: 2 }, inRegion: 0, floor: 3, above: false },
])

test('two regions where one differs', () => {
  const c = openVisual({ regions: twoRegions() })
  c.artifact('diff-header.png', png(), 'image/png')
  const v = visualView(c, { caseId: 'case 1' })
  assert.equal(v.kind, 'visual')
  assert.equal(v.regionsKnown, true)
  assert.equal(v.regions.length, 2)
  assert.deepEqual(v.regions[0].box, { x: 0, y: 0, w: 4, h: 2 })
  assert.equal(v.regions[0].differs, true)
  assert.equal(v.regions[0].changed, 42)
  assert.equal(v.regions[0].floor, 3)
  assert.ok(v.regions[0].diff.includes('/api/artifact-image?id=case%201&hash='))
  assert.equal(v.regions[1].differs, false)
  assert.equal(v.regions[1].diff, null)
  assert.equal(v.summary, '1 of 2 regions differ by more than the noise: header.')
  assert.ok(v.pictures.good.includes('hash='))
  assert.ok(v.pictures.candidate.includes('hash='))
  assert.deepEqual(v.floor, { loads: 2, changed: 5 })
  assert.equal(v.search, null)
})

test('no region differs', () => {
  const c = openVisual({
    regions: [{ name: 'a', box: { x: 0, y: 0, w: 1, h: 1 }, inRegion: 0, floor: 2, above: false }],
  })
  const v = visualView(c, { caseId: 'x' })
  assert.equal(v.summary, 'No region differs by more than the noise.')
  assert.equal(v.regions[0].diff, null)
})

test('older case with no visual.regions event', () => {
  const c = openVisual({ regions: null })
  const v = visualView(c, { caseId: 'old' })
  assert.equal(v.regionsKnown, false)
  assert.deepEqual(v.regions, [])
  assert.equal(v.summary, 'This report predates the region data; see the claims for the details.')
})

test('non-visual and empty cases return null', () => {
  const c1 = openCase(freshDir())
  c1.event('case.opened', { kind: 'canvas' })
  assert.equal(visualView(c1, { caseId: 'a' }), null)
  const c2 = openCase(freshDir())
  assert.equal(visualView(c2, { caseId: 'b' }), null)
})

function addSearch(c, result, { cite = false } = {}) {
  const log = ['line one']
  const h = c.artifact('bisect.json', JSON.stringify({ result, log }), 'application/json')
  if (cite) {
    c.claim('reproduced_failure', 'first change proven', { evidence: [h] })
  }
  return h
}

const fullResult = () => ({
  conclusive: true,
  verified: true,
  commit: 'abc123def456abc123def456abc123def456abc1',
  parent: '00001111',
  subject: 'Fix the thing',
  author: 'Ada',
  date: '2024-01-02',
  files: ['a.js'],
  url: 'http://example.test/c',
  changes: 8,
  steps: 3,
})

test('conclusive verified search with claim is proven', () => {
  const c = openVisual({ regions: twoRegions() })
  addSearch(c, fullResult(), { cite: true })
  const v = visualView(c, { caseId: 's1' })
  assert.equal(v.search.found, true)
  assert.equal(v.search.proven, true)
  assert.equal(v.search.commit, 'abc123def456abc123def456abc123def456abc1')
  assert.equal(v.search.subject, 'Fix the thing')
  assert.equal(v.search.author, 'Ada')
})

test('same search without claim is found but not proven', () => {
  const c = openVisual({ regions: twoRegions() })
  addSearch(c, fullResult(), { cite: false })
  const v = visualView(c, { caseId: 's2' })
  assert.equal(v.search.found, true)
  assert.equal(v.search.proven, false)
})

test('inconclusive search is not found', () => {
  const c = openVisual({ regions: twoRegions() })
  addSearch(c, { conclusive: false, verified: false, changes: 8, steps: 2, range: ['a', 'b'] }, { cite: false })
  const v = visualView(c, { caseId: 's3' })
  assert.equal(v.search.found, false)
  assert.equal(v.search.proven, false)
  assert.equal(v.search.commit, null)
})

test('anchors failed text is appended', () => {
  const c = openVisual({ regions: twoRegions(), anchorsFailed: ['toolbar', 'sidebar'] })
  const v = visualView(c, { caseId: 'anch' })
  assert.deepEqual(v.anchorsFailed, ['toolbar', 'sidebar'])
  assert.ok(v.summary.endsWith(' The anchor regions toolbar, sidebar also differ, so the app may be broken, not only changed.'))
})

test('non-PNG artifact never becomes a URL', () => {
  const c = openCase(freshDir())
  c.event('case.opened', { kind: 'visual' })
  c.artifact('good-picture.png', 'not a picture', 'text/plain')
  c.artifact('candidate-picture.png', png(), 'image/png')
  c.artifact('floor.json', JSON.stringify({ n: 1, changed: 0 }), 'application/json')
  c.event('visual.regions', { regions: [], anchorsFailed: [], scale: 2 })
  const v = visualView(c, { caseId: 'np' })
  assert.equal(v.pictures.good, null)
  assert.ok(v.pictures.candidate.includes('hash='))
})

test('damaged bisect.json gives search null', () => {
  const c = openVisual({ regions: twoRegions() })
  c.artifact('bisect.json', 'this is not json{{{', 'application/json')
  const v = visualView(c, { caseId: 'bad' })
  assert.equal(v.search, null)
})

test('regionLabel cases', () => {
  assert.equal(regionLabel('left-edge'), 'Left edge')
  assert.equal(regionLabel('header'), 'Header')
  assert.equal(regionLabel(''), '')
  assert.equal(regionLabel(null), '')
  assert.equal(regionLabel(42), '')
  assert.equal(regionLabel(undefined), '')
})
