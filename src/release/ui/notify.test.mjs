import test from 'node:test'
import assert from 'node:assert/strict'
import { push, runMessage, topicOf } from './notify.mjs'

const run = { status: 'finished', app: 'jellyfin', goodRef: 'v1', candRef: 'v2', startedAt: '2026-11-04T10:00:00Z' }
const at = Date.parse('2026-11-04T10:23:00Z')

test('topicOf reads the file and refuses anything that is not a topic', () => {
  assert.equal(topicOf('# alerts\nTOPIC=abc-123_x\n'), 'abc-123_x')
  assert.equal(topicOf('TOPIC="abc"'), 'abc')
  assert.equal(topicOf('NTFY_TOPIC=abc'), 'abc')
  assert.equal(topicOf('TOPIC=../../evil'), null)
  assert.equal(topicOf(''), null)
})

test('the message says the verdict, what ran and how long', () => {
  const m = runMessage(run, { verdict: 'hold', sub: '5 reproduced behaviour changes' }, at)
  assert.equal(m.title, 'Behique: HOLD'); assert.equal(m.priority, 'high')
  assert.equal(m.body, 'jellyfin v1 vs v2, 23 min. 5 reproduced behaviour changes')
  assert.equal(runMessage(run, { verdict: 'ship', sub: 'No changes' }, at).title, 'Behique: SHIP')
  assert.equal(runMessage(run, { verdict: 'inconclusive', sub: 'x' }, at).title, 'Behique: REVIEW')
  assert.equal(runMessage(run, { verdict: 'fail', sub: 'x' }, at).title, 'Behique: INCOMPLETE')
})

test('a crash and a cancel are told apart, and a finished run with no report is a failure', () => {
  assert.equal(runMessage({ ...run, status: 'failed' }, null, at).title, 'Behique: run failed')
  assert.equal(runMessage({ ...run, status: 'cancelled' }, null, at).title, 'Behique: cancelled')
  assert.equal(runMessage(run, null, at).title, 'Behique: run failed')
})

test('push sends to the topic, without the topic in the body or title', async () => {
  const sent = []
  const ok = await push({ title: 'T', body: 'B' }, { read: () => 'TOPIC=secret1', fetchFn: async (url, o) => { sent.push({ url, o }); return { ok: true } } })
  assert.equal(ok, true); assert.equal(sent[0].url, 'https://ntfy.sh/secret1'); assert.equal(sent[0].o.body, 'B'); assert.equal(sent[0].o.headers.Title, 'T')
})

test('push with no file, a bad file or a failed send returns false and never throws', async () => {
  const no = async () => { throw new Error('must not send') }
  assert.equal(await push({ title: 'T', body: 'B' }, { read: () => { throw new Error('ENOENT') }, fetchFn: no }), false)
  assert.equal(await push({ title: 'T', body: 'B' }, { read: () => 'nothing', fetchFn: no }), false)
  assert.equal(await push({ title: 'T', body: 'B' }, { read: () => 'TOPIC=a', fetchFn: async () => { throw new Error('offline') } }), false)
})
