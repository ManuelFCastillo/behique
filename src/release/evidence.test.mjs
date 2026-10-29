// node --test src/release/evidence.test.mjs
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCase, summarize } from './evidence.mjs'

const fresh = () => openCase(mkdtempSync(join(tmpdir(), 'evidence-')))

test('who may write which claim is enforced', () => {
  const c = fresh(), h = c.artifact('a.txt', 'x')
  assert.throws(() => c.claim('verified_fact', 'x', { by: 'model', model: 'm', evidence: [h] }), /model may not write a verified_fact/)
  assert.throws(() => c.claim('reproduced_failure', 'x', { by: 'human', evidence: [h] }), /human may not write/)
  assert.throws(() => c.claim('ai_hypothesis', 'x', { by: 'code' }), /code may not write a ai_hypothesis/)
  assert.throws(() => c.claim('ai_hypothesis', 'x', { by: 'model' }), /must name the model/)
  assert.throws(() => c.claim('made_up', 'x'), /unknown claim label/)
  c.claim('verified_fact', 'ok', { by: 'code', evidence: [h] })
  c.claim('suspected_cause', 'ok', { by: 'human', evidence: [h] })
  c.claim('ai_hypothesis', 'a guess', { by: 'model', model: 'm' })
})

test('claims must cite evidence that exists', () => {
  const c = fresh()
  assert.throws(() => c.claim('verified_fact', 'x', {}), /must cite evidence/)
  assert.throws(() => c.claim('verified_fact', 'x', { evidence: ['f'.repeat(64)] }), /evidence not found/)
  assert.throws(() => c.claim('verified_fact', 'x', { evidence: ['event:99'] }), /evidence not found/)
  const seq = c.event('note', {})
  c.claim('verified_fact', 'x', { evidence: [`event:${seq}`] })
})

test('only ship or hold, and the newest decision counts without erasing the old one', () => {
  const c = fresh()
  assert.throws(() => c.decide('maybe'), /decision must be/)
  c.decide('hold', { who: 'a', note: 'first' }); c.decide('ship', { who: 'a', note: 'second' })
  const s = summarize(c.read())
  assert.equal(s.decisions.length, 2); assert.equal(s.decision.decision, 'ship')
})

test('editing, removing or reordering an earlier event is detected', () => {
  const c = fresh()
  c.event('a', { n: 1 }); c.event('b', { n: 2 }); c.event('c', { n: 3 })
  assert.equal(c.verify().ok, true)
  const file = join(c.dir, 'events.ndjson'), orig = readFileSync(file, 'utf8')
  writeFileSync(file, orig.replace('"n":2', '"n":9'))
  assert.equal(c.verify().ok, false)
  writeFileSync(file, orig.split('\n').filter((l, i) => i !== 1).join('\n'))
  assert.equal(c.verify().ok, false)
  writeFileSync(file, orig)
  assert.equal(c.verify().ok, true)
})

test('a changed evidence file is detected', () => {
  const c = fresh(), h = c.artifact('log.txt', 'original')
  assert.equal(c.verify().ok, true)
  writeFileSync(c.artifactPath(h), 'tampered')
  const v = c.verify()
  assert.equal(v.ok, false); assert.match(v.problems[0], /was changed/)
})

test('appending never rewrites earlier lines', () => {
  const c = fresh(); c.event('a'); const before = readFileSync(join(c.dir, 'events.ndjson'), 'utf8')
  c.event('b'); assert.ok(readFileSync(join(c.dir, 'events.ndjson'), 'utf8').startsWith(before))
  appendFileSync(join(c.dir, 'events.ndjson'), '')
})

test('opening or verifying a case that does not exist creates nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-')), c = openCase(join(root, 'nope'))
  c.read(); c.verify()
  assert.deepEqual(readdirSync(root), [])
})

test('extra details ride along on a claim but cannot override its label or text', () => {
  const c = fresh()
  c.claim('ai_hypothesis', 'real text', { by: 'model', model: 'm', extra: { grounded: true, label: 'verified_fact', text: 'forged', evidence: ['x'] } })
  const k = summarize(c.read()).claims[0]
  assert.equal(k.label, 'ai_hypothesis'); assert.equal(k.text, 'real text'); assert.equal(k.grounded, true); assert.deepEqual(k.evidence, [])
})
