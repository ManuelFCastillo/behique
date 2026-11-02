// node --test src/release/bisect.test.mjs   (offline: a throwaway git repository and a fake test, no builds)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bisect } from './bisect.mjs'

function repo(commits) {
  const dir = mkdtempSync(join(tmpdir(), 'bisect-')), g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  for (let i = 0; i <= commits; i++) { writeFileSync(join(dir, 'f.txt'), String(i)); g('add', '.'); g('commit', '-q', '-m', `commit ${i}`); if (i === 0) g('tag', 'good') }
  g('tag', 'bad')
  return { dir, shas: g('rev-list', '--reverse', 'good..bad').split('\n') }
}

test('the search reports itself as it goes: started, one event per step, verifying, with the range narrowing', async () => {
  const { dir, shas } = repo(40), culprit = 27 // 0-based index into good..bad: commits at or after it are bad
  const fake = async ({ ref }) => ({ verdict: shas.findIndex(s => s.startsWith(ref.slice(0, 7))) >= culprit ? 'bad' : 'good' })
  const events = [], lines = []
  const r = await bisect({ adapter: { repo: dir, workRoot: dir }, goodRef: 'good', badRef: 'bad', dir: 'x', test: fake, log: l => lines.push(l), onEvent: (t, d) => events.push({ t, ...d }) })
  assert.equal(r.conclusive, true); assert.equal(r.verified, true); assert.equal(r.commit, shas[culprit]); assert.equal(r.changes, 40)
  assert.deepEqual(events[0], { t: 'started', changes: 40 })
  const steps = events.filter(e => e.t === 'step')
  assert.equal(steps.length, r.steps); assert.deepEqual(steps.map(e => e.step), steps.map((_, i) => i + 1))
  for (const e of steps) assert.ok(e.goodThrough < e.badFrom && e.badFrom - e.goodThrough >= 1 && e.changes === 40 && e.sha && e.subject)
  assert.ok(steps.every((e, i) => i === 0 || (e.badFrom - e.goodThrough) <= (steps[i - 1].badFrom - steps[i - 1].goodThrough)), 'the range never widens')
  assert.equal(steps.at(-1).badFrom - steps.at(-1).goodThrough, 1, 'it ends with the range closed')
  assert.equal(events.filter(e => e.t === 'verifying').length, 1); assert.ok(events.findIndex(e => e.t === 'verifying') > events.findLastIndex(e => e.t === 'step'))
  assert.ok(lines.some(l => /BISECT CONFIRMED/.test(l)))
})

test('two versions with nothing between them are refused clearly, not with a crash', async () => {
  const { dir } = repo(3)
  await assert.rejects(bisect({ adapter: { repo: dir, workRoot: dir }, goodRef: 'bad', badRef: 'good', dir: 'x', test: async () => ({ verdict: 'good' }), log: () => {} }), /no changes between/)
})

test('classify: a failed value assertion is bad, an absent-attribute check included; anything else that fails is a skip', async () => {
  const { classify } = await import('./bisect.mjs')
  const run = (ok, msg) => ({ results: { R1: ok }, errors: msg ? { R1: msg } : {} })
  assert.deepEqual(classify(run(true), 'R1'), { verdict: 'good' })
  assert.equal(classify(run(false, 'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "a"\nReceived: "b"'), 'R1').verdict, 'bad')
  assert.equal(classify(run(false, 'Error: expect(received).toBeNull()\n\nReceived: ""'), 'R1').verdict, 'bad') // an attribute that must be absent is set
  assert.equal(classify(run(false, 'Error: expect(received).not.toBeNull()\n\nReceived: null'), 'R1').verdict, 'bad') // an attribute that must be there is gone
  assert.equal(classify(run(false, 'Error: expect(received).toContain(expected)'), 'R1').verdict, 'bad')
  assert.equal(classify(run(false, 'Error: expect(received).toBeGreaterThanOrEqual(expected)'), 'R1').verdict, 'bad')
  assert.deepEqual(classify(run(false, 'Error: Timed out 5000ms waiting for expect(locator).toBeAttached()\n\nLocator: xpath=/html/body/div[1]'), 'R1'), { verdict: 'skip', why: 'Error: Timed out 5000ms waiting for expect(locator).toBeAttached()' })
  assert.deepEqual(classify({ error: 'no output', results: {} }, 'R1'), { verdict: 'skip', why: 'runner error' })
  assert.equal(classify(run(false, ''), 'R1').why, 'test failed for another reason')
})
