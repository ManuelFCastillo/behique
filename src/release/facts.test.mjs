// Tests for the pure parts of facts.mjs: the baseline, the diff and the mask the control run widens.
//   node --test src/release/facts.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBaseline, diffFacts, evaluateSettled, rankDiffs, widenMask } from './facts.mjs'

const run = (...facts) => facts.map((f, i) => ({ label: `s${i}`, facts: f }))

describe('evaluateSettled', () => {
  const page = (...outcomes) => { let n = 0; return { calls: () => n, evaluate: async () => { const o = outcomes[n++]; if (o instanceof Error) throw o; return o } } }
  const destroyed = () => new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')

  it('returns the first result when the page is still', async () => {
    const p = page({ a: 1 })
    assert.deepEqual(await evaluateSettled(p, () => 0, { waitFor: async () => {} }), { a: 1 }); assert.equal(p.calls(), 1)
  })
  it('waits and tries again when the page navigated while the script ran', async () => {
    const p = page(destroyed(), destroyed(), { a: 2 }), waited = []
    assert.deepEqual(await evaluateSettled(p, () => 0, { waitFor: async n => waited.push(n) }), { a: 2 })
    assert.equal(p.calls(), 3); assert.deepEqual(waited, [1, 2])
  })
  it('gives up after the last try, with the page error', async () => {
    const p = page(destroyed(), destroyed(), destroyed())
    await assert.rejects(evaluateSettled(p, () => 0, { waitFor: async () => {} }), /Execution context was destroyed/); assert.equal(p.calls(), 3)
  })
  it('does not retry any other error', async () => {
    const p = page(new Error('ReferenceError: x is not defined'), { a: 3 })
    await assert.rejects(evaluateSettled(p, () => 0, { waitFor: async () => {} }), /ReferenceError/); assert.equal(p.calls(), 1)
  })
})

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

describe('scroll and class facts in the diff', () => {
  it('a #scrolls fact that vanished is a removed diff and ranks with the others; one that moved pairs up', () => {
    const base = buildBaseline([{ label: 's', facts: { 'body/main[1]#scrolls': 'y', 'body/div[1]#scrolls': 'y', 'body/div[1]@class': 'a b' } }], [{ label: 's', facts: { 'body/main[1]#scrolls': 'y', 'body/div[1]#scrolls': 'y', 'body/div[1]@class': 'a b' } }])
    const diffs = diffFacts(base, [{ label: 's', facts: { 'body/div[2]#scrolls': 'y', 'body/div[1]@class': 'a b hidden' } }])
    const ranked = rankDiffs(diffs)
    assert.deepEqual(ranked.map(d => d.kind), ['changed', 'removed', 'moved']) // one of the two lost areas pairs with the new one as moved, the other is a loss
    assert.equal(ranked[0].key, 'body/div[1]@class')
    assert.equal(ranked[2].key, 'body/div[2]#scrolls')
    assert.ok(['body/main[1]#scrolls', 'body/div[1]#scrolls'].includes(ranked[1].key))
  })
})
