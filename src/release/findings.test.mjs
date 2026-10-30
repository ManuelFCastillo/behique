// Offline tests for findings.mjs: no browser, no build, no I/O.
// Run: node --test src/release/findings.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { factToFinding, selectFindings, judgeFindings, firstConfirmed, summarize } from './findings.mjs'

const actions = [
  { type: 'click', selector: 'a.one' },
  { type: 'click', selector: 'a.two' },
  { type: 'click', selector: 'a.three' },
]
const start = '/'
const emptyBaseline = { stable: {}, volatile: {} }

describe('factToFinding', () => {
  it('turns an attribute fact into an attr finding with xpath selector', () => {
    const d = { i: 1, step: 's', key: 'body/div[1]/a[2]@href', kind: 'changed', was: '/old', now: '/new' }
    const f = factToFinding(d, actions, start, emptyBaseline)
    assert.equal(f.id, 'R1')
    assert.equal(f.assert.kind, 'attr')
    assert.equal(f.assert.selector, 'xpath=/html/body/div[1]/a[2]')
    assert.equal(f.assert.name, 'href')
    assert.equal(f.assert.op, 'equals')
    assert.equal(f.assert.value, '/old')
    assert.equal(f.title, 'href of div[1]/a[2] after step 1 keeps the previous release\'s value')
    assert.equal(f.expected, JSON.stringify('/old'))
    assert.equal(f.actual, JSON.stringify('/new'))
    assert.deepEqual(f.history, actions.slice(0, 1))
  })

  it('turns a #text fact into a text finding', () => {
    const d = { i: 2, step: 's', key: 'body/div[1]/p[1]#text', kind: 'changed', was: 'hello', now: 'bye' }
    const f = factToFinding(d, actions, start, emptyBaseline)
    assert.equal(f.assert.kind, 'text')
    assert.equal(f.assert.selector, 'xpath=/html/body/div[1]/p[1]')
    assert.equal(f.assert.op, 'contains')
    assert.equal(f.assert.value, 'hello')
    assert.equal(f.title, 'text of div[1]/p[1] after step 2 keeps the previous release\'s value')
  })

  it('uses contains for values of 300 or more characters', () => {
    const long = 'x'.repeat(300)
    const d = { i: 1, step: 's', key: 'body/div[1]/a[1]@title', kind: 'changed', was: long, now: 'short' }
    const f = factToFinding(d, actions, start, emptyBaseline)
    assert.equal(f.assert.kind, 'attr')
    assert.equal(f.assert.op, 'contains')
    const short = { ...d, was: 'y'.repeat(299) }
    assert.equal(factToFinding(short, actions, start, emptyBaseline).assert.op, 'equals')
  })

  it('turns a scroll fact with numeric earlier value into a relative scroll_delta', () => {
    const baseline = { stable: { '0|window@scrollY': 100 }, volatile: {} }
    const d = { i: 1, step: 's', key: 'window@scrollY', kind: 'changed', was: 400, now: 460 }
    const f = factToFinding(d, actions, start, baseline)
    assert.equal(f.assert.kind, 'scroll_delta')
    assert.equal(f.assert.value, 300)
    assert.equal(f.id, 'R1')
    assert.match(f.title, /the page scrolls by 300 pixels after: click a\.one/)
    assert.equal(f.expected, 'the page scrolls by 300 pixels (the old version)')
    assert.match(f.actual, /pixels lower down/)
  })

  it('returns null for a scroll fact at i = 0', () => {
    const baseline = { stable: {}, volatile: {} }
    const d = { i: 0, step: 's', key: 'window@scrollY', kind: 'changed', was: 10, now: 20 }
    assert.equal(factToFinding(d, actions, start, baseline), null)
  })

  it('returns null when the earlier scroll value is not a number', () => {
    const d = { i: 1, step: 's', key: 'window@scrollY', kind: 'changed', was: 10, now: 20 }
    assert.equal(factToFinding(d, actions, start, emptyBaseline), null)
    const s = { stable: { '0|window@scrollY': 'far' }, volatile: {} }
    assert.equal(factToFinding(d, actions, start, s), null)
  })

  it('id defaults to R1 and can be set', () => {
    const d = { i: 1, step: 's', key: 'body/div[1]/a[1]@href', kind: 'changed', was: 'a', now: 'b' }
    assert.equal(factToFinding(d, actions, start, emptyBaseline).id, 'R1')
    assert.equal(factToFinding(d, actions, start, emptyBaseline, 'R7').id, 'R7')
  })
})

describe('selectFindings', () => {
  const fact = (key, i, was = 'old', now = 'new') => ({ i, step: `step ${i}`, key, kind: 'changed', was, now })

  it('gives two different facts R1 and R2 with fact provenance', () => {
    const changed = [fact('body/div[1]/a[1]@href', 1), fact('body/div[1]/p[1]#text', 2, 'a', 'b')]
    const { findings, skipped } = selectFindings(changed, actions, start, emptyBaseline)
    assert.equal(findings.length, 2)
    assert.equal(findings[0].id, 'R1')
    assert.equal(findings[1].id, 'R2')
    assert.deepEqual(findings[0].fact, { key: 'body/div[1]/a[1]@href', i: 1, was: 'old', now: 'new' })
    assert.deepEqual(skipped, [])
  })

  it('keeps only the earliest step per key and skips carried-over entries', () => {
    const changed = [
      fact('body/div[1]/a[1]@href', 2, 'a', 'b'),
      fact('body/div[1]/a[1]@href', 1, 'a', 'b'),
      fact('body/div[1]/a[1]@href', 3, 'a', 'b'),
    ]
    const { findings, skipped } = selectFindings(changed, actions, start, emptyBaseline)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].fact.i, 1)
    assert.equal(findings[0].id, 'R1')
    assert.equal(skipped.length, 2)
    assert.ok(skipped.every(s => s.key === 'body/div[1]/a[1]@href'))
    assert.ok(skipped.every(s => s.why.startsWith('carried over from step')))
  })

  it('skips an untestable fact without using up an id', () => {
    const changed = [
      { i: 0, step: 's', key: 'window@scrollY', kind: 'changed', was: 5, now: 6 },
      fact('body/div[1]/a[1]@href', 1, 'a', 'b'),
    ]
    const { findings, skipped } = selectFindings(changed, actions, start, emptyBaseline)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].id, 'R1')
    assert.equal(findings[0].fact.key, 'body/div[1]/a[1]@href')
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0].why, 'cannot be written as a test')
  })

  it('honours max and lists the overflow', () => {
    const changed = [
      fact('body/div[1]/a[1]@href', 1, 'a', 'b'),
      fact('body/div[1]/a[2]@href', 1, 'a', 'b'),
      fact('body/div[1]/a[3]@href', 1, 'a', 'b'),
    ]
    const { findings, skipped } = selectFindings(changed, actions, start, emptyBaseline, { max: 1 })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].id, 'R1')
    assert.equal(skipped.length, 2)
    assert.ok(skipped.every(s => s.why === 'over the limit of 1 findings'))
  })

  it('ignores added, removed and moved facts', () => {
    const changed = [
      { i: 1, step: 's', key: 'body/div[1]/a[1]@href', kind: 'added', was: null, now: 'x' },
      { i: 1, step: 's', key: 'body/div[1]/a[2]@href', kind: 'removed', was: 'x', now: null },
      { i: 1, step: 's', key: 'body/div[1]/a[3]@href', kind: 'moved', was: 'x', now: 'x' },
    ]
    assert.deepEqual(selectFindings(changed, actions, start, emptyBaseline), { findings: [], skipped: [] })
  })

  it('returns empty for empty input', () => {
    assert.deepEqual(selectFindings([], actions, start, emptyBaseline), { findings: [], skipped: [] })
  })
})

describe('judgeFindings', () => {
  const f = id => ({ id })
  const run = results => ({ results })
  const errRun = () => ({ error: 'boom', results: {} })

  it('confirms when good always passes and candidate always fails', () => {
    const [j] = judgeFindings([f('R1')], [run({ R1: true }), run({ R1: true })], [run({ R1: false }), run({ R1: false })])
    assert.equal(j.verdict, 'confirmed')
    assert.equal(j.goodPassed, 2)
    assert.equal(j.candFailed, 2)
    assert.equal(j.runs, 2)
  })

  it('reports fails_both when good always fails', () => {
    const [j] = judgeFindings([f('R1')], [run({ R1: false }), run({ R1: false })], [run({ R1: false })])
    assert.equal(j.verdict, 'fails_both')
  })

  it('reports not_reproduced when everything passes', () => {
    const [j] = judgeFindings([f('R1')], [run({ R1: true })], [run({ R1: true })])
    assert.equal(j.verdict, 'not_reproduced')
  })

  it('reports unstable on mixed results', () => {
    const [j] = judgeFindings([f('R1')], [run({ R1: true }), run({ R1: false })], [run({ R1: false })])
    assert.equal(j.verdict, 'unstable')
  })

  it('reports error when a run has an error', () => {
    const [j] = judgeFindings([f('R1')], [run({ R1: true })], [errRun()])
    assert.equal(j.verdict, 'error')
  })

  it('reports error when an id is missing', () => {
    const [j] = judgeFindings([f('R1')], [run({ R2: true })], [run({ R1: false })])
    assert.equal(j.verdict, 'error')
  })

  it('checks error before confirmed', () => {
    const [j] = judgeFindings([f('R1')], [run({ R1: true }), errRun()], [run({ R1: false })])
    assert.equal(j.verdict, 'error')
  })

  it('checks fails_both before not_reproduced only by order, and counts runs', () => {
    const js = judgeFindings([f('R1'), f('R2')],
      [run({ R1: false, R2: true }), run({ R1: false, R2: true })],
      [run({ R1: true, R2: true }), run({ R1: true, R2: true })])
    assert.equal(js[0].verdict, 'fails_both')
    assert.equal(js[1].verdict, 'not_reproduced')
    assert.equal(js[1].goodPassed, 2)
    assert.equal(js[1].candFailed, 0)
  })
})

describe('firstConfirmed and summarize', () => {
  it('firstConfirmed returns the first confirmed entry or null', () => {
    const judged = [
      { id: 'R1', verdict: 'unstable', goodPassed: 1, candFailed: 1, runs: 2 },
      { id: 'R2', verdict: 'confirmed', goodPassed: 2, candFailed: 2, runs: 2 },
      { id: 'R3', verdict: 'confirmed', goodPassed: 2, candFailed: 2, runs: 2 },
    ]
    assert.equal(firstConfirmed(judged).id, 'R2')
    assert.equal(firstConfirmed([{ id: 'R1', verdict: 'unstable' }]), null)
    assert.equal(firstConfirmed([]), null)
  })

  it('summarize mixes verdicts and carried-over counts', () => {
    const judged = [
      { id: 'R1', verdict: 'confirmed' },
      { id: 'R2', verdict: 'unstable' },
      { id: 'R3', verdict: 'confirmed' },
    ]
    const skipped = [
      { key: 'a', i: 2, why: 'carried over from step 1' },
      { key: 'b', i: 3, why: 'carried over from step 1' },
      { key: 'c', i: 3, why: 'carried over from step 1' },
      { key: 'd', i: 3, why: 'carried over from step 1' },
    ]
    const s = summarize(judged, skipped)
    assert.equal(s, '2 of 3 findings confirmed (R1, R3); 1 unstable (R2); 4 facts carried over from an earlier step')
    assert.ok(!s.includes('―'))
  })

  it('summarize leaves out zero parts', () => {
    assert.equal(summarize([{ id: 'R1', verdict: 'confirmed' }], []), '1 of 1 findings confirmed (R1)')
    const s = summarize([{ id: 'R1', verdict: 'fails_both' }], [{ key: 'a', i: 1, why: 'carried over from step 0' }])
    assert.equal(s, '0 of 1 findings confirmed; 1 fails_both (R1); 1 fact carried over from an earlier step')
  })

  it('summarize covers error and not_reproduced', () => {
    const s = summarize([{ id: 'R1', verdict: 'error' }, { id: 'R2', verdict: 'not_reproduced' }], [])
    assert.equal(s, '0 of 2 findings confirmed; 1 error (R1); 1 not_reproduced (R2)')
  })
})
