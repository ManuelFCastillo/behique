import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCase } from '../evidence.mjs'
import { aiRunArgv, aiView } from './ai-view.mjs'

const ID = '20261103T170325Z_cacb973-vs-v3.8.0'

function caseWith(stages) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-view-'))
  const c = openCase(dir)
  c.event('case.opened', { kind: 'release' })
  for (const s of stages) {
    const saved = c.artifact(`ai-${s.id}.json`, { label: 'ai_hypothesis', stage: s.id, items: s.items, notes: s.notes ?? [] }, 'application/json')
    c.event('ai.stage', { stage: s.id, label: 'ai_hypothesis', status: s.status ?? 'ran', reason: s.reason ?? null, items: s.items.length, verified: s.verified ?? 0, calls: 2, estUsd: s.estUsd ?? 0.01, evidence: [saved] })
  }
  return dir
}

test('aiView: a case with no AI stages shows none', () => {
  const dir = caseWith([])
  assert.deepEqual(aiView(dir), { label: 'ai_hypothesis', stages: [], totalUsd: 0 })
})

test('aiView: stages come back in the fixed order with plain items and a summed cost', () => {
  const dir = caseWith([
    { id: 'triage', items: [{ findingId: 'f1', rank: 1, reason: 'a button vanished' }], estUsd: 0.004 },
    { id: 'tests', items: [{ name: 'Share opens the menu', reason: 'the menu is gone', verified: true }, { name: 'x', verified: false, droppedBecause: 'passes on the candidate too' }], verified: 1, estUsd: 0.02, notes: ['one repair'] },
  ])
  const v = aiView(dir)
  assert.deepEqual(v.stages.map(s => s.id), ['tests', 'triage'])
  const t = v.stages[0]
  assert.equal(t.verified, 1)
  assert.equal(t.total, 2)
  assert.equal(t.items[0].status, 'verified')
  assert.match(t.items[0].text, /Share opens the menu/)
  assert.equal(t.items[1].status, 'not verified')
  assert.match(t.items[1].detail, /passes on the candidate too/)
  assert.deepEqual(t.notes, ['one repair'])
  assert.equal(v.totalUsd, 0.024)
})

test('aiView: an AI-written test carries its id and source, other items do not', () => {
  const dir = caseWith([
    { id: 'tests', items: [{ id: 'AI1', name: 'Share opens', verified: true, testSource: "import { test } from '@playwright/test'\ntest('x', async () => {})" }], verified: 1 },
    { id: 'triage', items: [{ findingId: 'f1', rank: 1, reason: 'r' }] },
  ])
  const [t, r] = aiView(dir).stages
  assert.equal(t.items[0].id, 'AI1')
  assert.match(t.items[0].source, /@playwright\/test/)
  assert.equal(r.items[0].source, undefined)
})

test('aiView: the newest run of a stage wins', () => {
  const dir = caseWith([{ id: 'describe', items: [{ description: 'old' }] }, { id: 'describe', items: [{ description: 'new' }, { description: 'newer' }] }])
  const v = aiView(dir)
  assert.equal(v.stages.length, 1)
  assert.equal(v.stages[0].total, 2)
})

test('aiView: a skipped stage keeps its reason and has no items', () => {
  const dir = caseWith([{ id: 'flows', status: 'skipped', reason: 'needs a sandbox', items: [], estUsd: 0 }])
  const s = aiView(dir).stages[0]
  assert.equal(s.status, 'skipped')
  assert.equal(s.reason, 'needs a sandbox')
  assert.deepEqual(s.items, [])
})

test('aiRunArgv: known stages become fixed flags and the budget is range checked', () => {
  const r = aiRunArgv({ id: ID, stages: ['tests', 'triage'], explain: true, budget: 0.5 })
  assert.deepEqual(r.argv, ['bin/behique.mjs', 'ai', ID, '--explain', '--ai-tests', '--ai-triage', '--ai-budget', '0.5'])
  assert.equal(aiRunArgv({ id: ID, stages: ['describe'] }).budget, 0.25)
})

test('aiRunArgv: nothing a page sends can become another argument', () => {
  assert.match(aiRunArgv({ id: '../x', stages: ['tests'] }).error, /report/)
  assert.match(aiRunArgv({ id: ID, stages: ['tests; rm -rf'] }).error, /Unknown/)
  assert.match(aiRunArgv({ id: ID, stages: ['--ai-budget'] }).error, /Unknown/)
  assert.match(aiRunArgv({ id: ID, stages: [] }).error, /at least one/)
  assert.match(aiRunArgv({ id: ID, stages: ['tests'], budget: 99 }).error, /between/)
  assert.match(aiRunArgv({ id: ID, stages: ['tests'], budget: 'abc' }).error, /between/)
})
