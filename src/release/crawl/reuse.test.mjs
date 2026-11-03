import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { crawlFileStem, crawlMatches, optionsFromArgs, pickCrawl, reuseNote, startPathOf, withStart } from './reuse.mjs'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

function baseRecord(over = {}) {
  return {
    app: 'my-app',
    ref: 'v1',
    sha: SHA,
    options: { maxDepth: 2, maxPaths: 40, maxFlows: 20, budgetMs: 120000 },
    stoppedBy: 'paths',
    ms: 1000,
    stats: { tried: 10, failed: 1 },
    states: [{ url: 'http://x/', title: 't', path: [] }],
    flows: [['a']],
    steps: [{ type: 'goto', path: '/' }, { type: 'click', path: '/' }],
    savedAt: '2026-10-31T10:00:00.000Z',
    ...over
  }
}

function baseWant(over = {}) {
  return {
    app: 'my-app',
    sha: SHA,
    options: { maxDepth: 2, maxPaths: 40, maxFlows: 20, budgetMs: 120000 },
    ...over
  }
}

describe('crawlMatches', () => {
  it('matches when app, sha and options agree with steps', () => {
    assert.deepEqual(crawlMatches(baseRecord(), baseWant()), { ok: true })
  })

  it('a 12-character sha in the want matches by prefix', () => {
    const want = baseWant({ sha: SHA.slice(0, 12) })
    assert.deepEqual(crawlMatches(baseRecord(), want), { ok: true })
  })

  it('different app', () => {
    const r = crawlMatches(baseRecord({ app: 'other' }), baseWant())
    assert.deepEqual(r, { ok: false, why: 'different app' })
  })

  it('different commit', () => {
    const r = crawlMatches(baseRecord(), baseWant({ sha: SHA2 }))
    assert.deepEqual(r, { ok: false, why: 'different commit' })
  })

  it('a differing option names the key', () => {
    const r = crawlMatches(baseRecord(), baseWant({ options: { maxDepth: 2, maxPaths: 9, maxFlows: 20, budgetMs: 120000 } }))
    assert.deepEqual(r, { ok: false, why: 'different crawl options (maxPaths)' })
  })

  it('an extra key in the record with a different value mismatches', () => {
    const rec = baseRecord({ options: { maxDepth: 2, maxPaths: 40, maxFlows: 20, budgetMs: 120000, extra: true } })
    const r = crawlMatches(rec, baseWant())
    assert.deepEqual(r, { ok: false, why: 'different crawl options (extra)' })
  })

  it('names the first differing key in sorted order', () => {
    const rec = baseRecord({ options: { maxDepth: 2, maxPaths: 40, maxFlows: 20, budgetMs: 1 } })
    const want = baseWant({ options: { maxDepth: 9, maxPaths: 9, maxFlows: 20, budgetMs: 120000 } })
    const r = crawlMatches(rec, want)
    assert.deepEqual(r, { ok: false, why: 'different crawl options (budgetMs)' })
  })

  it('no steps', () => {
    const r = crawlMatches(baseRecord({ steps: [] }), baseWant())
    assert.deepEqual(r, { ok: false, why: 'the saved crawl has no steps' })
  })

  it('missing or junk fields never throw and do not match', () => {
    assert.doesNotThrow(() => crawlMatches(null, baseWant()))
    assert.equal(crawlMatches(null, baseWant()).ok, false)
    assert.equal(crawlMatches(baseRecord(), null).ok, false)
    assert.equal(crawlMatches({ app: 'my-app', sha: SHA }, baseWant()).ok, false)
    assert.equal(crawlMatches(baseRecord({ steps: 'nope' }), baseWant()).ok, false)
    assert.equal(crawlMatches(baseRecord({ steps: null }), baseWant()).ok, false)
    assert.equal(crawlMatches(baseRecord({ options: null }), baseWant()).ok, false)
    assert.equal(crawlMatches('junk', 42).ok, false)
    assert.equal(crawlMatches(undefined, undefined).ok, false)
  })
})

describe('pickCrawl', () => {
  it('picks the most steps', () => {
    const a = baseRecord({ steps: [{ type: 'goto', path: '/' }] })
    const b = baseRecord({ steps: [{ type: 'goto', path: '/' }, { type: 'goto', path: '/x' }, { type: 'goto', path: '/y' }] })
    const got = pickCrawl([a, b], baseWant())
    assert.equal(got.index, 1)
    assert.equal(got.record, b)
  })

  it('ties go to the later index', () => {
    const a = baseRecord({ steps: [{ type: 'goto', path: '/' }] })
    const b = baseRecord({ steps: [{ type: 'goto', path: '/' }] })
    const got = pickCrawl([a, b], baseWant())
    assert.equal(got.index, 1)
  })

  it('null when none matches', () => {
    assert.equal(pickCrawl([baseRecord({ app: 'other' })], baseWant()), null)
    assert.equal(pickCrawl([], baseWant()), null)
    assert.equal(pickCrawl(null, baseWant()), null)
    assert.equal(pickCrawl('junk', baseWant()), null)
  })

  it('never throws on junk records', () => {
    assert.doesNotThrow(() => pickCrawl([null, undefined, 42, { nope: true }], baseWant()))
    assert.equal(pickCrawl([null, undefined], baseWant()), null)
  })
})

describe('reuseNote', () => {
  const rec = () => baseRecord()

  it('renders minutes', () => {
    const now = Date.parse('2026-10-31T10:05:00.000Z')
    assert.equal(
      reuseNote(rec(), { now }),
      `reusing the crawl of my-app ${SHA.slice(0, 12)} from 5m ago (2 steps, 1 page states); pass --recrawl to crawl again`
    )
  })

  it('renders hours', () => {
    const now = Date.parse('2026-10-31T13:00:00.000Z')
    assert.ok(reuseNote(rec(), { now }).includes('from 3h ago'))
  })

  it('renders days', () => {
    const now = Date.parse('2026-11-03T10:00:00.000Z')
    assert.ok(reuseNote(rec(), { now }).includes('from 3d ago'))
  })

  it('falls back without savedAt', () => {
    const { savedAt, ...rest } = rec()
    void savedAt
    assert.ok(reuseNote(rest).includes('from an earlier run'))
    assert.ok(reuseNote({}).includes('from an earlier run'))
  })
})

describe('crawlFileStem and optionsFromArgs', () => {
  it('stem is valid for good parts and null otherwise', () => {
    assert.equal(crawlFileStem('my-app', SHA), `my-app-${SHA.slice(0, 12)}`)
    assert.equal(crawlFileStem('Bad_App', SHA), null)
    assert.equal(crawlFileStem('my-app', 'xyz'), null)
    assert.equal(crawlFileStem('my-app', 'ABCDEF123456'), null)
    assert.equal(crawlFileStem('', SHA), null)
    assert.equal(crawlFileStem(null, SHA), null)
  })

  it('round-trips a command line', () => {
    const argv = ['node', 'cli.mjs', 'my-app', 'v1', '--max-depth', '3', '--max-paths', '10', '--max-flows', '5', '--budget', '60', '--unknown', 'x']
    const opts = optionsFromArgs(argv)
    assert.deepEqual(opts, { maxDepth: 3, maxPaths: 10, maxFlows: 5, budgetMs: 60000 })
    const stem = crawlFileStem('my-app', SHA)
    assert.equal(stem, `my-app-${SHA.slice(0, 12)}`)
    const rec = baseRecord({ app: 'my-app', options: opts })
    const want = { app: 'my-app', sha: SHA, options: optionsFromArgs(argv) }
    assert.deepEqual(crawlMatches(rec, want), { ok: true })
  })

  it('returns {} for none and ignores unknown flags', () => {
    assert.deepEqual(optionsFromArgs(['node', 'cli.mjs']), {})
    assert.deepEqual(optionsFromArgs(['node', 'cli.mjs', '--verbose']), {})
    assert.deepEqual(optionsFromArgs([]), {})
  })
})

describe('startPathOf and withStart', () => {
  it('starts at the profile ready path only when it is off the root, and writes it into the options only then', () => {
    assert.equal(startPathOf({ adapter: { profile: { ready: { path: '/docs' } } } }), '/docs')
    assert.equal(startPathOf({ adapter: { profile: { ready: { path: '/sub/' } } } }), '/sub/')
    assert.equal(startPathOf({ adapter: { profile: { ready: { path: '/' } } } }), '/')
    assert.equal(startPathOf({ adapter: {} }), '/')
    assert.equal(startPathOf(null), '/')
    assert.equal(startPathOf({ adapter: { profile: { ready: { path: 'docs' } } } }), '/')
    assert.equal(startPathOf({ adapter: { profile: { ready: { path: '/a b' } } } }), '/')
    assert.deepEqual(withStart({ a: 1 }, '/'), { a: 1 })
    assert.deepEqual(withStart({ a: 1 }, null), { a: 1 })
    assert.deepEqual(withStart({ a: 1 }, '/sub/'), { a: 1, startPath: '/sub/' })
  })
})
