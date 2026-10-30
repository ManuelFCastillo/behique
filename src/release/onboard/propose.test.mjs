// Tests for propose: messages, parsing, fake ask, cost, and the skill file.
//   node --test src/release/onboard/propose.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMessages, parseProfile, proposeProfile, projectCost } from './propose.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = join(HERE, '..', '..', '..', 'docs', 'skills', 'onboard-app.md')

function goodProfile() {
  return {
    name: 'demo',
    repo: '/tmp/demo',
    workRoot: '/tmp/work',
    defaults: { good: 'v1', cand: 'v2' },
    serve: { kind: 'static' }
  }
}

test('buildMessages puts skill first and facts and versions in user message', () => {
  const facts = { path: '/tmp/demo' }
  const msgs = buildMessages(facts, 'SKILLTEXT', { good: 'v1', cand: 'v2' })
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[0].content, 'SKILLTEXT')
  assert.equal(msgs[1].role, 'user')
  assert.ok(msgs[1].content.includes('v1'))
  assert.ok(msgs[1].content.includes('v2'))
  assert.ok(msgs[1].content.includes(JSON.stringify(facts, null, 2)))
  assert.ok(/single JSON object/i.test(msgs[1].content))
})

test('parseProfile accepts clean, fenced, and surrounded JSON', () => {
  const p = goodProfile()
  const clean = JSON.stringify(p)
  assert.deepEqual(parseProfile(clean).problems, [])
  const fenced = '```json\n' + clean + '\n```'
  const r2 = parseProfile(fenced)
  assert.deepEqual(r2.problems, [])
  assert.equal(r2.profile.name, 'demo')
  const around = 'here is your object:\n' + clean + '\nbye'
  assert.deepEqual(parseProfile(around).problems, [])
})

test('parseProfile reports invalid JSON, disallowed executable, missing field', () => {
  const bad = parseProfile('no json here')
  assert.equal(bad.profile, null)
  assert.ok(bad.problems.length > 0)
  const broken = parseProfile('{ not valid json')
  assert.equal(broken.profile, null)
  assert.ok(broken.problems.length > 0)
  const evil = goodProfile()
  evil.serve = { kind: 'command', cmd: 'curl', args: [] }
  const r = parseProfile(JSON.stringify(evil))
  assert.ok(r.problems.length > 0)
  const missing = { repo: '/tmp/demo', workRoot: '/tmp/work', serve: { kind: 'static' } }
  const r2 = parseProfile(JSON.stringify(missing))
  assert.ok(r2.problems.length > 0)
})

test('proposeProfile with fake ask returns profile and usage, fills defaults', async () => {
  const p = goodProfile()
  delete p.defaults
  let seen = null
  async function ask(messages) {
    seen = messages
    return { text: JSON.stringify(p), pt: 10, ct: 20 }
  }
  const facts = { path: '/tmp/demo' }
  const out = await proposeProfile({ facts, skillText: 'SKILL', ask, good: 'g1', cand: 'c1' })
  assert.ok(seen !== null)
  assert.equal(out.usage.pt, 10)
  assert.equal(out.usage.ct, 20)
  assert.deepEqual(out.profile.defaults, { good: 'g1', cand: 'c1' })
  assert.deepEqual(out.problems, [])
  assert.ok(typeof out.raw === 'string')
  assert.ok(Array.isArray(out.messages))
})

test('projectCost grows with the prompt', () => {
  const a = [{ role: 'user', content: 'hi' }]
  const b = [{ role: 'user', content: 'hi'.repeat(10000) }]
  assert.ok(projectCost(b) > projectCost(a))
})

test('skill file exists and follows the rules', () => {
  const st = statSync(SKILL)
  assert.ok(st.isFile())
  const text = readFileSync(SKILL, 'utf8')
  const lines = text.split('\n')
  assert.ok(lines.length < 130, `skill has ${lines.length} lines`)
  assert.ok(!text.includes('\u2014'))
  for (const f of ['name', 'repo', 'workRoot', 'defaults', 'serve', 'ready', 'viewport', 'setup', 'regions', 'anchors', 'notes']) {
    assert.ok(text.includes(f), `missing ${f}`)
  }
  const low = text.toLowerCase()
  assert.ok(!low.includes('musicblocks'))
  assert.ok(!low.includes('mb_env'))
  assert.ok(!text.includes('/env.js'))
})
