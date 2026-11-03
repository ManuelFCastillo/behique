// node --test src/release/cli/explain.test.mjs   (offline: the model is never called)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCase } from '../evidence.mjs'
import { explainCase } from './explain.mjs'

const closedCase = () => {
  const c = openCase(mkdtempSync(join(tmpdir(), 'explain-')))
  c.event('case.opened', { goodRef: 'v1', candRef: 'v2', adapter: 'x', app: 'x', steps: [], scenario: null })
  c.event('case.closed', { outcome: 'regression proven' })
  return c
}
const preview = (extra = {}) => async () => ({
  keyPresent: true, limit: 3, ctx: { symptoms: ['s'], diff: 'd', truncated: false },
  messages: [{ role: 'user', content: 'hello' }],
  est: { model: 'muse-spark-1.3', expectedUsd: 0.006, worstUsd: 0.02 }, ...extra,
})

test('one guarded call: the preview is confirmed by its own fingerprint, the cost is logged, and the answer comes back', async () => {
  const logs = [], calls = []
  const r = await explainCase(closedCase(), { previewFn: preview(), ask: async (c, provider) => { calls.push(provider); return { usd: 0.0061, grounded: true, seq: 9 } }, log: l => logs.push(l) })
  assert.deepEqual(r, { ok: true, usd: 0.0061, grounded: true })
  assert.deepEqual(calls, ['meta'], 'exactly one call, to the standard Meta model')
  assert.match(logs[0], /muse-spark-1\.3.*\$0\.0060.*\$0\.0200/)
  assert.match(logs[1], /\$0\.0061.*found/)
})

test('nothing is spent and nothing throws when the key is missing, the model fails, or the case is not finished', async () => {
  let called = 0
  const ask = async () => { called++; return { usd: 0, grounded: true } }
  const noKey = await explainCase(closedCase(), { previewFn: preview({ keyPresent: false }), ask })
  assert.equal(noKey.ok, false); assert.match(noKey.reason, /No API key is set for meta/)
  const noCulprit = await explainCase(closedCase(), { previewFn: async () => { throw new Error('this case has no first bad change to look at: run the check with the search step first') }, ask })
  assert.equal(noCulprit.ok, false); assert.match(noCulprit.reason, /no first bad change/)
  const boom = await explainCase(closedCase(), { previewFn: preview(), ask: async () => { throw new Error('HTTP 429: slow down') } })
  assert.equal(boom.ok, false); assert.match(boom.reason, /429/)
  const running = openCase(mkdtempSync(join(tmpdir(), 'explain-run-')))
  running.event('case.opened', { goodRef: 'v1', candRef: 'v2', adapter: 'x', app: 'x', steps: [], scenario: null })
  const notDone = await explainCase(running, { previewFn: preview(), ask })
  assert.equal(notDone.ok, false); assert.match(notDone.reason, /has not finished/)
  assert.equal(called, 0, 'no refusal reached the model')
})

test('a case that already has the limit of AI guesses is refused before any call', async () => {
  const c = closedCase()
  for (let i = 0; i < 3; i++) c.claim('ai_hypothesis', 'guess ' + i, { by: 'model', model: 'm' })
  let called = 0
  const r = await explainCase(c, { previewFn: preview(), ask: async () => { called++; return { usd: 0, grounded: true } } })
  assert.equal(r.ok, false); assert.match(r.reason, /already has 3 AI guesses/); assert.equal(called, 0)
})
