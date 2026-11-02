// Tests for the crawl planner, all offline with a hand-built fake site.
// Run with: node --test src/release/crawl/plan.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlanner } from './plan.mjs'

function cand(selector, label, key) {
  return { action: { type: 'click', selector, key }, label, key }
}

function stateFor(key, candidates = [], extra = {}) {
  return { key, url: 'http://x/' + key, title: 't-' + key, candidates, ...extra }
}

// Fake site: map from labels joined by '>' to a state.
function makeSite(map) {
  return (path) => {
    const name = path.map((a) => a.label).join('>')
    return map[name]
  }
}

test('root path first and FIFO order', () => {
  const p = createPlanner()
  const first = p.next()
  assert.deepEqual(first, [])
  p.report([], stateFor('home', [cand('#a', 'a', 'a'), cand('#b', 'b', 'b')]))
  const second = p.next()
  const third = p.next()
  assert.deepEqual(second.map((a) => a.label), ['a'])
  assert.deepEqual(third.map((a) => a.label), ['b'])
})

test('repeated state key is not new and queues nothing', () => {
  const p = createPlanner()
  p.next()
  const r1 = p.report([], stateFor('home', [cand('#a', 'a', 'a')]))
  assert.deepEqual(r1, { isNew: true, queued: 1 })
  const path = p.next()
  const r2 = p.report(path, stateFor('home', [cand('#z', 'z', 'z')]))
  assert.deepEqual(r2, { isNew: false, queued: 0 })
  assert.equal(p.stats().queued, 0)
  assert.equal(p.stats().seenAgain, 1)
})

test('maxDepth 1 stops queueing', () => {
  const p = createPlanner({ maxDepth: 1 })
  p.next()
  p.report([], stateFor('home', [cand('#a', 'a', 'a')]))
  const path = p.next()
  assert.equal(path.length, 1)
  const r = p.report(path, stateFor('other', [cand('#b', 'b', 'b')]))
  assert.deepEqual(r, { isNew: true, queued: 0 })
  assert.equal(p.next(), null)
})

test('maxDepth 2 queues two levels then stops', () => {
  const p = createPlanner({ maxDepth: 2 })
  p.next()
  p.report([], stateFor('home', [cand('#a', 'a', 'a')]))
  const l1 = p.next()
  p.report(l1, stateFor('s1', [cand('#b', 'b', 'b')]))
  const l2 = p.next()
  assert.equal(l2.length, 2)
  const r = p.report(l2, stateFor('s2', [cand('#c', 'c', 'c')]))
  assert.equal(r.queued, 0)
})

test('maxPaths honoured across whole run', () => {
  const p = createPlanner({ maxDepth: 3, maxPaths: 3 })
  p.next()
  const r = p.report([], stateFor('home', [cand('#a', 'a', 'a'), cand('#b', 'b', 'b'), cand('#c', 'c', 'c'), cand('#d', 'd', 'd')]))
  assert.equal(r.queued, 2)
  assert.equal(p.stats().queued, 2)
  const a = p.next()
  p.report(a, stateFor('s1', [cand('#z', 'z', 'z')]))
  assert.equal(p.stats().queued, 1)
})

test('maxPerPage limits candidates per page', () => {
  const p = createPlanner({ maxPerPage: 2 })
  p.next()
  const r = p.report([], stateFor('home', [cand('#a', 'a', 'a'), cand('#b', 'b', 'b'), cand('#c', 'c', 'c')]))
  assert.equal(r.queued, 2)
})

test('candidate already clicked in path is skipped', () => {
  const p = createPlanner({ maxDepth: 3 })
  p.next()
  p.report([], stateFor('home', [cand('#a', 'a', 'ka')]))
  const l1 = p.next()
  const r = p.report(l1, stateFor('s1', [cand('#a', 'a', 'ka'), cand('#b', 'b', 'kb')]))
  assert.equal(r.queued, 1)
  const l2 = p.next()
  assert.deepEqual(l2.map((a) => a.label), ['a', 'b'])
})

test('failed and stats', () => {
  const p = createPlanner()
  assert.deepEqual(p.stats(), { tried: 0, states: 0, seenAgain: 0, failed: 0, queued: 1 })
  p.next()
  p.failed([])
  p.report([], stateFor('home', []))
  assert.deepEqual(p.stats(), { tried: 1, states: 1, seenAgain: 0, failed: 1, queued: 0 })
})

test('states order', () => {
  const p = createPlanner()
  p.next()
  p.report([], stateFor('home', [cand('#a', 'a', 'a')]))
  const l1 = p.next()
  p.report(l1, stateFor('s1', []))
  const list = p.states()
  assert.deepEqual(list.map((s) => s.key), ['home', 's1'])
  assert.deepEqual(list.map((s) => s.order), [0, 1])
  assert.equal(list[1].path, l1)
})

test('flows shallow first, one per last-action key, max, start excluded', () => {
  const p = createPlanner({ maxDepth: 3 })
  p.next()
  p.report([], stateFor('home', [cand('#a', 'a', 'ka'), cand('#b', 'b', 'kb')]))
  const l1 = p.next()
  p.report(l1, stateFor('s-a', [cand('#c', 'c', 'kc')]))
  const l2 = p.next()
  p.report(l2, stateFor('s-b', [cand('#c', 'c', 'kc')]))
  const l3 = p.next()
  // Same last selector as l1 but deeper, should be deduped.
  p.report(l3, stateFor('s-a2', []))
  const everything = p.flows({ max: 8 })
  const all = everything.filter(f => !f.direct)
  const keys = all.map((f) => f.state.key)
  assert.ok(!keys.includes('home'))
  // Shallow first: length-1 states before length-2.
  const lens = all.map((f) => f.path.length)
  assert.deepEqual([...lens].sort((a, b) => a - b), lens)
  // One per last-action key: kc reachable twice counts once.
  const lastKeys = all.map((f) => f.path[f.path.length - 1].selector)
  assert.equal(new Set(lastKeys).size, lastKeys.length)
  const limited = p.flows({ max: 1, direct: 0 })
  assert.equal(limited.length, 1)
  assert.equal(limited[0].path.length, 1)
})

test('every page the clicks reached is also loaded directly, once, after the click flows', () => {
  const p = createPlanner({ maxDepth: 3 })
  p.next()
  p.report([], stateFor('home', [cand('#a', 'a', 'ka'), cand('#b', 'b', 'kb')]))
  p.report(p.next(), { ...stateFor('s-a', [cand('#c', 'c', 'kc')]), url: 'http://x/guide/start?tab=1#top' })
  p.report(p.next(), { ...stateFor('s-b', []), url: 'http://x/' }) // a click that stays on the start page: nothing to load directly
  p.report(p.next(), { ...stateFor('s-c', []), url: 'http://x/guide/start?tab=1' }) // the same page again: loaded once
  const flows = p.flows({ max: 8 })
  const direct = flows.filter(f => f.direct)
  assert.deepEqual(direct.map(f => f.path), [[{ type: 'goto', path: '/guide/start?tab=1', label: 'load /guide/start?tab=1 directly' }]])
  assert.ok(flows.indexOf(direct[0]) > flows.findLastIndex(f => !f.direct), 'direct loads come after the click flows')
  assert.equal(p.flows({ max: 8, direct: 0 }).filter(f => f.direct).length, 0)
  // A direct load is its own fresh start: no goto to the start page in front of it, and two different loads may follow each other.
  const steps = p.toSteps([flows[0], direct[0], { path: [{ type: 'goto', path: '/other', label: 'load /other directly' }], state: {}, direct: true }])
  assert.deepEqual(steps.slice(1), [{ type: 'goto', path: '/guide/start?tab=1', label: 'load /guide/start?tab=1 directly' }, { type: 'goto', path: '/other', label: 'load /other directly' }])
})

test('toSteps first flow no goto, later flows do, labels kept, no mutation, empty', () => {
  const p = createPlanner()
  const flows = [
    { path: [{ type: 'click', selector: '#a', label: 'A' }], state: {} },
    { path: [{ type: 'click', selector: '#b', label: 'B' }], state: {} },
  ]
  const before = JSON.stringify(flows)
  const steps = p.toSteps(flows)
  assert.deepEqual(steps, [
    { type: 'click', selector: '#a', label: 'A' },
    { type: 'goto', path: '/' },
    { type: 'click', selector: '#b', label: 'B' },
  ])
  assert.equal(JSON.stringify(flows), before)
  assert.deepEqual(p.toSteps([]), [])
  assert.deepEqual(p.toSteps(flows, { startPath: '/start' })[1], { type: 'goto', path: '/start' })
  // No double goto with empty middle flow.
  const withEmpty = [
    { path: [{ type: 'click', selector: '#a', label: 'A' }], state: {} },
    { path: [], state: {} },
    { path: [{ type: 'click', selector: '#c', label: 'C' }], state: {} },
  ]
  const s2 = p.toSteps(withEmpty)
  for (let i = 1; i < s2.length; i++) {
    assert.ok(!(s2[i].type === 'goto' && s2[i - 1].type === 'goto'), 'no double goto')
  }
})

test('state with no key is ignored', () => {
  const p = createPlanner()
  p.next()
  assert.deepEqual(p.report([], { url: 'u', title: 't', candidates: [] }), { isNew: false, queued: 0 })
  assert.deepEqual(p.report([], { key: 42, candidates: [] }), { isNew: false, queued: 0 })
  assert.equal(p.stats().states, 0)
})

test('next never returns same path twice', () => {
  const p = createPlanner()
  const seenPaths = new Set()
  p.report([], stateFor('home', [cand('#a', 'a', 'a'), cand('#b', 'b', 'b')]))
  // Drain, reporting fresh states so more paths queue.
  let guard = 0
  let n = 0
  for (;;) {
    const path = p.next()
    if (path === null || guard++ > 60) break
    n += 1
    const id = JSON.stringify(path)
    assert.ok(!seenPaths.has(id))
    seenPaths.add(id)
  }
  assert.ok(n >= 3)
})

test('full run on fake site finishes and stats add up', () => {
  const site = {
    '': stateFor('home', [cand('#a', 'a', 'ka'), cand('#b', 'b', 'kb')]),
    a: stateFor('pa', [cand('#c', 'c', 'kc')]),
    b: stateFor('pb', [cand('#c', 'c', 'kc')]),
    'a>c': stateFor('pa', []),
    'b>c': stateFor('pa', []),
  }
  const p = createPlanner({ maxDepth: 2, maxPaths: 40 })
  const lookup = makeSite(site)
  let guard = 0
  for (;;) {
    const path = p.next()
    if (path === null || guard++ > 100) break
    const st = lookup(path)
    if (!st) {
      p.failed(path)
      continue
    }
    p.report(path, st)
  }
  const s = p.stats()
  assert.equal(s.queued, 0)
  assert.equal(s.states, 3)
  assert.equal(s.tried, 1 + 2 + 2)
  assert.equal(s.seenAgain, s.tried - s.states - s.failed)
})
