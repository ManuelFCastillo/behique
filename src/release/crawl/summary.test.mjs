// Tests for crawl summaries: numbers, verdicts and comparisons.
// Run with: node --test src/release/crawl/summary.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeCrawl, renderSummary, compareSummaries } from './summary.mjs'

function state(url, title, depth) {
  return { url, title, path: Array.from({ length: depth }, (_, i) => `label${i}`) }
}

function goodCrawl(over = {}) {
  return {
    app: 'demo',
    ref: 'v1',
    sha: 'abc123',
    options: {},
    stoppedBy: 'done',
    ms: 4000,
    stats: { tried: 10, states: 6, seenAgain: 1, failed: 0, queued: 0 },
    states: [
      state('http://x/one', 'One', 0),
      state('http://x/two', 'Two', 1),
      state('http://x/three', 'Three', 2),
      state('http://x/four', 'Four', 1),
      state('http://x/five', 'Five', 2),
      state('http://x/six', 'Six', 3)
    ],
    flows: [['a'], ['b'], ['c']],
    steps: [{ type: 'click', label: 'a' }, { type: 'click', label: 'b' }, { type: 'goto', path: '/' }],
    ...over
  }
}

describe('summarizeCrawl quality rules', () => {
  it('rates a healthy crawl good with no reasons', () => {
    const s = summarizeCrawl(goodCrawl())
    assert.equal(s.quality, 'good')
    assert.deepEqual(s.reasons, [])
    assert.equal(s.states, 6)
    assert.equal(s.flows, 3)
    assert.equal(s.steps, 3)
    assert.equal(s.clicks, 2)
  })

  it('fails when there are no steps', () => {
    const s = summarizeCrawl(goodCrawl({ steps: [] }))
    assert.equal(s.quality, 'failed')
    assert.ok(s.reasons.includes('The crawl produced no steps.'))
  })

  it('is degenerate when only the landing page was found', () => {
    const s = summarizeCrawl(goodCrawl({
      states: [state('http://x/', 'Home', 0)],
      flows: [['a'], ['b']],
      steps: [{ type: 'click' }]
    }))
    assert.equal(s.quality, 'degenerate')
    assert.ok(s.reasons.includes('Only the landing page was found.'))
  })

  it('is degenerate with zero states', () => {
    const s = summarizeCrawl(goodCrawl({ states: [], flows: [['a'], ['b']], steps: [{ type: 'click' }] }))
    assert.equal(s.quality, 'degenerate')
  })

  it('is thin when the failure ratio is above 0.3', () => {
    const s = summarizeCrawl(goodCrawl({ stats: { tried: 10, states: 6, seenAgain: 0, failed: 4, queued: 0 } }))
    assert.equal(s.quality, 'thin')
    assert.ok(s.reasons.includes('More than 30 percent of the tries failed.'))
    assert.equal(s.failedRatio, 0.4)
  })

  it('is thin when most pages look the same', () => {
    const states = [
      state('http://x/a', 'Same', 1),
      state('http://x/a', 'Same', 1),
      state('http://x/b', 'Same', 2),
      state('http://x/b', 'Same', 2),
      state('http://x/a', 'Same', 1),
      state('http://x/b', 'Same', 2)
    ]
    const s = summarizeCrawl(goodCrawl({ states }))
    assert.equal(s.quality, 'thin')
    assert.ok(s.reasons.includes('Most pages look the same (few titles and few addresses).'))
  })

  it('is thin when only one click path was found', () => {
    const s = summarizeCrawl(goodCrawl({ flows: [['a']] }))
    assert.equal(s.quality, 'thin')
    assert.ok(s.reasons.includes('Only one click path was found.'))
  })

  it('applies rules in order and keeps every fired reason', () => {
    const s = summarizeCrawl({
      app: 'demo',
      ref: 'v1',
      stoppedBy: 'done',
      ms: 1000,
      stats: { tried: 10, states: 1, seenAgain: 0, failed: 9, queued: 0 },
      states: [state('http://x/', 'Home', 0)],
      flows: [],
      steps: []
    })
    assert.equal(s.quality, 'failed')
    assert.ok(s.reasons.includes('The crawl produced no steps.'))
    assert.ok(s.reasons.includes('Only the landing page was found.'))
    assert.ok(s.reasons.includes('More than 30 percent of the tries failed.'))
    assert.ok(s.reasons.includes('Only one click path was found.'))
  })

  it('prefers degenerate over thin', () => {
    const s = summarizeCrawl(goodCrawl({
      states: [state('http://x/', 'Home', 0)],
      flows: [],
      steps: [{ type: 'click' }],
      stats: { tried: 10, states: 1, seenAgain: 0, failed: 5, queued: 0 }
    }))
    assert.equal(s.quality, 'degenerate')
  })
})

describe('summarizeCrawl extra reasons', () => {
  it('adds a note when stopped at the path limit', () => {
    const s = summarizeCrawl(goodCrawl({ stoppedBy: 'paths' }))
    assert.equal(s.quality, 'good')
    assert.ok(s.reasons.includes('Stopped at the path limit; more pages may exist.'))
  })

  it('adds a note when stopped at the time budget', () => {
    const s = summarizeCrawl(goodCrawl({ stoppedBy: 'budget' }))
    assert.equal(s.quality, 'good')
    assert.ok(s.reasons.includes('Stopped at the time budget; more pages may exist.'))
  })
})

describe('summarizeCrawl numbers', () => {
  it('computes depth max and mean with one decimal', () => {
    const s = summarizeCrawl(goodCrawl({
      states: [state('http://x/a', 'A', 0), state('http://x/b', 'B', 1), state('http://x/c', 'C', 2)]
    }))
    assert.equal(s.maxDepth, 2)
    assert.equal(s.meanDepth, 1)
  })

  it('rounds mean depth to one decimal', () => {
    const s = summarizeCrawl(goodCrawl({
      states: [state('http://x/a', 'A', 0), state('http://x/b', 'B', 1), state('http://x/c', 'C', 1)]
    }))
    assert.equal(s.meanDepth, 0.7)
  })

  it('removes the origin and skips empty titles', () => {
    const s = summarizeCrawl(goodCrawl({
      states: [
        state('http://one:8000/a?x=1', 'Same', 0),
        state('http://two:9000/a?x=1', 'Same', 1),
        state('http://two:9000/b', '', 1),
        { url: 'http://two:9000/b', title: 'Other', path: [] }
      ]
    }))
    assert.equal(s.distinctUrls, 2)
    assert.equal(s.distinctTitles, 2)
  })

  it('counts distinct states from url and title pairs', () => {
    const s = summarizeCrawl(goodCrawl({
      states: [
        state('http://x/a', 'Same', 0),
        state('http://x/a', 'Same', 1),
        state('http://x/a', 'Other', 1)
      ]
    }))
    assert.equal(s.distinctStates, 2)
  })

  it('gives failedRatio 0 when nothing was tried', () => {
    const s = summarizeCrawl(goodCrawl({ stats: { tried: 0, states: 0, seenAgain: 0, failed: 5, queued: 0 } }))
    assert.equal(s.failedRatio, 0)
  })

  it('rounds failedRatio to two decimals and seconds to one decimal', () => {
    const s = summarizeCrawl(goodCrawl({ stats: { tried: 3, states: 6, seenAgain: 0, failed: 1, queued: 0 }, ms: 1450 }))
    assert.equal(s.failedRatio, 0.33)
    assert.equal(s.seconds, 1.5)
  })

  it('falls back to unknown stoppedBy', () => {
    const s = summarizeCrawl(goodCrawl({ stoppedBy: undefined }))
    assert.equal(s.stoppedBy, 'unknown')
  })

  it('treats missing and wrong-typed fields as empty', () => {
    const s = summarizeCrawl({ app: 'demo', ref: 'v1', stats: 'nope', states: 'nope', flows: null, steps: 7 })
    assert.equal(s.states, 0)
    assert.equal(s.flows, 0)
    assert.equal(s.steps, 0)
    assert.equal(s.clicks, 0)
    assert.equal(s.tried, 0)
    assert.equal(s.maxDepth, 0)
    assert.equal(s.meanDepth, 0)
    assert.equal(s.quality, 'failed')
  })

  it('never throws and handles non-object input', () => {
    for (const bad of [null, undefined, 42, 'crawl', true]) {
      const s = summarizeCrawl(bad)
      assert.equal(s.quality, 'failed')
      assert.deepEqual(s.reasons, ['No crawl data.'])
      assert.equal(s.states, 0)
      assert.equal(s.seconds, 0)
    }
  })
})

describe('renderSummary', () => {
  it('renders one line per section plus one note per reason', () => {
    const s = summarizeCrawl(goodCrawl({ stoppedBy: 'paths' }))
    const lines = renderSummary(s)
    assert.equal(lines[0], 'demo v1: good')
    assert.equal(lines[1], `pages: ${s.states} (${s.distinctStates} distinct, ${s.distinctTitles} titles), depth max ${s.maxDepth} mean ${s.meanDepth}`)
    assert.equal(lines[2], `click paths: ${s.flows}, steps: ${s.steps} (${s.clicks} clicks)`)
    assert.equal(lines[3], `tries: ${s.tried}, failed ${s.failed} (${s.failedRatio}), already seen ${s.seenAgain}`)
    assert.equal(lines[4], `stopped by: paths after ${s.seconds} s`)
    assert.ok(lines.includes('note: Stopped at the path limit; more pages may exist.'))
  })

  it('renders reasons in order', () => {
    const s = summarizeCrawl(goodCrawl({ stoppedBy: 'budget', flows: [['a']] }))
    const lines = renderSummary(s)
    assert.ok(lines.includes('note: Only one click path was found.'))
    assert.ok(lines.includes('note: Stopped at the time budget; more pages may exist.'))
  })
})

describe('compareSummaries', () => {
  it('prefers the better quality', () => {
    const a = summarizeCrawl(goodCrawl())
    const b = summarizeCrawl(goodCrawl({ flows: [['a']] }))
    assert.equal(b.quality, 'thin')
    const r = compareSummaries(a, b)
    assert.equal(r.better, 'a')
    assert.equal(r.same, false)
    assert.ok(r.notes.some(n => n.includes('quality')))
  })

  it('breaks ties by distinct states', () => {
    const a = summarizeCrawl(goodCrawl())
    const b = summarizeCrawl(goodCrawl({
      states: [...goodCrawl().states, state('http://x/extra', 'Extra', 1)],
      flows: [['a'], ['b'], ['c']]
    }))
    const r = compareSummaries(a, b)
    assert.equal(r.better, 'b')
    assert.ok(r.notes.some(n => n.includes('distinctStates')))
  })

  it('breaks ties by flows', () => {
    const base = goodCrawl({ states: goodCrawl().states })
    const a = { ...summarizeCrawl(base), flows: 2, distinctStates: 4, quality: 'good' }
    const b = { ...summarizeCrawl(base), flows: 3, distinctStates: 4, quality: 'good' }
    const r = compareSummaries(a, b)
    assert.equal(r.better, 'b')
    assert.ok(r.notes.some(n => n.includes('flows')))
  })

  it('reports all equal', () => {
    const a = summarizeCrawl(goodCrawl())
    const b = summarizeCrawl(goodCrawl())
    const r = compareSummaries(a, b)
    assert.equal(r.better, null)
    assert.equal(r.same, true)
    assert.deepEqual(r.notes, [])
  })
})
