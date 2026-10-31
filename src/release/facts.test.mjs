// Tests for the pure parts of facts.mjs: the baseline, the diff and the mask the control run widens.
//   node --test src/release/facts.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBaseline, diffFacts, widenMask } from './facts.mjs'

const run = (...facts) => facts.map((f, i) => ({ label: `s${i}`, facts: f }))

describe('widenMask', () => {
  const a = run({ 'body/p[1]#text': 'one', 'body/h1[1]#text': 'Title' })
  const baseline = buildBaseline(a, run({ 'body/p[1]#text': 'one', 'body/h1[1]#text': 'Title' }))

  it('masks a fact the control changed, so the same control now diffs clean', () => {
    const control = run({ 'body/p[1]#text': 'two', 'body/h1[1]#text': 'Title' })
    const diffs = diffFacts(baseline, control)
    assert.equal(diffs.length, 1)
    const w = widenMask(baseline, diffs)
    assert.equal(w.added, 1)
    assert.deepEqual(diffFacts(w.baseline, control), [])
    assert.ok('0|body/p[1]#text' in w.baseline.volatile)
    assert.ok(!('0|body/p[1]#text' in w.baseline.stable))
  })

  it('masks facts that appeared or vanished in the control', () => {
    const control = run({ 'body/h1[1]#text': 'Title', 'body/blockquote[1]#text': 'quote' })
    const diffs = diffFacts(baseline, control)
    assert.deepEqual(diffs.map(d => d.kind).sort(), ['added', 'removed'])
    const w = widenMask(baseline, diffs)
    assert.equal(w.added, 2)
    assert.deepEqual(diffFacts(w.baseline, control), [])
  })

  it('does not hide a real change in a fact the control agreed on', () => {
    const control = run({ 'body/p[1]#text': 'two', 'body/h1[1]#text': 'Title' })
    const w = widenMask(baseline, diffFacts(baseline, control))
    const cand = run({ 'body/p[1]#text': 'one', 'body/h1[1]#text': 'Changed title' })
    const d = diffFacts(w.baseline, cand)
    assert.equal(d.length, 1)
    assert.equal(d[0].key, 'body/h1[1]#text')
  })

  it('does not change the baseline it was given, and counts a fact once', () => {
    const control = run({ 'body/p[1]#text': 'two', 'body/h1[1]#text': 'Title' })
    const diffs = diffFacts(baseline, control)
    const before = JSON.stringify(baseline)
    const w1 = widenMask(baseline, diffs)
    assert.equal(JSON.stringify(baseline), before)
    assert.equal(widenMask(w1.baseline, diffs).added, 0)
  })

  it('masks a widget that is noisy at several steps at every step', () => {
    const base = (q) => ({ 'body/footer[1]#text': 'copy', 'body/blockquote[1]#text': q })
    const b = buildBaseline(run(base('a'), base('a'), base('a'), base('a'), base('a')), run(base('a'), base('a'), base('a'), base('a'), base('a')))
    const control = run(base('a'), base('x'), base('y'), base('z'), base('a'))
    const w = widenMask(b, diffFacts(b, control))
    assert.deepEqual(diffFacts(w.baseline, run(base('q'), base('q'), base('q'), base('q'), base('q'))), [])
    assert.equal(w.added, 5)
  })

  it('leaves the same key alone at other steps when it was noisy at fewer than three', () => {
    const base = (q) => ({ 'body/blockquote[1]#text': q })
    const b = buildBaseline(run(base('a'), base('a'), base('a'), base('a')), run(base('a'), base('a'), base('a'), base('a')))
    const w = widenMask(b, diffFacts(b, run(base('a'), base('x'), base('y'), base('a'))))
    assert.equal(w.added, 2)
    assert.equal(diffFacts(w.baseline, run(base('q'), base('a'), base('a'), base('a'))).length, 1)
  })

  it('also masks the widget at steps where the baseline never showed it', () => {
    const base = { 'body/footer[1]#text': 'copy' }
    const b = buildBaseline(run(base, base, base, base), run(base, base, base, base))
    const withQuote = { ...base, 'body/blockquote[3]#text': 'q' }
    const w = widenMask(b, diffFacts(b, run(withQuote, withQuote, withQuote, base)))
    assert.equal(w.added, 3)
    assert.deepEqual(diffFacts(w.baseline, run(base, base, base, withQuote)), [])
  })
})
