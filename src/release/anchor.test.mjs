// Tests for the anchor ledger outside the case folder.
// Run with: node --test src/release/anchor.test.mjs
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { anchor, anchorText, headOf, ledgerPath, readLedger, verifyAnchors, ZERO } from './anchor.mjs'
import { openCase, sha } from './evidence.mjs'

const freshRoot = () => mkdtempSync(join(tmpdir(), 'anchor-'))
const freshCase = (root, name = 'case1') => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return openCase(dir)
}
const tickNow = (isoStrings) => {
  let i = 0
  return () => new Date(isoStrings[Math.min(i++, isoStrings.length - 1)])
}

test('headOf on an empty and a filled case', () => {
  const root = freshRoot()
  const c = freshCase(root)
  assert.deepEqual(headOf(c), { seq: 0, head: ZERO })
  c.event('a', { n: 1 })
  c.event('b', { n: 2 })
  const h = headOf(c)
  assert.equal(h.seq, 2)
  assert.equal(h.head, sha(c.rawLines().at(-1)))
})

test('anchor writes a chained line', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  c.event('b', {})
  const now = tickNow(['2026-10-31T18:04:00.000Z', '2026-10-31T18:05:00.000Z'])
  const e1 = anchor(root, 'case1', c, { now })
  assert.equal(e1.prev, ZERO)
  assert.equal(e1.seq, 2)
  assert.equal(e1.head, sha(c.rawLines().at(-1)))
  const e2 = anchor(root, 'case1', c, { now })
  assert.equal(e2.prev, sha(JSON.stringify(e1)))
  const { entries, problems } = readLedger(ledgerPath(root))
  assert.deepEqual(problems, [])
  assert.equal(entries.length, 2)
})

test('anchor refuses a bad case id and an empty case', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  assert.throws(() => anchor(root, '-bad!', c), /\/\^/)
  assert.throws(() => anchor(root, '', c), /\/\^/)
  const empty = freshCase(root, 'empty')
  assert.throws(() => anchor(root, 'ok-id', empty), /nothing to anchor/)
})

test('anchor creates the folder', () => {
  const root = freshRoot()
  const nested = join(root, 'nope', 'nested')
  const c = freshCase(root)
  c.event('a', {})
  anchor(nested, 'case1', c)
  assert.ok(existsSync(ledgerPath(nested)))
})

test('anchor writes the mirror', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  const mirror = join(root, 'mirrors', 'copy.ndjson')
  const e = anchor(root, 'case1', c, { mirror })
  assert.ok(existsSync(mirror))
  const main = readLedger(ledgerPath(root))
  const mir = readLedger(mirror)
  assert.equal(mir.entries.length, 1)
  assert.equal(mir.entries[0].seq, e.seq)
  assert.equal(mir.entries[0].head, e.head)
  assert.equal(main.entries[0].seq, mir.entries[0].seq)
  // mirror has its own prev chain: second anchor chains within each file
  c.event('b', {})
  anchor(root, 'case1', c, { mirror })
  const main2 = readLedger(ledgerPath(root))
  const mir2 = readLedger(mirror)
  assert.equal(main2.problems.length, 0)
  assert.equal(mir2.problems.length, 0)
  assert.equal(main2.entries[1].prev, sha(JSON.stringify(main2.entries[0])))
  assert.equal(mir2.entries[1].prev, sha(JSON.stringify(mir2.entries[0])))
})

test('readLedger on a missing file', () => {
  const root = freshRoot()
  assert.deepEqual(readLedger(join(root, 'missing.ndjson')), { entries: [], problems: [] })
})

test('readLedger on a good file', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  anchor(root, 'case1', c)
  anchor(root, 'case1', c)
  const { entries, problems } = readLedger(ledgerPath(root))
  assert.equal(entries.length, 2)
  assert.deepEqual(problems, [])
})

test('readLedger with a broken middle line', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  const now = tickNow(['2026-10-31T18:00:00.000Z', '2026-10-31T18:01:00.000Z', '2026-10-31T18:02:00.000Z'])
  anchor(root, 'case1', c, { now })
  anchor(root, 'case1', c, { now })
  anchor(root, 'case1', c, { now })
  const path = ledgerPath(root)
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const tampered = JSON.parse(lines[1])
  tampered.seq = 999
  lines[1] = JSON.stringify(tampered)
  writeFileSync(path, lines.join('\n') + '\n')
  const { problems } = readLedger(path)
  assert.ok(problems.some((p) => p.includes('line 2: the ledger chain is broken')))
})

test('readLedger with a non-JSON line', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  anchor(root, 'case1', c)
  appendFileSync(ledgerPath(root), 'this is not json\n')
  const { problems } = readLedger(ledgerPath(root))
  assert.ok(problems.some((p) => p.includes('line 1: not a ledger entry')))
})

test('verifyAnchors after one anchor is ok with since 0', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  c.event('b', {})
  anchor(root, 'case1', c)
  const r = verifyAnchors(root, 'case1', c)
  assert.equal(r.ok, true)
  assert.equal(r.total, 2)
  assert.equal(r.anchored, 2)
  assert.equal(r.since, 0)
})

test('verifyAnchors after one more event has since 1 and is still ok', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  anchor(root, 'case1', c)
  c.event('b', {})
  const r = verifyAnchors(root, 'case1', c)
  assert.equal(r.ok, true)
  assert.equal(r.total, 2)
  assert.equal(r.anchored, 1)
  assert.equal(r.since, 1)
})

test('verifyAnchors catches rewriting the last line', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', { n: 1 })
  c.event('b', { n: 2 })
  anchor(root, 'case1', c)
  const file = join(c.dir, 'events.ndjson')
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const last = JSON.parse(lines.at(-1))
  last.data = { n: 999 }
  lines[lines.length - 1] = JSON.stringify(last)
  writeFileSync(file, lines.join('\n') + '\n')
  const r = verifyAnchors(root, 'case1', c)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes('anchored at event 2')))
})

test('verifyAnchors catches truncating the case', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  c.event('b', {})
  c.event('c', {})
  anchor(root, 'case1', c)
  const file = join(c.dir, 'events.ndjson')
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  writeFileSync(file, lines.slice(0, 1).join('\n') + '\n')
  const r = verifyAnchors(root, 'case1', c)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes('lost events')))
})

test('verifyAnchors with a mirror that agrees', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  const mirror = join(root, 'mirror.ndjson')
  anchor(root, 'case1', c, { mirror })
  const r = verifyAnchors(root, 'case1', c, { mirror })
  assert.equal(r.ok, true)
})

test('verifyAnchors with a mirror that disagrees', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  const mirror = join(root, 'mirror.ndjson')
  anchor(root, 'case1', c, { mirror })
  c.event('b', {})
  anchor(root, 'case1', c)
  const r = verifyAnchors(root, 'case1', c, { mirror })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes('the mirror disagrees with the ledger for event 2')))
})

test('verifyAnchors with a missing mirror', () => {
  const root = freshRoot()
  const c = freshCase(root)
  c.event('a', {})
  anchor(root, 'case1', c)
  const r = verifyAnchors(root, 'case1', c, { mirror: join(root, 'gone.ndjson') })
  assert.equal(r.ok, false)
  assert.ok(r.problems.includes('the mirror file is missing'))
})

test('anchorText for each of the four shapes', () => {
  assert.equal(anchorText({ anchored: 0, total: 5, since: 5, problems: [] }), 'Not anchored: the ledger outside the case holds no entry for it.')
  assert.equal(anchorText({ anchored: 1200, total: 1200, since: 0, problems: [] }), 'Anchored: all 1,200 events are covered by the ledger outside the case.')
  assert.equal(anchorText({ anchored: 40, total: 42, since: 2, problems: [] }), 'Anchored up to event 40 of 42: the last 2 event(s) are not covered yet.')
  const failed = anchorText({ anchored: 1, total: 1, since: 0, problems: ['a problem', 'b problem'] })
  assert.ok(failed.startsWith('Anchor check FAILED: '))
  assert.ok(failed.includes('a problem; b problem'))
  assert.ok(!failed.includes('—'))
})
