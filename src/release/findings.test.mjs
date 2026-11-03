// Offline tests for findings.mjs: no browser, no build, no I/O.
// Run: node --test src/release/findings.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { factToFinding, selectFindings, judgeFindings, firstConfirmed, summarize, vanishedRoots, appearedStates } from './findings.mjs'

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
    assert.equal(f.assert.kind, 'own_text') // the element's own text, compared exactly: a longer new text must not pass for the old one
    assert.equal(f.assert.selector, 'xpath=/html/body/div[1]/p[1]')
    assert.equal(f.assert.op, 'equals')
    assert.equal(f.assert.value, 'hello')
    assert.equal(f.title, 'text of div[1]/p[1] after step 2 keeps the previous release\'s value')
  })

  it('a #text fact of 300 or more characters is compared with contains (facts cut values there)', () => {
    const d = { i: 2, step: 's', key: 'body/p[1]#text', kind: 'changed', was: 'x'.repeat(300), now: 'y' }
    const f = factToFinding(d, actions, start, emptyBaseline)
    assert.equal(f.assert.kind, 'own_text'); assert.equal(f.assert.op, 'contains')
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

  it('ranks what a person would notice first, so ids and the cap follow the class', () => {
    const changed = [
      fact('body/div[1]/label[1]@for', 1, '_r_1_', '_r_2_'), // churn
      fact('body/div[1]/button[1]@data-slot', 1, '', 'button'), // churn
      fact('body/div[1]/p[1]#text', 2, 'for the last decade', 'for over a decade'), // visible
      fact('body/div[1]/a[1]@href', 3, '/docs/a', '/docs/b'), // visible
    ]
    const { findings, skipped } = selectFindings(changed, actions, start, emptyBaseline, { max: 3 })
    assert.deepEqual(findings.map(f => [f.id, f.fact.key, f.notice.cls]), [
      ['R1', 'body/div[1]/p[1]#text', 'visible'], ['R2', 'body/div[1]/a[1]@href', 'visible'], ['R3', 'body/div[1]/label[1]@for', 'churn'],
    ])
    assert.deepEqual(skipped, [{ key: 'body/div[1]/button[1]@data-slot', i: 1, why: 'over the limit of 3 findings' }])
    assert.equal(findings[0].notice.why, 'text a person reads')
  })

  it('never turns third-party content into a finding, and says so', () => {
    const changed = [
      fact('body/div[1]/span[1]/a[1]/img[1]@src', 1, 'https://srv.carbonads.net/static/1/aaaaaaaaaaaa', 'https://srv.carbonads.net/static/1/bbbbbbbbbbbb'),
      fact('body/div[1]/img[1]@src', 1, 'http://127.0.0.1:8300/a.png', 'http://127.0.0.1:8300/b.png'),
    ]
    const { findings, skipped } = selectFindings(changed, actions, start, emptyBaseline, { origin: 'http://127.0.0.1:8300' })
    assert.deepEqual(findings.map(f => [f.id, f.fact.key]), [['R1', 'body/div[1]/img[1]@src']])
    assert.deepEqual(skipped, [{ key: 'body/div[1]/span[1]/a[1]/img[1]@src', i: 1, why: "third-party content (content loaded from srv.carbonads.net, not the app's own)" }])
  })

  it('ignores added and moved facts; a removed fact is tested as a vanished element', () => {
    const changed = [
      { i: 1, step: 's', key: 'body/div[1]/a[1]@href', kind: 'added', was: null, now: 'x' },
      { i: 1, step: 's', key: 'body/div[1]/a[2]@href', kind: 'removed', was: 'x', now: null },
      { i: 1, step: 's', key: 'body/div[1]/a[3]@href', kind: 'moved', was: 'x', now: 'x' },
    ]
    const { findings, skipped } = selectFindings(changed, actions, start, emptyBaseline)
    assert.deepEqual(skipped, [])
    assert.deepEqual(findings.map(f => [f.id, f.fact.key, f.fact.removed, f.actual]), [['R1', 'body/div[1]/a[2]@href', true, 'missing on the candidate']])
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

describe('a step that could not be performed', () => {
  it('is reported as a changed or added fact but never becomes a test', () => {
    const d = { i: 2, step: '2:click role=link[name="Gone"]', key: 'step@error', kind: 'added', was: null, now: 'locator.click: Timeout 3000ms exceeded.' }
    assert.equal(factToFinding(d, [{ type: 'click', selector: 'a' }, { type: 'click', selector: 'b' }], '/', { stable: {} }), null)
    const { findings, skipped } = selectFindings([{ ...d, kind: 'changed', was: 'x' }], [], '/', { stable: {} })
    assert.deepEqual(findings, []); assert.equal(skipped[0].why, 'cannot be written as a test')
  })
})

describe('history of a step in a crawled flow', () => {
  const crawled = [
    { type: 'click', selector: 'a.one' },
    { type: 'goto', path: '/' },
    { type: 'click', selector: 'a.two' },
    { type: 'click', selector: 'a.three' },
  ]
  const d = { i: 4, step: '4', key: 'body/p[1]@title', kind: 'changed', was: 'x', now: 'y' }
  it('replays only the flow the step is in, after the last goto to the start', () => {
    const f = factToFinding(d, crawled, '/', { stable: {} })
    assert.deepEqual(f.history, [{ type: 'click', selector: 'a.two' }, { type: 'click', selector: 'a.three' }])
  })
  it('replays everything when there is no goto, and for a step in the first flow', () => {
    assert.equal(factToFinding({ ...d, i: 1 }, crawled, '/', { stable: {} }).history.length, 1)
    assert.equal(factToFinding({ ...d, i: 3 }, crawled.filter(a => a.type !== 'goto'), '/', { stable: {} }).history.length, 3)
  })
  it('a direct load of another page starts a flow too, and is kept as the first replayed action', () => {
    const odd = [{ type: 'click', selector: 'a' }, { type: 'goto', path: '/about' }, { type: 'click', selector: 'b' }]
    assert.deepEqual(factToFinding({ ...d, i: 3 }, odd, '/', { stable: {} }).history, odd.slice(1))
    assert.deepEqual(factToFinding({ ...d, i: 2 }, odd, '/', { stable: {} }).history, [odd[1]]) // the state right after the direct load: the load itself is the step
  })
})

describe('a state attribute newly set on the candidate becomes a test that expects it absent', () => {
  const baseline = { stable: { '1|body/div[1]/aside[1]@class': 'VPSidebar', '1|body/div[1]/aside[1]/a[1]@href': '/guide', '1|body/div[1]/p[1]#text': 'hi' }, volatile: {} }
  const appeared = (key, now = '') => ({ i: 1, step: 's1', key, kind: 'added', was: undefined, now })

  it('appearedStates keeps state attributes on elements the good version has, and nothing else', () => {
    const diffs = [
      appeared('body/div[1]/aside[1]@inert'), // a state, on an element the good version has: kept
      appeared('body/div[1]/aside[1]@data-v-1'), // not a state
      appeared('body/div[1]/div[9]@hidden'), // a state, but the element itself is new on the candidate
      appeared('body/div[1]/aside[1]#text', 'x'), // text is not an attribute
      { i: 1, step: 's1', key: 'body/div[1]/p[1]#text', kind: 'changed', was: 'hi', now: 'bye' },
    ]
    assert.deepEqual(appearedStates(diffs, baseline).map(d => d.key), ['body/div[1]/aside[1]@inert'])
    assert.deepEqual(appearedStates([], baseline), [])
    assert.deepEqual(appearedStates(diffs, { stable: {} }), [])
  })

  it('the finding asserts the attribute is absent, and the exporter writes toBeNull for it', () => {
    const f = factToFinding(appeared('body/div[1]/aside[1]@inert'), actions, start, baseline)
    assert.deepEqual(f.assert, { kind: 'attr', selector: 'xpath=/html/body/div[1]/aside[1]', name: 'inert', op: 'absent', value: '' })
    assert.equal(f.title, 'inert of div[1]/aside[1] after step 1 is absent, as on the previous release')
    assert.equal(f.expected, 'absent (not set on the previous release)')
    assert.equal(f.actual, '""')
    assert.equal(factToFinding(appeared('body/div[1]/aside[1]#text', 'x'), actions, start, baseline), null)
  })

  it('selectFindings ranks a newly set state as something a person would notice and marks the fact appeared', () => {
    const { findings } = selectFindings([appeared('body/div[1]/aside[1]@inert'), appeared('body/div[1]/aside[1]@data-v-1')], actions, start, baseline)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].fact.appeared, true)
    assert.deepEqual(findings[0].notice, { cls: 'visible', why: 'a state a person sees (inert)' })
  })
})

describe("the release's own version label", () => {
  it('is ranked as churn, so the bisect follows a real change instead of the release commit', () => {
    const refs = { good: 'v1.0.0-rc.10', cand: 'v1.0.0-rc.12' }
    const label = { i: 1, step: 's1', key: 'body/nav[1]/button[1]/span[1]#text', kind: 'changed', was: '1.0.0-rc.10', now: '1.0.0-rc.12' }
    const real = { i: 1, step: 's1', key: 'body/main[1]/a[1]@href', kind: 'changed', was: '/guide', now: '/guide/' }
    const { findings } = selectFindings([label, real], actions, start, emptyBaseline, { refs })
    assert.deepEqual(findings.map(f => [f.id, f.fact.key, f.notice.cls]), [['R1', 'body/main[1]/a[1]@href', 'visible'], ['R2', 'body/nav[1]/button[1]/span[1]#text', 'churn']])
    assert.equal(findings[1].notice.why, "the release's own version label (1.0.0-rc.10 to 1.0.0-rc.12)")
    // Without the refs the same text is a change a person reads, as before.
    assert.equal(selectFindings([label], actions, start, emptyBaseline).findings[0].notice.cls, 'visible')
  })
})

describe('a vanished element becomes a test', () => {
  const gone = (i, key, was) => ({ i, step: `s${i}`, key, kind: 'removed', was, now: null })

  it('tests the old value, so the test fails whether the element or only its text is gone', () => {
    const f = factToFinding(gone(2, 'body/div[1]/p[1]#text', 'Share'), actions, start, emptyBaseline)
    assert.equal(f.assert.kind, 'own_text'); assert.equal(f.assert.value, 'Share'); assert.equal(f.assert.selector, 'xpath=/html/body/div[1]/p[1]')
    assert.equal(f.title, 'text of div[1]/p[1] after step 2 is still there, as on the previous release')
    assert.equal(f.expected, JSON.stringify('Share')); assert.equal(f.actual, 'missing on the candidate')
    const a = factToFinding(gone(1, 'body/div[1]/a[2]@href', '/share'), actions, start, emptyBaseline)
    assert.equal(a.assert.kind, 'attr'); assert.equal(a.assert.name, 'href'); assert.equal(a.assert.value, '/share')
  })

  it('never tests the scroll position or a failed step as vanished', () => {
    assert.equal(factToFinding(gone(1, 'window@scrollY', 10), actions, start, emptyBaseline), null)
    assert.equal(factToFinding(gone(1, 'step@error', 'x'), actions, start, emptyBaseline), null)
  })

  it('collapses a vanished subtree to its root and keeps the fact a person would miss first', () => {
    const diffs = [
      gone(1, 'body/div[1]/a[2]@class', 'btn'), gone(1, 'body/div[1]/a[2]@href', '/share'), gone(1, 'body/div[1]/a[2]#text', 'Share'),
      gone(1, 'body/div[1]/a[2]/span[1]@class', 'ico'), gone(1, 'body/div[1]/a[2]/span[1]#text', '*'),
      gone(1, 'body/div[1]/p[3]@class', 'x'), // a second element, attribute only
      gone(2, 'body/div[1]/a[2]#text', 'Share'), // the same element at the next step
      gone(1, 'window@scrollY', 0), gone(1, 'step@error', 'x'),
      { i: 1, step: 's1', key: 'body/div[1]/h1[1]#text', kind: 'changed', was: 'a', now: 'b' },
    ]
    const roots = vanishedRoots(diffs)
    assert.deepEqual(roots.map(r => [r.i, r.key, r.vanished]), [[1, 'body/div[1]/a[2]#text', 5], [1, 'body/div[1]/p[3]@class', 1], [2, 'body/div[1]/a[2]#text', 1]])
    assert.ok(roots.every(r => r.kind === 'removed'))
    // the words a person saw inside what vanished travel with the root (texts, titles, labels; not classes or hrefs), the first three and the count
    assert.deepEqual(roots.map(r => [r.names ?? null, r.namesTotal ?? null]), [[['Share', '*'], 2], [null, null], [['Share'], 1]])
    const many = vanishedRoots([gone(1, 'body/div[1]/div[2]@class', 'fixed'), ...[1, 2, 3, 4].map(n => gone(1, `body/div[1]/div[2]/button[${n}]@title`, `Control ${n}`)), gone(1, 'body/div[1]/div[2]/button[1]@aria-label', 'Control 1')])
    assert.deepEqual([many[0].names, many[0].namesTotal], [['Control 1', 'Control 2', 'Control 3'], 4])
  })

  it('a finding keeps the names of what vanished', () => {
    const roots = vanishedRoots([gone(1, 'body/div[1]/div[2]@class', 'fixed'), gone(1, 'body/div[1]/div[2]/button[1]@title', 'Go to next slide')])
    const { findings } = selectFindings(roots, actions, start, emptyBaseline)
    assert.deepEqual([findings[0].fact.names, findings[0].fact.namesTotal], [['Go to next slide'], 1])
  })

  it('selectFindings takes vanished roots after changed facts, with a notice, and marks them', () => {
    const changed = { i: 1, step: 's1', key: 'body/div[1]/h1[1]@data-reactid', kind: 'changed', was: 'a', now: 'b' }
    const roots = vanishedRoots([gone(1, 'body/div[1]/a[2]#text', 'Share'), gone(1, 'body/div[1]/a[2]@href', '/share')])
    const { findings, skipped } = selectFindings([changed, ...roots], actions, start, emptyBaseline)
    assert.equal(findings.length, 2); assert.equal(skipped.length, 0)
    const v = findings.find(f => f.fact.removed)
    assert.equal(v.id, 'R1', 'text a person reads ranks before a framework attribute') // visible before churn
    assert.deepEqual([v.fact.key, v.fact.vanished, v.notice.cls], ['body/div[1]/a[2]#text', 2, 'visible'])
    assert.equal(findings.find(f => !f.fact.removed).notice.cls, 'churn')
  })

  it('with the baseline, a fact dropped from an element the candidate still has is its own entry and swallows nothing beneath it', () => {
    // a scoped-style attribute moved off a parent and its children; the parent kept its class, and the scroll area under it stopped scrolling
    const diffs = [gone(9, 'body/div[1]@data-v-abc', ''), gone(9, 'body/div[1]/div[2]@data-v-abc', ''), gone(9, 'body/div[1]/div[2]/div[1]#scrolls', 'y'),
      gone(9, 'body/div[1]/aside[1]#text', 'Menu'), gone(9, 'body/div[1]/aside[1]/a[1]@href', '/x')] // the aside really vanished: nothing of it survives
    const stable = { '9|body/div[1]@data-v-abc': '', '9|body/div[1]@class': 'app', '9|body/div[1]/div[2]@data-v-abc': '', '9|body/div[1]/div[2]@class': 'pane', '9|body/div[1]/div[2]/div[1]#scrolls': 'y', '9|body/div[1]/aside[1]#text': 'Menu', '9|body/div[1]/aside[1]/a[1]@href': '/x' }
    const roots = vanishedRoots(diffs, { stable })
    assert.deepEqual(roots.map(r => [r.key, r.vanished, r.stillThere === true]), [['body/div[1]/aside[1]#text', 2, false], ['body/div[1]@data-v-abc', 1, true], ['body/div[1]/div[2]@data-v-abc', 1, true], ['body/div[1]/div[2]/div[1]#scrolls', 1, false]])
    assert.deepEqual(vanishedRoots(diffs).map(r => [r.key, r.vanished]), [['body/div[1]@data-v-abc', 4]], 'without the baseline the old rule holds: the first removed fact is a vanished root over everything beneath (the scroll loss under it is not counted)')
    const { findings } = selectFindings(roots, actions, '/', { stable, volatile: {} })
    assert.ok(findings.some(f => f.fact.key.endsWith('#scrolls')), 'the scroll loss is testable now')
    assert.ok(findings.find(f => f.fact.key === 'body/div[1]@data-v-abc').fact.stillThere, 'the finding says the element is still there')
  })
  it('vanishedRoots of nothing is nothing', () => { assert.deepEqual(vanishedRoots([]), []); assert.deepEqual(vanishedRoots(null), []) })
})

describe('an area that stops scrolling, and a class list', () => {
  const actions = [{ type: 'click', selector: 'a.settings' }]
  const baseline = { stable: {}, volatile: {}, labels: ['start', '1:click a.settings'] }
  it('a vanished #scrolls fact becomes a test that asks the same element whether it can scroll', () => {
    const f = factToFinding({ i: 1, key: 'body/div[1]/main[1]#scrolls', kind: 'removed', was: 'y', now: null }, actions, '/', baseline, 'R1')
    assert.deepEqual(f.assert, { kind: 'scrolls', selector: 'xpath=/html/body/div[1]/main[1]' })
    assert.equal(f.title, 'div[1]/main[1] after step 1 can still scroll, as on the previous release')
    assert.equal(f.actual, 'cannot scroll on the candidate')
    assert.deepEqual(f.history, actions)
  })
  it('an area that newly scrolls is not a loss and is not tested', () => {
    assert.equal(factToFinding({ i: 1, key: 'body/div[1]/main[1]#scrolls', kind: 'added', was: null, now: 'y' }, actions, '/', baseline), null)
    assert.equal(factToFinding({ i: 1, key: 'body/div[1]/main[1]#scrolls', kind: 'changed', was: 'y', now: 'n' }, actions, '/', baseline), null)
  })
  it('a changed class list is tested as a sorted class list, and ranks as a person would notice when overflow changes', () => {
    const d = { i: 1, key: 'body/div[1]/main[1]@class', kind: 'changed', was: '!overflow-auto flex flex-1', now: '!overflow-hidden flex flex-1' }
    const f = factToFinding(d, actions, '/', baseline, 'R1')
    assert.deepEqual(f.assert, { kind: 'class_list', selector: 'xpath=/html/body/div[1]/main[1]', op: 'equals', value: '!overflow-auto flex flex-1' })
    assert.match(f.title, /^classes of div\[1\]\/main\[1\] after step 1 keeps/)
    const { findings } = selectFindings([d, { i: 1, key: 'body/div[2]@class', kind: 'changed', was: 'card a1b2c3d4e5', now: 'card f6e5d4c3b2' }], actions, '/', baseline)
    assert.equal(findings.length, 2)
    assert.equal(findings[0].notice.cls, 'visible')
    assert.equal(findings[1].notice.cls, 'churn')
  })
  it('the same class change on several elements is one finding, with the others listed on it', () => {
    const swap = (key, i = 1) => ({ i, key, kind: 'changed', was: '!overflow-auto flex pane', now: '!overflow-hidden flex pane' })
    const diffs = [swap('body/div[1]/div[1]@class'), swap('body/div[1]/div[3]@class'), swap('body/div[2]/div[1]@class', 2),
      { i: 1, key: 'body/div[3]@class', kind: 'changed', was: 'open', now: 'closed' }, // a different change: its own finding
      { i: 1, key: 'body/div[4]@class', kind: 'changed', was: 'pane !overflow-auto', now: 'pane !overflow-hidden' }] // the same change, classes in another order
    const { findings, skipped } = selectFindings(diffs, actions, '/', baseline)
    assert.deepEqual(findings.map(f => [f.id, f.fact.key]), [['R1', 'body/div[1]/div[1]@class'], ['R2', 'body/div[3]@class']])
    assert.deepEqual(findings[0].alike, ['body/div[1]/div[3]@class', 'body/div[2]/div[1]@class', 'body/div[4]@class'])
    assert.deepEqual(findings[1].alike, [])
    assert.deepEqual(skipped.map(k => [k.key, k.why]), [['body/div[1]/div[3]@class', 'the same class change as R1'], ['body/div[2]/div[1]@class', 'the same class change as R1'], ['body/div[4]@class', 'the same class change as R1']])
    const lost = selectFindings([swap('body/div[1]/div[1]@class'), { i: 1, key: 'body/div[9]@class', kind: 'removed', was: '!overflow-auto flex pane', now: null }], actions, '/', baseline)
    assert.equal(lost.findings.length, 2, 'a vanished class list is not the same change as a swapped one')
  })
  it('selectFindings and vanishedRoots take #scrolls keys', () => {
    const diffs = [{ i: 1, key: 'body/div[1]/main[1]#scrolls', kind: 'removed', was: 'y', now: null }, { i: 1, key: 'body/div[1]/main[1]/p[1]#text', kind: 'removed', was: 'hello', now: null }]
    const roots = vanishedRoots(diffs)
    assert.deepEqual(roots.map(r => [r.key, r.vanished]), [['body/div[1]/main[1]/p[1]#text', 1], ['body/div[1]/main[1]#scrolls', 1]]) // the area is still there: its lost scrolling does not swallow the text that vanished inside it
    assert.deepEqual(vanishedRoots([{ i: 1, key: 'body/aside[1]#text', kind: 'removed', was: 'Menu', now: null }, { i: 1, key: 'body/aside[1]/div[1]#scrolls', kind: 'removed', was: 'y', now: null }]).map(r => r.key), ['body/aside[1]#text']) // under a vanished root, the area went with it
    const { findings } = selectFindings(diffs, actions, '/', baseline)
    assert.deepEqual(findings.map(f => f.assert.kind), ['scrolls', 'own_text'])
    assert.equal(findings[0].notice.why, 'whether an area can scroll')
  })
})
