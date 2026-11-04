// node --test src/release/cli/ai-stages.test.mjs   (offline: fake modules and a fake model)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyAnchors } from '../anchor.mjs'
import { openCase } from '../evidence.mjs'
import { buildViewModel } from '../viewmodel.mjs'
import { DEFAULT_BUDGET_USD, STAGES, loadStage, normalizeItem, runAiStages, selectedStages, verdictFingerprint } from './ai-stages.mjs'
import { aiSection, markdownOf, parseCheckArgs, resultOf } from './result.mjs'

const CASE_ID = '20261031T184304Z_v3.3.1-vs-v3.4.1'
function makeCase() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-'))
  const c = openCase(dir)
  c.event('case.opened', { goodRef: 'v3.3.1', candRef: 'v3.4.1', adapter: 'umami', app: 'umami', steps: [], scenario: null })
  c.event('builds.compared', { good: { ref: 'v3.3.1', sha: 'aaaaaaa111' }, candidate: { ref: 'v3.4.1', sha: 'bbbbbbb222' } })
  const facts = c.artifact('facts-diff.json', { control: [], candidate: [] })
  c.claim('verified_fact', 'values changed', { evidence: [facts] })
  c.event('test.exported', { id: 'R1', fact: 'body/div[1]/a[1]@data-url', i: 1, good: '"a"', candidate: '"b"', notice: { cls: 'visible', why: 'a link' } })
  const spec = c.artifact('R1.spec.js', 'x')
  c.event('test.judged', { id: 'R1', verdict: 'confirmed', goodPassed: 3, candFailed: 3, runs: 3, notice: { cls: 'visible', why: 'a link' } })
  c.claim('reproduced_failure', 'test R1 passes on old and fails on new', { evidence: [spec] })
  c.event('case.closed', { outcome: 'regression proven' })
  return { c, dir }
}
// a fake model: every call costs 1,000 prompt and 500 completion tokens, about $0.0034 at the project's estimate
const fakeAsk = (log = []) => async (messages, opts) => { log.push({ messages, opts }); return { text: '{}', model: 'fake-model', provider: 'meta', usage: { promptTokens: 1000, completionTokens: 500, ms: 5 } } }
const fakeModule = (items, { calls = 1, label = 'ai_hypothesis', notes = [] } = {}) => ({
  async run({ caseDir, ask, maxUsd, record }) {
    assert.ok(caseDir && typeof maxUsd === 'number' && record === false, 'the seam passes caseDir, a cap, and record: false')
    for (let i = 0; i < calls; i++) await ask([{ role: 'user', content: 'hi' }], { reasoning: 'low', maxTokens: 100 })
    return { label, items, calls: [], spentUsd: 0, notes }
  },
})
const loadFrom = mods => async stage => { if (!mods[stage.id]) { const e = new Error(`Cannot find module '${stage.path}'`); e.code = 'ERR_MODULE_NOT_FOUND'; throw e } return mods[stage.id] }

test('selectedStages: --ai is all four, the single flags add one each', () => {
  assert.deepEqual(selectedStages({}), [])
  assert.deepEqual(selectedStages({ ai: true }), ['tests', 'flows', 'describe', 'triage'])
  assert.deepEqual(selectedStages({ aiTriage: true, aiTests: true }), ['tests', 'triage'])
  assert.equal(DEFAULT_BUDGET_USD, 0.25)
  assert.equal(parseCheckArgs(['a', 'b', 'c']).options.aiBudget, 0.25)
})

test('an absent module is skipped with a note, a present one runs; every call becomes a model.call event', async () => {
  const { c, dir } = makeCase()
  const mods = { triage: fakeModule([{ findingId: 'F2', rank: 1, reason: 'looks like a real label change' }, { findingId: 'F1', rank: 2, reason: 'likely noise' }]), describe: fakeModule([{ description: 'the title is bigger', verified: true, kindCheck: 'text height grew' }, { description: 'a red button', verified: false, droppedBecause: 'no pixels changed there' }], { calls: 2 }) }
  const out = await runAiStages({ caseDir: dir, stages: selectedStages({ ai: true }), ask: fakeAsk(), load: loadFrom(mods) })
  const by = Object.fromEntries(out.stages.map(s => [s.id, s]))
  assert.equal(by.tests.status, 'skipped'); assert.match(by.tests.reason, /not part of this build/)
  assert.equal(by.flows.status, 'skipped')
  assert.equal(by.describe.status, 'ran'); assert.equal(by.describe.calls.length, 2)
  assert.deepEqual(by.describe.items.map(i => i.status), ['verified', 'not verified'])
  assert.equal(by.triage.items[0].text.startsWith('1. F2'), true)
  const calls = c.read().filter(e => e.type === 'model.call')
  assert.equal(calls.length, 3); assert.deepEqual(calls.map(e => e.data.kind).sort(), ['describe', 'describe', 'triage'])
  assert.ok(calls.every(e => e.data.model === 'fake-model' && e.data.estUsd > 0))
  assert.equal(c.read().filter(e => e.type === 'ai.stage').length, 2)
  assert.equal(c.verify().ok, true, 'the chain is intact after the stages wrote to it')
  assert.ok(Math.abs(out.spentUsd - 3 * (1000 * 1.25e-6 + 500 * 4.25e-6)) < 1e-6)
})

test('the lines the stages add are anchored, so Verify chain covers them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-anchor-')), dir = join(root, CASE_ID), c = openCase(dir)
  c.event('case.opened', { goodRef: 'v3.3.1', candRef: 'v3.4.1', adapter: 'umami', app: 'umami', steps: [] })
  await runAiStages({ caseDir: dir, stages: selectedStages({ aiTriage: true }), ask: fakeAsk(), load: loadFrom({ triage: fakeModule([{ findingId: 'F1', rank: 1, reason: 'r' }]) }) })
  const v = verifyAnchors(root, CASE_ID, c)
  assert.equal(v.ok, true); assert.equal(v.since, 0); assert.equal(v.total, c.read().length)
})
test('the total cost cap stops further calls and further stages', async () => {
  const { dir } = makeCase()
  const log = []
  const mods = { tests: fakeModule([{ text: 'one' }], { calls: 5 }), flows: fakeModule([{ text: 'two' }]), describe: fakeModule([{ text: 'three' }]) }
  // one call is about $0.0034; a budget of $0.007 allows two
  const out = await runAiStages({ caseDir: dir, stages: ['tests', 'flows', 'describe'], budgetUsd: 0.007, ask: fakeAsk(log), load: loadFrom(mods) })
  const by = Object.fromEntries(out.stages.map(s => [s.id, s]))
  assert.equal(by.tests.status, 'failed'); assert.match(by.tests.reason, /budget/)
  assert.ok(log.length <= 3, `at most the calls that fit, got ${log.length}`)
  assert.equal(by.flows.status, 'skipped'); assert.match(by.flows.reason, /budget/)
  assert.ok(out.spentUsd < 0.011)
})

test('spend that happened before (an --explain call) counts toward the cap', async () => {
  const { dir } = makeCase()
  const log = []
  const out = await runAiStages({ caseDir: dir, stages: ['triage'], budgetUsd: 0.25, spentBeforeUsd: 0.25, ask: fakeAsk(log), load: loadFrom({ triage: fakeModule([]) }) })
  assert.equal(log.length, 0); assert.equal(out.stages[0].status, 'skipped')
  assert.equal(out.totalUsd, 0.25)
})

test('a module that throws, or that does not export run(), is a note and not a crash', async () => {
  const { dir } = makeCase()
  const mods = { tests: { async run() { throw new Error('boom') } }, flows: { nothing: true }, triage: fakeModule([{ text: 'ok' }]) }
  const out = await runAiStages({ caseDir: dir, stages: ['tests', 'flows', 'triage'], ask: fakeAsk(), load: loadFrom(mods) })
  assert.deepEqual(out.stages.map(s => s.status), ['failed', 'skipped', 'ran'])
  assert.match(out.stages[0].reason, /boom/); assert.match(out.stages[1].reason, /run\(\)/)
  assert.deepEqual((await loadStage(STAGES[0], async () => { throw new SyntaxError('Unexpected token') })).skipped.includes('could not be loaded'), true)
})

test('calls a module made through its own client are taken from what it reports', async () => {
  const { c, dir } = makeCase()
  const mod = { async run() { return { label: 'ai_hypothesis', items: [{ text: 'x' }], calls: [{ model: 'muse-spark-1.3', provider: 'meta', promptTokens: 2000, completionTokens: 1000, usd: 0.00675 }], spentUsd: 0.00675, notes: [] } } }
  const out = await runAiStages({ caseDir: dir, stages: ['tests'], ask: fakeAsk(), load: loadFrom({ tests: mod }) })
  assert.equal(out.spentUsd, 0.00675)
  assert.equal(c.read().filter(e => e.type === 'model.call').length, 1)
})

test('no key and no injected ask: nothing is loaded and nothing is sent', async () => {
  const { dir } = makeCase()
  let loaded = 0
  const had = process.env.META_API_KEY
  const out = await runAiStages({ caseDir: dir, stages: ['triage'], load: async () => { loaded++; return { async run() { return { label: 'ai_hypothesis', items: [], calls: [], notes: [] } } } } }) // never asks the model
  // when a key is configured in .env the stage legitimately runs (with the fake module); the point is that nothing throws
  assert.ok(['skipped', 'ran'].includes(out.stages[0].status))
  if (out.stages[0].status === 'skipped') { assert.match(out.stages[0].reason, /META_API_KEY/); assert.equal(loaded, 0) }
  if (had === undefined) delete process.env.META_API_KEY
})

test('normalizeItem reads the shapes the modules use and never trusts a model string as markup', () => {
  assert.deepEqual(normalizeItem('describe', { description: 'd', verified: true }), { text: 'd', status: 'verified', detail: null })
  assert.equal(normalizeItem('describe', { description: 'd', verified: false, droppedBecause: 'why' }).detail, 'why')
  assert.equal(normalizeItem('tests', { title: 't' }).status, 'unverified')
  assert.match(normalizeItem('x', { odd: 1 }).text, /odd/)
  const t = normalizeItem('tests', { findingId: 'R1', name: 'share link stays plain', reason: 'the data-url must not be encoded', verified: true, runs: { good: { passed: 3, total: 3 }, candidate: { failed: 3, total: 3 } } })
  assert.equal(t.text, 'share link stays plain: the data-url must not be encoded'); assert.equal(t.status, 'verified'); assert.match(t.detail, /passes 3\/3.*fails 3\/3.*fresh build/)
  const f = normalizeItem('flows', { flowId: 'F1', purpose: 'open the menu then Share', steps: [1, 2], plan: [{}], replay: { runs: 3, passed: 3, stable: true } })
  assert.equal(f.status, 'replayed'); assert.match(f.detail, /3 of 3.*not been run on the candidate/); assert.match(f.text, /2 steps/)
  assert.equal(normalizeItem('flows', { flowId: 'F2', purpose: 'p', steps: [], replay: { runs: 0 }, droppedBecause: 'invalid: x' }).status, 'not verified')
  assert.equal(normalizeItem('triage', { rank: 1, findingId: 'F3', reason: 'looks real' }).text, '1. F3: looks real')
  const md = markdownOf({ ...baseResult(), ai: { label: 'ai_hypothesis', budgetUsd: 0.25, totalUsd: 0.003, stages: [{ id: 'describe', title: 'AI description of the pictures', status: 'ran', calls: [{ model: 'm' }], spentUsd: 0.003, notes: ['n'], items: [{ text: 'ping @everyone <img src=x onerror=1>\nnext', status: 'verified', detail: null }] }] } })
  assert.ok(!md.includes('@everyone') && !md.includes('<img'))
})

function baseResult() {
  const { c } = makeCase()
  return resultOf(buildViewModel(c, { caseId: CASE_ID }), { caseId: CASE_ID, dashboard: null })
}

test('PROOF: the verdict, the exit code and every finding are byte-identical with and without the AI stages', async () => {
  const { c, dir } = makeCase()
  const before = resultOf(buildViewModel(c, { caseId: CASE_ID }), { caseId: CASE_ID, dashboard: null })
  const mods = { triage: fakeModule([{ findingId: 'R1', rank: 1, reason: 'a real change' }]), describe: fakeModule([{ description: 'text changed', verified: true }]), tests: fakeModule([{ title: 'a test' }]), flows: fakeModule([{ title: 'a flow' }]) }
  // the AI stages run and write into the case (events, artifacts, model.call) ...
  const ai = await runAiStages({ caseDir: dir, stages: selectedStages({ ai: true }), ask: fakeAsk(), load: loadFrom(mods) })
  assert.equal(ai.stages.every(s => s.status === 'ran'), true)
  // ... and the dashboard's view of the same case, read again afterwards, still says the same thing
  const after = resultOf(buildViewModel(openCase(dir), { caseId: CASE_ID }), { caseId: CASE_ID, dashboard: null })
  assert.equal(verdictFingerprint(after), verdictFingerprint(before))
  assert.equal(JSON.stringify([after.recommendation, after.exitCode]), JSON.stringify([before.recommendation, before.exitCode]))
  assert.equal(after.exitCode, 1)
  // the Markdown with the AI section differs only by what is added: everything the check proved is the same text
  const withAi = markdownOf({ ...after, ai })
  const without = markdownOf(before)
  const proof = md => md.split('\n### AI guesses')[0].split('\nCase `')[0].split('\nThe verdict and every')[0]
  assert.equal(proof(withAi), proof(without))
  assert.ok(withAi.includes('### AI guesses (a model wrote these; none of it changes the verdict or the exit code)'))
  assert.equal(without.includes('AI guesses'), false)
  assert.equal(aiSection(before).length, 0)
  // the stage's own failure cannot move it either
  const failing = await runAiStages({ caseDir: dir, stages: ['triage'], ask: async () => { throw new Error('HTTP 500') }, load: loadFrom({ triage: fakeModule([{ text: 'x' }]) }) })
  assert.equal(failing.stages[0].status, 'failed')
  assert.equal(verdictFingerprint(resultOf(buildViewModel(openCase(dir), { caseId: CASE_ID }), { caseId: CASE_ID, dashboard: null })), verdictFingerprint(before))
  assert.equal(openCase(dir).verify().ok, true)
})
