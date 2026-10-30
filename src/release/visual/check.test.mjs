// Tests for the visual check command with fake collaborators. Offline only.
// Run: node --test src/release/visual/check.test.mjs
import { strict as assert } from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { blank, encode, paint } from '../../senses/pixels.mjs'
import { parseArgs, runCheck } from './check.mjs'

const refPng = () => encode(blank(20, 10, [255, 255, 255, 255]))
const candPng = () => encode(paint(blank(20, 10, [255, 255, 255, 255]), { x: 1, y: 1, w: 4, h: 3 }, [0, 0, 0, 255]))
const fakeProfile = (over = {}) => ({
  name: 'demoapp',
  viewport: { width: 10, height: 5, deviceScaleFactor: 1 },
  regions: { top: { x: 0, y: 0, w: 10, h: 5 } },
  anchors: {},
  ...over,
})

function deps(over = {}) {
  const stopped = []
  const root = mkdtempSync(join(tmpdir(), 'chk-'))
  const d = {
    loadProfile: () => fakeProfile(),
    profileToAdapter: p => ({ name: p.name }),
    evidenceRoot: root,
    now: new Date('2026-10-29T21:41:31Z'),
    stopped,
    startBuildFn: async ({ adapter, ref, port }) => ({
      ref,
      sha: ref + '-sha',
      base: 'http://base/' + ref,
      stop: async () => { stopped.push(ref) },
    }),
    pictureFn: async base => ({ png: base.endsWith('good') ? refPng() : candPng(), settled: true }),
    floorFn: async () => ({ n: 3, changed: 0, regions: { top: 0 } }),
    visualBisectFn: async () => { throw new Error('should not be called') },
    recordVisualCase: () => ({ caseId: 'cid', outcome: 'differences found' }),
    ...over,
  }
  return d
}

const opts = (over = {}) => ({ app: 'demoapp', goodRef: 'good', candRef: 'cand', ...over })

test('usage error when args missing', async () => {
  const out = await runCheck({}, deps())
  assert.equal(out.code, 2)
  assert.ok(out.lines.join('\n').includes('usage'))
})

test('missing profile is usage error', async () => {
  const d = deps({ loadProfile: () => { throw new Error('profile "nope" not found') } })
  const out = await runCheck(opts({ app: 'nope' }), d)
  assert.equal(out.code, 2)
})

test('both builds stopped when a picture does not settle', async () => {
  const d = deps({ pictureFn: async () => ({ png: refPng(), settled: false }) })
  const out = await runCheck(opts(), d)
  assert.equal(out.code, 1)
  assert.ok(out.lines.join(' ').includes('settle'))
  assert.ok(d.stopped.includes('good') && d.stopped.includes('cand'))
  assert.equal(out.caseId, null)
})

test('per-region lines and recorded case', async () => {
  let recorded = null
  const d = deps({ recordVisualCase: a => { recorded = a; return { caseId: 'cid1', outcome: 'differences found' } } })
  const out = await runCheck(opts(), d)
  assert.equal(out.code, 0)
  assert.equal(out.caseId, 'cid1')
  assert.ok(out.lines.some(l => l.includes('top') && l.includes('above')))
  assert.ok(recorded && recorded.goodSha === 'good-sha')
  assert.ok(out.lines.some(l => l.includes('/report?case=cid1')))
})

test('bisect skipped when nothing above floor', async () => {
  let called = false
  const d = deps({
    pictureFn: async () => ({ png: refPng(), settled: true }),
    visualBisectFn: async () => { called = true; return null },
  })
  const out = await runCheck(opts({ bisect: true }), d)
  assert.equal(called, false)
  assert.ok(out.lines.some(l => l.includes('nothing to bisect')))
  assert.equal(out.code, 0)
})

test('bisect error still records a case with code 1', async () => {
  let recorded = false
  const d = deps({
    visualBisectFn: async ({ log }) => { log('trying'); throw new Error('boom') },
    recordVisualCase: a => { recorded = true; assert.equal(a.bisect, null); return { caseId: 'cid2', outcome: 'differences found' } },
  })
  const out = await runCheck(opts({ bisect: true, region: 'top' }), d)
  assert.equal(recorded, true)
  assert.equal(out.code, 1)
  assert.ok(out.lines.some(l => l.includes('bisect failed')))
})

test('parseArgs parses flags', () => {
  const p = parseArgs(['node', 'check.mjs', 'a', 'g', 'c', '--region', 'top', '--bisect', '--ports', '8301,8302', '--runs', '2', '--loads', '2'])
  assert.equal(p.opts.region, 'top')
  assert.equal(p.opts.bisect, true)
  assert.deepEqual(p.opts.ports, [8301, 8302])
  const bad = parseArgs(['node', 'check.mjs', 'a'])
  assert.ok(bad.error)
})

// added by a person after review, not by the model
test('a profile with no regions gets regions proposed from where the pictures differ, and says a person did not approve them', async () => {
  const seen = [], saved = []
  const d = deps({
    loadProfile: () => fakeProfile({ regions: {} }),
    writeProposals: (app, proposals) => { saved.push([app, proposals.regions.length]); return 'out/onboard/x.json' },
    recordVisualCase: args => { seen.push(args); return { caseId: 'cid', outcome: 'differences found' } },
  })
  const out = await runCheck(opts(), d)
  assert.equal(out.code, 0)
  assert.match(out.lines.join('\n'), /so 1 were proposed from where the two pictures differ \(not approved by a person\)/)
  assert.equal(seen[0].reports.length, 1); assert.notEqual(seen[0].reports[0].name, 'whole picture'); assert.equal(seen[0].reports[0].above, true)
  assert.deepEqual(Object.keys(seen[0].profile.regions), [seen[0].reports[0].name], 'the case is recorded with the proposed regions')
  assert.deepEqual(saved, [['demoapp', 1]])
})

test('a profile with no regions and two identical pictures compares the whole picture and never reports "nothing differs" without looking', async () => {
  const seen = []
  const d = deps({
    loadProfile: () => fakeProfile({ regions: {} }),
    pictureFn: async () => ({ png: refPng(), settled: true }),
    writeProposals: () => { throw new Error('nothing to save') },
    recordVisualCase: args => { seen.push(args.reports); return { caseId: 'cid', outcome: 'no candidate defects' } },
  })
  const out = await runCheck(opts(), d)
  assert.equal(out.code, 0)
  assert.match(out.lines.join('\n'), /the profile has no regions, so the whole picture is compared/)
  assert.match(out.lines.join('\n'), /region whole picture: 0 pixels/)
  assert.equal(seen[0].length, 1); assert.equal(seen[0][0].name, 'whole picture')
})

test('--propose lists differences outside the named regions and a clean outside is said so', async () => {
  const named = { corner: { x: 12, y: 6, w: 4, h: 3 } } // away from the changed square at the top left
  const out = await runCheck(opts({ propose: true }), deps({ loadProfile: () => fakeProfile({ regions: named }), writeProposals: () => 'out/onboard/x.json' }))
  assert.match(out.lines.join('\n'), /also differs outside the named regions: \S.* \(\d+ pixels\)/)
  assert.match(out.lines.join('\n'), /region corner: 0 pixels/)
  const inside = await runCheck(opts({ propose: true }), deps({ writeProposals: () => 'out/onboard/x.json' })) // fakeProfile's region covers the changed square
  assert.match(inside.lines.join('\n'), /no difference outside the named regions/)
})

test('without --propose a profile with regions proposes nothing and writes nothing', async () => {
  const out = await runCheck(opts(), deps({ writeProposals: () => { throw new Error('must not save') }, proposeRegions: () => { throw new Error('must not propose') } }))
  assert.equal(out.code, 0)
})
