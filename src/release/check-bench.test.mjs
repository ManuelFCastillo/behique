// Tests for the bench runner: parsing, single runs, sequential runs, table rendering.
//   node --test src/release/check-bench.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCheckOutput, runAll, runOne, renderTable } from './check-bench.mjs'

const confirmedLines = [
  'evidence: 20260101T000000Z_v1-vs-v2',
  '12 page states, 3 flows, 9 steps (stopped: budget, 4.2 s)',
  'facts: 40 stable, 5 volatile (11.1% masked)',
  'control (v1 a third time): 0 differences',
  'candidate (v2): 3 differences (changed 2, added 1, removed 0, moved 0)',
  'R1: v1 (good) passed 3/3, v2 (candidate) failed 3/3: confirmed',
  'R2: v1 (good) passed 3/3, v2 (candidate) failed 0/3: not_reproduced',
  '1 of 2 findings confirmed',
  'CONFIRMED: reproducible behaviour change',
]

describe('parseCheckOutput', () => {
  it('parses a confirmed run', () => {
    const r = parseCheckOutput(confirmedLines)
    assert.equal(r.outcome, 'confirmed')
    assert.equal(r.caseId, '20260101T000000Z_v1-vs-v2')
    assert.deepEqual(r.crawl, { states: 12, flows: 3, steps: 9, stoppedBy: 'budget', seconds: 4.2 })
    assert.deepEqual(r.facts, { stable: 40, volatile: 5 })
    assert.equal(r.controlDifferences, 0)
    assert.equal(r.candidateDifferences, 3)
    assert.deepEqual(r.findings, [{ id: 'R1', verdict: 'confirmed' }, { id: 'R2', verdict: 'not_reproduced' }])
    assert.equal(r.confirmed, 1)
    assert.equal(r.total, 2)
    assert.equal(r.error, null)
  })

  it('parses a run whose control stayed noisy', () => {
    const r = parseCheckOutput(['evidence: abc', 'control (v1 a third time): 63 differences (changed 1, added 40, removed 22, moved 0)', 'noise learned from the control: 90 more facts ignored after 2 extra recordings', 'control run shows 63 differences: masking is not trustworthy, stopping'])
    assert.equal(r.outcome, 'noisy')
    assert.equal(r.learnedFacts, 90)
    assert.equal(r.controlDifferences, 63)
  })

  it('parses a no-change run', () => {
    const r = parseCheckOutput(['evidence: abc', 'no changed facts between the builds'])
    assert.equal(r.outcome, 'no_change')
    assert.equal(r.caseId, 'abc')
    assert.equal(r.error, null)
  })

  it('parses no value changed prefix as no_change', () => {
    const r = parseCheckOutput(['no value changed, but 2 recorded facts disappeared (a/b); no test was written'])
    assert.equal(r.outcome, 'no_change')
  })

  it('parses none of the changed facts as no_change', () => {
    const r = parseCheckOutput(['none of the changed facts can be written as a test'])
    assert.equal(r.outcome, 'no_change')
  })

  it('parses a build failure', () => {
    const r = parseCheckOutput(['a build failed to start, so the versions could not be compared: boom went wrong'])
    assert.equal(r.outcome, 'build_failed')
    assert.equal(r.error, 'boom went wrong')
  })

  it('parses a crawl failure', () => {
    const r = parseCheckOutput(['the crawl failed: timeout here'])
    assert.equal(r.outcome, 'crawl_failed')
    assert.equal(r.error, 'timeout here')
  })

  it('parses a run with no steps', () => {
    const r = parseCheckOutput(['the crawl did not produce any steps, so there is nothing to compare'])
    assert.equal(r.outcome, 'no_steps')
  })

  it('counts findings when no summary line exists', () => {
    const r = parseCheckOutput([
      'R1: v1 (good) passed 3/3, v2 (candidate) failed 3/3: fails_both',
      'R2: v1 (good) passed 3/3, v2 (candidate) failed 3/3: confirmed',
      'NOT CONFIRMED: something',
    ])
    assert.equal(r.outcome, 'not_confirmed')
    assert.equal(r.total, 2)
    assert.equal(r.confirmed, 1)
  })

  it('ignores junk lines and non-strings', () => {
    const r = parseCheckOutput([null, 42, {}, '   ', 'evidence: one', 'garbage line here'])
    assert.equal(r.caseId, 'one')
    assert.equal(r.outcome, 'error')
    assert.equal(r.error, 'No result line found.')
  })

  it('last match wins', () => {
    const r = parseCheckOutput([
      'evidence: first',
      'evidence: second',
      'facts: 1 stable, 1 volatile (x)',
      'facts: 7 stable, 2 volatile (y)',
      'control (v1 a third time): 5 differences',
      'control (v1 a third time): 1 differences',
    ])
    assert.equal(r.caseId, 'second')
    assert.deepEqual(r.facts, { stable: 7, volatile: 2 })
    assert.equal(r.controlDifferences, 1)
  })

  it('applies outcome precedence', () => {
    const r = parseCheckOutput([
      'no changed facts between the builds',
      'CONFIRMED: yes',
      'the crawl did not produce any steps, so there is nothing to compare',
      'the crawl failed: bad',
      'a build failed to start, so the versions could not be compared: worse',
    ])
    assert.equal(r.outcome, 'build_failed')
    assert.equal(r.error, 'worse')
  })

  it('prefers confirmed over no_change', () => {
    const r = parseCheckOutput(['no changed facts between the builds', 'CONFIRMED: yes'])
    assert.equal(r.outcome, 'confirmed')
  })

  it('never throws on junk input', () => {
    assert.doesNotThrow(() => parseCheckOutput(null))
    assert.doesNotThrow(() => parseCheckOutput([null, { a: 1 }]))
  })
})

describe('runOne', () => {
  it('passes argv without bisect', async () => {
    let seen
    const runner = async (argv, opts) => {
      seen = { argv, opts }
      return { code: 0, lines: confirmedLines, timedOut: false }
    }
    let t = 1000
    const now = () => t
    const r = await runOne({ app: 'my-app', good: 'v1', cand: 'v2', runner, now })
    assert.deepEqual(seen.argv, ['src/release/check-app.mjs', 'my-app', 'v1', 'v2'])
    assert.equal(r.outcome, 'confirmed')
    assert.equal(r.app, 'my-app')
    assert.equal(typeof r.seconds, 'number')
  })

  it('adds --bisect when asked', async () => {
    let seen
    const runner = async argv => {
      seen = argv
      return { code: 0, lines: confirmedLines, timedOut: false }
    }
    await runOne({ app: 'my-app', good: 'v1', cand: 'v2', runner, bisect: true, now: () => 0 })
    assert.deepEqual(seen, ['src/release/check-app.mjs', 'my-app', 'v1', 'v2', '--bisect'])
  })

  it('refuses invalid names without calling the runner', async () => {
    let called = 0
    const runner = async () => { called += 1; return { code: 0, lines: [] } }
    const r = await runOne({ app: 'Bad_App!', good: 'v1', cand: 'v2', runner, now: () => 0 })
    assert.equal(r.outcome, 'error')
    assert.equal(r.error, 'Invalid app or version name.')
    assert.equal(called, 0)
    const r2 = await runOne({ app: 'my-app', good: '-bad', cand: 'v2', runner, now: () => 0 })
    assert.equal(r2.outcome, 'error')
    assert.equal(called, 0)
  })

  it('maps timedOut to timeout with minutes', async () => {
    const runner = async () => ({ code: 0, lines: confirmedLines, timedOut: true })
    const r = await runOne({ app: 'my-app', good: 'v1', cand: 'v2', runner, timeoutMs: 600000, now: () => 0 })
    assert.equal(r.outcome, 'timeout')
    assert.equal(r.error, 'Timed out after 10 minutes.')
  })

  it('maps a rejected runner to error first line', async () => {
    const runner = async () => { throw new Error('kaput\nsecond line') }
    const r = await runOne({ app: 'my-app', good: 'v1', cand: 'v2', runner, now: () => 0 })
    assert.equal(r.outcome, 'error')
    assert.equal(r.error, 'kaput')
  })

  it('keeps error for nonzero code with no result', async () => {
    const runner = async () => ({ code: 1, lines: ['some junk'], timedOut: false })
    const r = await runOne({ app: 'my-app', good: 'v1', cand: 'v2', runner, now: () => 0 })
    assert.equal(r.outcome, 'error')
    assert.equal(r.error, 'No result line found.')
  })

  it('computes seconds with one decimal', async () => {
    let t = 5000
    const now = () => t
    const runner = async () => { t = 6140; return { code: 0, lines: confirmedLines, timedOut: false } }
    const r = await runOne({ app: 'my-app', good: 'v1', cand: 'v2', runner, now })
    assert.equal(r.seconds, 1.1)
  })
})

describe('runAll', () => {
  it('runs in order and cleans up after each job', async () => {
    const order = []
    const cleaned = []
    const runner = async argv => {
      order.push(argv[1])
      return { code: 0, lines: ['evidence: x', 'no changed facts between the builds'], timedOut: false }
    }
    const cleanup = async () => { cleaned.push(order.length) }
    const results = await runAll({ jobs: [{ app: 'a-app', good: 'v1', cand: 'v2' }, { app: 'b-app', good: 'v1', cand: 'v2' }], runner, cleanup, now: () => 0 })
    assert.deepEqual(order, ['a-app', 'b-app'])
    assert.deepEqual(cleaned, [1, 2])
    assert.equal(results.length, 2)
    assert.equal(results[0].app, 'a-app')
  })

  it('cleans up after failures and swallows cleanup errors', async () => {
    let cleaned = 0
    const runner = async () => ({ code: 1, lines: ['junk'], timedOut: false })
    const cleanup = async () => { cleaned += 1; throw new Error('cleanup bad') }
    const results = await runAll({ jobs: [{ app: 'a-app', good: 'v1', cand: 'v2' }], runner, cleanup, now: () => 0 })
    assert.equal(cleaned, 1)
    assert.equal(results[0].outcome, 'error')
  })

  it('calls onResult with index and swallows its errors', async () => {
    const seen = []
    const runner = async () => ({ code: 0, lines: ['evidence: x', 'no changed facts between the builds'], timedOut: false })
    const onResult = (r, i) => { seen.push([r.app, i]); throw new Error('listener bad') }
    const results = await runAll({ jobs: [{ app: 'a-app', good: 'v1', cand: 'v2' }], runner, cleanup: async () => {}, onResult, now: () => 0 })
    assert.deepEqual(seen, [['a-app', 0]])
    assert.equal(results.length, 1)
  })

  it('returns [] for empty input', async () => {
    const r = await runAll({ jobs: [], runner: async () => ({}), cleanup: async () => {}, now: () => 0 })
    assert.deepEqual(r, [])
  })
})

describe('renderTable', () => {
  it('renders columns, dashes, pipes and totals', () => {
    const results = [
      { app: 'a-app', good: 'v1', cand: 'v2', outcome: 'confirmed', crawl: { states: 4, steps: 8 }, controlDifferences: 0, candidateDifferences: 2, confirmed: 1, total: 2, error: null, seconds: 3.2 },
      { app: 'b-app', good: 'v1', cand: 'v3', outcome: 'no_change', crawl: null, controlDifferences: null, candidateDifferences: null, confirmed: 0, total: 0, error: null, seconds: 1 },
      { app: 'c-app', good: 'v1', cand: 'v4', outcome: 'not_confirmed', crawl: { states: 2, steps: 5 }, controlDifferences: 1, candidateDifferences: 1, confirmed: 0, total: 1, error: 'a|b problem here', seconds: 2 },
    ]
    const t = renderTable(results)
    assert.ok(t.includes('| App |'))
    assert.ok(t.includes('Versions'))
    assert.ok(t.includes('Outcome'))
    assert.ok(t.includes('Crawl (states/steps)'))
    assert.ok(t.includes('Control diffs'))
    assert.ok(t.includes('Candidate diffs'))
    assert.ok(t.includes('Findings (confirmed/total)'))
    assert.ok(t.includes('Seconds'))
    assert.ok(t.includes('Note'))
    assert.ok(t.includes('v1 to v2'))
    assert.ok(t.includes('4/8'))
    assert.ok(t.includes('1/2'))
    assert.ok(t.includes('a/b problem here'))
    assert.ok(!t.includes('a|b problem here'))
    const lines = t.split('\n')
    const missing = lines.find(l => l.includes('b-app'))
    assert.ok(missing.includes('-'))
    assert.ok(t.includes('3 apps: 1 confirmed, 1 no_change, 1 not_confirmed, 0 failed'))
    assert.ok(!t.includes('\u2014'))
  })

  it('counts failures in the totals line', () => {
    const mk = outcome => ({ app: 'x-app', good: 'v1', cand: 'v2', outcome, crawl: null, controlDifferences: null, candidateDifferences: null, confirmed: 0, total: 0, error: null, seconds: 0 })
    const t = renderTable([mk('build_failed'), mk('crawl_failed'), mk('no_steps'), mk('timeout'), mk('error'), mk('confirmed')])
    assert.ok(t.includes('6 apps: 1 confirmed, 0 no_change, 0 not_confirmed, 5 failed'))
  })

  it('cuts the note at 80 characters', () => {
    const r = { app: 'x-app', good: 'v1', cand: 'v2', outcome: 'error', crawl: null, controlDifferences: null, candidateDifferences: null, confirmed: 0, total: 0, error: 'e'.repeat(200), seconds: 0 }
    const t = renderTable([r])
    const row = t.split('\n').find(l => l.includes('x-app'))
    assert.ok(row.length < 300)
  })
})
