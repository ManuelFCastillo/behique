// node --test src/release/timing.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTiming, parseTimingLine, summarize, timingLine } from './timing.mjs'

function clock(start = 1000) { let t = start; return { now: () => t, tick: ms => { t += ms } } }

test('phases get wall seconds from the marks and builds are counted where they happened', () => {
  const c = clock()
  const tm = createTiming({ now: c.now })
  tm.note({ ref: 'v1', sha: 'a'.repeat(40), buildMs: 50_000 }); c.tick(60_000)
  tm.note({ ref: 'v1', sha: 'a'.repeat(40), buildMs: 4_000, cached: true }); c.tick(10_000)
  tm.setPhase('tests'); c.tick(30_000)
  tm.note({ ref: 'v2', sha: 'b'.repeat(40), buildMs: 7_000 })
  tm.setPhase('shots'); c.tick(5_000)
  const s = tm.summary()
  assert.equal(s.phases.compare.seconds, 70); assert.equal(s.phases.compare.builds, 2); assert.equal(s.phases.compare.cached, 1); assert.equal(s.phases.compare.buildSeconds, 54)
  assert.equal(s.phases.tests.seconds, 30); assert.equal(s.phases.tests.builds, 1)
  assert.equal(s.phases.shots.seconds, 5); assert.equal(s.phases.bisect.builds, 0)
  assert.equal(s.total.seconds, 105); assert.equal(s.total.builds, 3); assert.equal(s.total.cached, 1)
  assert.equal(tm.builds[0].sha, 'a'.repeat(12))
})

test('an unknown phase or the same phase again changes nothing', () => {
  const c = clock()
  const tm = createTiming({ now: c.now })
  tm.setPhase('nonsense'); tm.setPhase('compare'); c.tick(1000)
  assert.equal(tm.phase, 'compare')
  assert.equal(tm.summary().phases.compare.seconds, 1)
})

test('the line round-trips and a non-timing line parses to null', () => {
  const s = summarize({ builds: [{ phase: 'tests', ms: 7000, cached: true }], marks: [{ phase: 'compare', at: 0 }, { phase: 'tests', at: 464_000 }], startedAt: 0, now: 2_160_000 })
  const line = timingLine(s)
  assert.equal(line, 'timing: total 2160 s | compare 464 s (0 builds, 0 cached) | tests 1696 s (1 builds, 1 cached) | shots 0 s (0 builds, 0 cached) | bisect 0 s (0 builds, 0 cached)')
  const back = parseTimingLine(line)
  assert.equal(back.total.seconds, 2160); assert.deepEqual(back.phases.tests, { seconds: 1696, builds: 1, cached: 1 })
  assert.equal(parseTimingLine('evidence: x'), null)
  assert.equal(parseTimingLine(null), null)
})

test('summarize never throws on junk', () => {
  assert.deepEqual(summarize().total, { seconds: 0, builds: 0, cached: 0 })
  assert.equal(summarize({ builds: [null, { phase: 'x' }], marks: [null, { phase: 'tests' }], startedAt: 5, now: 1 }).total.seconds, 0)
})
