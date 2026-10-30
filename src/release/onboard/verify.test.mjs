// Tests for verifyProfile with fakes only, no network or browser.
//   node --test src/release/onboard/verify.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { blank, paint, encode } from '../../senses/pixels.mjs'
import { verifyProfile } from './verify.mjs'

function testProfile() {
  return {
    name: 'demo',
    repo: '/tmp/demo-repo',
    workRoot: '/tmp/demo-work',
    serve: { kind: 'static' },
  }
}

function livePng(w = 32, h = 16) {
  const img = blank(w, h, [10, 20, 30, 255])
  paint(img, { x: 0, y: 0, w: Math.floor(w / 2), h }, [200, 50, 50, 255])
  paint(img, { x: Math.floor(w / 2), y: 0, w: w - Math.floor(w / 2), h }, [50, 200, 80, 255])
  return encode(img)
}

function blankPng(w = 32, h = 16) {
  return encode(blank(w, h, [255, 255, 255, 255]))
}

function makeStartFake({ failRef = null } = {}) {
  const starts = []
  const stopped = []
  let seq = 0
  const fn = async ({ adapter, ref, port }) => {
    starts.push({ ref, port })
    if (failRef !== null && ref === failRef) throw new Error(`no build for ${ref}`)
    seq += 1
    const id = seq
    return {
      ref,
      sha: `${ref}-sha-0123456789abcdef`,
      base: `http://127.0.0.1:${port}/base-${ref}`,
      port,
      buildMs: 1200 + id,
      stop: async () => { stopped.push(ref) },
    }
  }
  return { fn, starts, stopped }
}

function makePictureFake({ goodPng, candPng, settled = true, goodMs = 11, candMs = 22 } = {}) {
  const calls = []
  const fn = async (base, profile) => {
    calls.push({ base })
    const isGood = base.includes('good')
    return {
      png: isGood ? goodPng : candPng,
      settled,
      ms: isGood ? goodMs : candMs,
      errors: [],
      blocked: isGood ? ['https://example.com/a.js'] : [],
    }
  }
  return { fn, calls }
}

function makeFloorFake({ throwMsg = null, changed = 0 } = {}) {
  const calls = []
  const fn = async (base, profile, { loads } = {}) => {
    calls.push({ base, loads })
    if (throwMsg) throw new Error(throwMsg)
    return { n: loads ?? 3, changed, regions: {} }
  }
  return { fn, calls }
}

function checkNames(report) {
  return report.checks.map((c) => c.name)
}

const EXPECTED_NAMES = [
  'builds the good version',
  'builds the candidate version',
  'pictures settle',
  'pictures are the same size',
  'the app is alive',
  'no page errors on the good version',
  'no blocked requests',
  'noise floor',
]

test('all checks pass and every build is stopped', async () => {
  const start = makeStartFake()
  const pic = makePictureFake({ goodPng: livePng(), candPng: livePng() })
  const floor = makeFloorFake({ changed: 7 })
  const report = await verifyProfile(testProfile(), {
    good: 'good', cand: 'cand', startBuildFn: start.fn, pictureFn: pic.fn, floorFn: floor.fn, loads: 3,
  })
  assert.deepEqual(checkNames(report), EXPECTED_NAMES)
  assert.equal(report.ok, true)
  for (const c of report.checks) assert.equal(c.ok, true, c.name)
  assert.equal(report.floor.changed, 7)
  assert.deepEqual(start.stopped.sort(), ['cand', 'good'])
})

test('good build fails: later checks skipped and candidate never started', async () => {
  const start = makeStartFake({ failRef: 'good' })
  const pic = makePictureFake({ goodPng: livePng(), candPng: livePng() })
  const floor = makeFloorFake()
  const report = await verifyProfile(testProfile(), {
    good: 'good', cand: 'cand', startBuildFn: start.fn, pictureFn: pic.fn, floorFn: floor.fn,
  })
  assert.equal(report.ok, false)
  assert.equal(report.checks[0].ok, false)
  assert.deepEqual(start.starts.map((s) => s.ref), ['good'])
  for (const c of report.checks.slice(1)) {
    assert.equal(c.ok, true, c.name)
    assert.match(String(c.detail).toLowerCase(), /skip/)
  }
  assert.equal(pic.calls.length, 0)
  assert.equal(floor.calls.length, 0)
  assert.deepEqual(start.stopped, [])
})

test('candidate build fails: good build is still stopped', async () => {
  const start = makeStartFake({ failRef: 'cand' })
  const pic = makePictureFake({ goodPng: livePng(), candPng: livePng() })
  const floor = makeFloorFake()
  const report = await verifyProfile(testProfile(), {
    good: 'good', cand: 'cand', startBuildFn: start.fn, pictureFn: pic.fn, floorFn: floor.fn,
  })
  assert.equal(report.ok, false)
  assert.equal(report.checks[0].ok, true)
  assert.equal(report.checks[1].ok, false)
  for (const c of report.checks.slice(2)) {
    assert.equal(c.ok, true, c.name)
    assert.match(String(c.detail).toLowerCase(), /skip/)
  }
  assert.deepEqual(start.stopped, ['good'])
})

test('unsettled pictures fail the settle check', async () => {
  const start = makeStartFake()
  const pic = makePictureFake({ goodPng: livePng(), candPng: livePng(), settled: false })
  const floor = makeFloorFake()
  const report = await verifyProfile(testProfile(), {
    good: 'good', cand: 'cand', startBuildFn: start.fn, pictureFn: pic.fn, floorFn: floor.fn,
  })
  const settle = report.checks.find((c) => c.name === 'pictures settle')
  assert.equal(settle.ok, false)
  assert.equal(report.ok, false)
  assert.deepEqual(start.stopped.sort(), ['cand', 'good'])
})

test('different sizes fail the size check', async () => {
  const start = makeStartFake()
  const pic = makePictureFake({ goodPng: livePng(32, 16), candPng: livePng(40, 16) })
  const floor = makeFloorFake()
  const report = await verifyProfile(testProfile(), {
    good: 'good', cand: 'cand', startBuildFn: start.fn, pictureFn: pic.fn, floorFn: floor.fn,
  })
  const size = report.checks.find((c) => c.name === 'pictures are the same size')
  assert.equal(size.ok, false)
  assert.equal(report.ok, false)
  assert.deepEqual(start.stopped.sort(), ['cand', 'good'])
})

test('blank app fails the alive check', async () => {
  const start = makeStartFake()
  const pic = makePictureFake({ goodPng: blankPng(), candPng: blankPng() })
  const floor = makeFloorFake()
  const report = await verifyProfile(testProfile(), {
    good: 'good', cand: 'cand', startBuildFn: start.fn, pictureFn: pic.fn, floorFn: floor.fn,
  })
  const alive = report.checks.find((c) => c.name === 'the app is alive')
  assert.equal(alive.ok, false)
  assert.equal(report.ok, false)
  assert.deepEqual(start.stopped.sort(), ['cand', 'good'])
})

test('floor throwing fails the floor check with null floor', async () => {
  const start = makeStartFake()
  const pic = makePictureFake({ goodPng: livePng(), candPng: livePng() })
  const floor = makeFloorFake({ throwMsg: 'never settles' })
  const report = await verifyProfile(testProfile(), {
    good: 'good', cand: 'cand', startBuildFn: start.fn, pictureFn: pic.fn, floorFn: floor.fn,
  })
  const fc = report.checks.find((c) => c.name === 'noise floor')
  assert.equal(fc.ok, false)
  assert.match(String(fc.detail), /never settles/)
  assert.equal(report.floor, null)
  assert.equal(report.ok, false)
  assert.deepEqual(start.stopped.sort(), ['cand', 'good'])
})

// added by a person after review, not by the model
test('a good version that throws while loading fails verification even though it draws a picture', async () => {
  const { blank, paint, encode } = await import('../../senses/pixels.mjs')
  const img = encode(paint(blank(40, 30), { x: 5, y: 5, w: 10, h: 10 }, [10, 20, 200, 255]))
  const profile = { name: 'x', repo: '/r', workRoot: '/w', serve: { kind: 'static' } }
  const stops = []
  const startBuildFn = async ({ ref }) => ({ ref, sha: 'a'.repeat(40), base: 'http://127.0.0.1:1/' + ref, buildMs: 5, stop: async () => stops.push(ref) })
  const mk = errors => async () => ({ png: img, settled: true, ms: 5, errors, blocked: [] })
  const floorFn = async () => ({ n: 3, changed: 0, regions: {} })
  const bad = await verifyProfile(profile, { good: 'g', cand: 'c', startBuildFn, pictureFn: mk(['docById is not defined']), floorFn })
  assert.equal(bad.ok, false)
  assert.match(bad.checks.find(c => c.name === 'no page errors on the good version').detail, /1 uncaught errors while loading, first: docById is not defined/)
  const good = await verifyProfile(profile, { good: 'g', cand: 'c', startBuildFn, pictureFn: mk([]), floorFn })
  assert.equal(good.ok, true); assert.deepEqual(stops.sort(), ['c', 'c', 'g', 'g'])
})
