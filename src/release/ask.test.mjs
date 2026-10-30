// node --test src/release/ask.test.mjs   (offline: the model and the repository are stubbed, nothing is sent or spent)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { askModel, askPreview, whyNot } from './ask.mjs'
import { openCase } from './evidence.mjs'
import { LIMITS, buildMessages, estimate } from './hypothesis.mjs'
import { buildViewModel } from './viewmodel.mjs'

// a finished report; `culprit` says whether the search found a first bad change; `closed: false` leaves it running
function report({ culprit = true, closed = true, guesses = 0 } = {}) {
  const c = openCase(mkdtempSync(join(tmpdir(), 'ask-')))
  c.event('case.opened', { goodRef: '1.0', candRef: '2.0', adapter: 'freshrss', steps: [], scenario: null })
  c.event('builds.compared', { good: { ref: '1.0', sha: 'a'.repeat(40) }, candidate: { ref: '2.0', sha: 'b'.repeat(40) } })
  const facts = c.artifact('facts-diff.json', { control: [], candidate: [] })
  c.claim('verified_fact', 'recorded', { evidence: [facts] })
  c.event('test.exported', { id: 'R1' })
  const spec = c.artifact('R1.spec.js', 'x')
  c.claim('reproduced_failure', 'fails on the new version', { evidence: [spec, ...(culprit ? [c.artifact('bisect.json', { result: { commit: 'c'.repeat(40), changes: 8, steps: 3, conclusive: true, verified: true, subject: 's', author: 'a', date: 'd', files: [] }, log: [] })] : [])] })
  for (let i = 0; i < guesses; i++) guess(c)
  if (closed) c.event('case.closed', { outcome: 'regression proven' })
  return c
}
const guess = c => c.claim('ai_hypothesis', 'a guess', { by: 'model', model: 'm', evidence: [], extra: { grounded: true, quote: 'q', confidence: 'low', howToCheck: 'h', estUsd: 0.01 } })
const events = c => readFileSync(join(c.dir, 'events.ndjson'), 'utf8')

const MESSAGES = buildMessages({ symptoms: ['the "href" attribute of the element: old was a, new is b'], diff: '+ const x = 1' })
const stubPreview = (over = {}) => async () => ({ ctx: { symptoms: ['s'], diff: 'd', truncated: false, existing: 0 }, messages: MESSAGES, est: estimate(MESSAGES, 'meta'), keyPresent: true, limit: 3, ...over })
let calls = 0
const stubAsk = async c => { calls++; guess(c); return { seq: 99, usd: 0.007, grounded: true } }

test('the preview shows the exact text and a cost, and never calls the model', async () => {
  calls = 0
  const c = report(), before = events(c)
  const p = await askPreview(c, { previewFn: stubPreview() })
  assert.equal(p.ok, true); assert.equal(p.canSend, true)
  assert.deepEqual(p.sent, MESSAGES, 'the page shows the same messages the model would receive')
  assert.ok(p.est.expectedUsd > 0 && p.est.worstUsd >= p.est.expectedUsd && p.est.maxOutTokens === LIMITS.maxTokens)
  assert.equal(p.guesses, 0); assert.equal(p.limit, 3); assert.match(p.confirm, /^[0-9a-f]{16}$/)
  assert.equal(events(c), before, 'looking writes nothing'); assert.equal(calls, 0)
})

test('nothing is sent without the fingerprint of the text that was shown', async () => {
  calls = 0
  const c = report(), before = events(c), previewFn = stubPreview()
  for (const confirm of [undefined, '', 'nope', 42, null]) {
    const r = await askModel(c, { confirm, ask: stubAsk, previewFn })
    assert.deepEqual({ ok: r.ok, status: r.status, stale: r.stale }, { ok: false, status: 409, stale: true })
  }
  assert.equal(calls, 0); assert.equal(events(c), before)
  const { confirm } = await askPreview(c, { previewFn })
  const r = await askModel(c, { confirm, ask: stubAsk, previewFn })
  assert.equal(r.ok, true); assert.equal(calls, 1)
})

test('a changed prompt invalidates the earlier confirmation', async () => {
  calls = 0
  const c = report()
  const { confirm } = await askPreview(c, { previewFn: stubPreview() })
  const other = [MESSAGES[0], { ...MESSAGES[1], content: MESSAGES[1].content + ' (a different diff)' }]
  const r = await askModel(c, { confirm, ask: stubAsk, previewFn: stubPreview({ messages: other }) })
  assert.equal(r.status, 409); assert.equal(r.stale, true); assert.equal(calls, 0)
})

test('zero to three guesses: allowed until the limit, then refused with the count', async () => {
  const previewFn = stubPreview()
  for (const n of [0, 1, 2]) {
    const c = report({ guesses: n }), p = await askPreview(c, { previewFn })
    assert.equal(p.ok, true, `${n} guesses: still allowed`); assert.equal(p.guesses, n)
    assert.equal(buildViewModel(c, { caseId: 'x' }).model.canAsk, true)
  }
  calls = 0
  const full = report({ guesses: 3 }), before = events(full)
  const p = await askPreview(full, { previewFn })
  assert.equal(p.ok, false); assert.equal(p.guesses, 3); assert.match(p.reason, /3 AI guesses, the limit/)
  const r = await askModel(full, { confirm: 'anything', ask: stubAsk, previewFn })
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.equal(calls, 0); assert.equal(events(full), before)
  assert.equal(buildViewModel(full, { caseId: 'x' }).model.canAsk, false)
})

test('asking three times in a row stops at three', async () => {
  calls = 0
  const c = report(), previewFn = stubPreview()
  for (let i = 0; i < 4; i++) {
    const { ok, confirm } = await askPreview(c, { previewFn })
    if (!ok) break
    assert.equal((await askModel(c, { confirm, ask: stubAsk, previewFn })).ok, true)
  }
  assert.equal(calls, 3)
  assert.equal(buildViewModel(c, { caseId: 'x' }).model.guesses, 3)
})

test('not while the run is going, and not when there is no first bad change', async () => {
  calls = 0
  const running = report({ closed: false })
  assert.match(whyNot(running), /not finished/)
  assert.equal((await askPreview(running, { previewFn: stubPreview() })).ok, false)
  assert.equal((await askModel(running, { confirm: 'x', ask: stubAsk, previewFn: stubPreview() })).status, 400)
  assert.equal(buildViewModel(running, { caseId: 'x' }).model.canAsk, false, 'the page is told too')
  const none = report({ culprit: false }) // the real preview refuses when the search found nothing; it reads the record, not a repository
  const p = await askPreview(none)
  assert.equal(p.ok, false); assert.match(p.reason, /no first bad change/); assert.equal(calls, 0)
  assert.equal(buildViewModel(none, { caseId: 'x' }).model.canAsk, false)
})

test('without an API key it can show the cost but cannot send', async () => {
  calls = 0
  const c = report(), previewFn = stubPreview({ keyPresent: false })
  const p = await askPreview(c, { previewFn })
  assert.equal(p.ok, true); assert.equal(p.canSend, false); assert.match(p.reason, /No API key/)
  const r = await askModel(c, { confirm: p.confirm, ask: stubAsk, previewFn })
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.equal(calls, 0)
})
