// node --test src/release/triage.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCase } from './evidence.mjs'
import { agreementOf, buildMessages, completeRanking, describeFinding, loadFindings, maskedUnder, rankWith, renderMarkdown, run, validateResponse } from './triage.mjs'

const F = (id, key, cls, extra = {}) => ({ id, key, kind: 'changed', was: 'a', now: 'b', step: 1, stepLabel: '1:click role=link[name="Docs"]', page: '/docs', notice: { cls, why: 'x' }, ...extra })
const FINDINGS = [
  F('R1', 'body/div[1]/div[1]@data-v-abc123', 'churn'),
  F('R2', 'body/div[1]/nav[1]/a[1]#text', 'visible', { was: 'Docs', now: 'Guide' }),
  F('R3', 'body/div[1]/img[1]@src', 'third_party'),
  F('R4', 'body/div[1]/main[1]/a[2]@href', 'visible', { was: '/a', now: '/b' }),
]
const ids = FINDINGS.map(f => f.id)
const answer = list => JSON.stringify({ ranking: list.map(id => ({ id, reason: `why ${id}` })) })
const fakeAsk = (text, usage = { promptTokens: 1000, completionTokens: 300 }) => async () => ({ text, usage })

test('validateResponse accepts the JSON, fenced JSON and a bare array', () => {
  assert.deepEqual(validateResponse(answer(['R2', 'R4']), ids).ranking.map(r => r.id), ['R2', 'R4'])
  assert.equal(validateResponse('```json\n' + answer(['R4']) + '\n```', ids).ok, true)
  assert.deepEqual(validateResponse('[{"id":"R1","reason":"r"}]', ids).ranking.map(r => r.id), ['R1'])
})

test('validateResponse drops invented ids, repeats and malformed entries, and caps reasons', () => {
  const t = JSON.stringify({ ranking: [{ id: 'R9', reason: 'x' }, { id: 'R2', reason: 'y'.repeat(900) }, { id: 'R2', reason: 'again' }, { reason: 'no id' }, 7] })
  const v = validateResponse(t, ids)
  assert.deepEqual(v.ranking.map(r => r.id), ['R2'])
  assert.equal(v.ranking[0].reason.length, 280)
  assert.deepEqual(v.dropped.unknown, ['R9'])
  assert.deepEqual(v.dropped.duplicate, ['R2'])
  assert.equal(v.dropped.malformed, 2)
})

test('validateResponse refuses prose, empty rankings and rankings of nothing real', () => {
  assert.equal(validateResponse('I think R2 matters most.', ids).ok, false)
  assert.equal(validateResponse('', ids).ok, false)
  assert.equal(validateResponse(answer(['R7', 'R8']), ids).ok, false)
})

test('completeRanking lists every finding exactly once and appends omitted ones, marked not ranked', () => {
  const { items, notRanked } = completeRanking(FINDINGS, [{ id: 'R4', reason: 'a' }, { id: 'R1', reason: 'b' }])
  assert.deepEqual(items.map(i => i.findingId), ['R4', 'R1'])
  assert.deepEqual(notRanked.map(i => i.findingId), ['R2', 'R3']) // code order: visible before third party
  assert.ok(notRanked.every(i => i.notRanked && i.reason === 'not ranked by the model' && i.agreesWithCode === false))
  assert.deepEqual([...items, ...notRanked].map(i => i.rank), [1, 2, 3, 4])
  assert.deepEqual([...items, ...notRanked].map(i => i.findingId).sort(), [...ids].sort())
})

test('agreesWithCode is true when the item sits where its class puts it', () => {
  const { items } = completeRanking(FINDINGS, ['R2', 'R4', 'R1', 'R3'].map(id => ({ id, reason: '' })))
  assert.deepEqual(items.map(i => i.agreesWithCode), [true, true, true, true])
  const wrong = completeRanking(FINDINGS, ['R1', 'R2', 'R4', 'R3'].map(id => ({ id, reason: '' }))).items
  assert.deepEqual(wrong.map(i => i.agreesWithCode), [false, true, false, true]) // churn first is wrong; the visible band is positions 1-2, so R4 at 3 is outside it
})

test('agreementOf: top1 and pairwise against the code classes', () => {
  const o = cls => cls.map(codeClass => ({ codeClass }))
  assert.deepEqual(agreementOf(o(['visible', 'visible', 'churn', 'third_party'])), { top1: true, pairwise: 1, comparablePairs: 5, n: 4 })
  assert.deepEqual(agreementOf(o(['churn', 'visible'])), { top1: false, pairwise: 0, comparablePairs: 1, n: 2 })
  const mixed = agreementOf(o(['visible', 'churn', 'visible']))
  assert.equal(mixed.top1, true)
  assert.equal(mixed.pairwise, 0.5)
  assert.deepEqual(agreementOf(o(['visible', 'visible'])), { top1: true, pairwise: null, comparablePairs: 0, n: 2 })
  assert.deepEqual(agreementOf([]), { top1: null, pairwise: null, comparablePairs: 0, n: 0 })
})

test('the prompt names every finding, can leave the code class out, and marks page data untrusted', () => {
  const m = buildMessages(FINDINGS, { app: 'demo', good: 'v1', cand: 'v2', mask: '5 of 100 recorded facts were masked.' })
  assert.equal(m.length, 2)
  for (const id of ids) assert.ok(m[1].content.includes(`[${id}]`))
  assert.match(m[1].content, /code's own rule says: a person would notice/)
  assert.match(m[0].content, /untrusted_findings/)
  assert.match(m[1].content, /<untrusted_findings>/)
  const blind = buildMessages(FINDINGS, {}, { withCodeClass: false, rubric: false })
  assert.doesNotMatch(blind[1].content, /code's own rule/)
  assert.doesNotMatch(blind[0].content, /People usually care about/)
  assert.doesNotMatch(JSON.stringify(m), /\u2014/) // no em dashes
})

test('describeFinding words each kind of fact and never shows test outcomes unless asked', () => {
  assert.match(describeFinding(F('R1', 'window@path', 'visible')), /where the page ends up/)
  assert.match(describeFinding(F('R1', 'body/div[1]/main[1]#scrolls', 'visible', { kind: 'removed' })), /can scroll/)
  const withRuns = F('R1', 'body/a[1]@href', 'visible', { runs: { goodPassed: 3, candFailed: 0, runs: 3 }, maskedUnder: { area: 'body/div[1]', count: 9 } })
  assert.doesNotMatch(describeFinding(withRuns), /passed/)
  assert.match(describeFinding(withRuns, { withRuns: true }), /passed 3 of 3 runs on the old version/)
  assert.match(describeFinding(withRuns), /9 facts under body\/div\[1\] were masked/)
})

test('maskedUnder matches the area prefix only', () => {
  const mask = { areas: [{ area: 'body/div[1]/div[3]', count: 40 }] }
  assert.deepEqual(maskedUnder('body/div[1]/div[3]/p[1]#text', mask), { area: 'body/div[1]/div[3]', count: 40 })
  assert.equal(maskedUnder('body/div[1]/div[30]/p[1]#text', mask), null)
  assert.equal(maskedUnder('body/x@y', null), null)
})

test('rankWith: a good answer, labelled as an AI guess, with cost and agreement', async () => {
  const r = await rankWith(FINDINGS, { app: 'demo' }, { ask: fakeAsk(answer(['R2', 'R4', 'R1', 'R3'])) })
  assert.equal(r.label, 'ai_hypothesis')
  assert.deepEqual(r.items.map(i => i.findingId), ['R2', 'R4', 'R1', 'R3'])
  assert.deepEqual(r.agreement, { top1: true, pairwise: 1, comparablePairs: 5, n: 4 })
  assert.equal(r.calls.length, 1)
  assert.ok(r.spentUsd > 0 && r.spentUsd < 0.01)
  assert.deepEqual(r.calls[0], { ...r.calls[0], promptTokens: 1000, completionTokens: 300, provider: 'meta' })
})

test('rankWith: an incomplete answer is completed by code and says so', async () => {
  const r = await rankWith(FINDINGS, {}, { ask: fakeAsk(answer(['R4', 'R9', 'R4', 'R1'])) })
  assert.deepEqual(r.items.map(i => i.findingId), ['R4', 'R1'])
  assert.deepEqual(r.notRanked.map(i => i.findingId), ['R2', 'R3'])
  assert.ok(r.notes.some(n => /invented/.test(n)) && r.notes.some(n => /repeated/.test(n)) && r.notes.some(n => /not ranked/.test(n)))
})

test('rankWith: garbage, a thrown error and a too-small budget never throw and never rank', async () => {
  for (const ask of [fakeAsk('no json at all'), async () => { throw new Error('HTTP 500') }]) {
    const r = await rankWith(FINDINGS, {}, { ask })
    assert.deepEqual(r.items, [])
    assert.equal(r.notRanked.length, 4)
    assert.ok(r.notes.length)
  }
  let called = false
  const r = await rankWith(FINDINGS, {}, { ask: async () => { called = true; return { text: '' } }, maxUsd: 0.0001 })
  assert.equal(called, false)
  assert.equal(r.spentUsd, 0)
  assert.match(r.notes[0], /not sent/)
})

test('rankWith never changes the findings it is given', async () => {
  const before = JSON.stringify(FINDINGS)
  await rankWith(FINDINGS, {}, { ask: fakeAsk(answer(['R3', 'R1', 'R4', 'R2'])) })
  assert.equal(JSON.stringify(FINDINGS), before)
})

test('rankWith with no findings makes no call', async () => {
  let called = false
  const r = await rankWith([], {}, { ask: async () => { called = true } })
  assert.equal(called, false)
  assert.deepEqual(r.items, [])
})

// A saved case with one confirmed finding and two that did not reproduce.
function makeCase() {
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  const c = openCase(dir)
  c.event('case.opened', { goodRef: 'v1.0.0', candRef: 'v1.1.0', app: 'demo', adapter: 'demo', steps: [] })
  const diffs = [
    { i: 0, step: 'start', key: 'body/nav[1]/a[1]#text', kind: 'changed', was: 'Docs', now: 'Guide' },
    { i: 2, step: '2:click role=button[name="Menu"]', key: 'body/div[1]@data-v-abc123', kind: 'changed', was: 'x', now: 'y' },
    { i: 2, step: '2:click role=button[name="Menu"]', key: 'body/footer[1]/a[1]@href', kind: 'changed', was: '/a', now: '/b' },
  ]
  c.artifact('facts-diff.json', { control: [], candidate: diffs }, 'application/json')
  c.artifact('baseline.json', { stable: { '2|window@path': '/menu' } }, 'application/json')
  c.event('masking.summary', { masked: 5, total: 100, learned: 5, areas: [{ area: 'body/div[1]', count: 5 }] })
  diffs.forEach((d, i) => c.event('test.exported', { id: `R${i + 1}`, fact: d.key, good: JSON.stringify(d.was), candidate: JSON.stringify(d.now) }))
  c.event('test.judged', { id: 'R1', verdict: 'confirmed', goodPassed: 3, candFailed: 3, runs: 3 })
  c.event('test.judged', { id: 'R2', verdict: 'unstable', goodPassed: 3, candFailed: 1, runs: 3 })
  c.event('test.judged', { id: 'R3', verdict: 'not_reproduced', goodPassed: 3, candFailed: 0, runs: 3 })
  c.event('case.closed', { outcome: 'inconclusive' })
  return dir
}

test('loadFindings: review scope keeps only the unreproduced, with step, page and noise context', () => {
  const dir = makeCase()
  const { findings, context } = loadFindings(dir)
  assert.deepEqual(findings.map(f => f.id), ['R2', 'R3'])
  assert.equal(findings[0].page, '/menu')
  assert.deepEqual(findings[0].maskedUnder, { area: 'body/div[1]', count: 5 })
  assert.equal(findings[0].notice.cls, 'churn')
  assert.equal(findings[1].notice.cls, 'visible')
  assert.match(context.mask, /5 of 100/)
  assert.equal(loadFindings(dir, { scope: 'all' }).findings.length, 3)
})

test('run: ranks a saved case, records the exact text and the call, and changes nothing the verdict reads', async () => {
  const dir = makeCase()
  const before = openCase(dir).read().length
  const r = await run({ caseDir: dir, ask: fakeAsk(answer(['R3', 'R2'])) })
  assert.equal(r.label, 'ai_hypothesis')
  assert.deepEqual(r.items.map(i => i.findingId), ['R3', 'R2'])
  assert.deepEqual(r.items.map(i => i.codeClass), ['visible', 'churn'])
  assert.equal(r.agreement.top1, true)
  assert.ok(r.sent[1].content.includes('[R2]'))
  const events = openCase(dir).read()
  const added = events.slice(before)
  assert.deepEqual(added.map(e => e.type), ['artifact', 'model.requested', 'model.call', 'artifact', 'triage.ranked'])
  assert.ok(!events.some(e => e.type === 'claim' && e.data.label === 'ai_hypothesis')) // the why-call's three-guess limit is untouched
  assert.ok(!events.some(e => e.type === 'decision'))
  assert.equal(openCase(dir).verify().ok, true)
  const prompt = JSON.parse(readFileSync(openCase(dir).artifactPath(added[0].data.hash), 'utf8'))
  assert.deepEqual(prompt, r.sent)
})

test('run with record:false leaves the case untouched; a case with nothing to rank makes no call', async () => {
  const dir = makeCase()
  const n = openCase(dir).read().length
  await run({ caseDir: dir, ask: fakeAsk(answer(['R2', 'R3'])), record: false })
  assert.equal(openCase(dir).read().length, n)
  let called = false
  const empty = mkdtempSync(join(tmpdir(), 'triage-empty-'))
  openCase(empty).event('case.opened', { goodRef: 'a', candRef: 'b', app: 'demo', steps: [] })
  const r = await run({ caseDir: empty, ask: async () => { called = true } })
  assert.equal(called, false)
  assert.deepEqual(r.items, [])
  assert.match(r.notes.join(' '), /no unreproduced/)
})

test('renderMarkdown labels the view as an AI guess', async () => {
  const r = await rankWith(FINDINGS, {}, { ask: fakeAsk(answer(['R2'])) })
  const md = renderMarkdown(r)
  assert.match(md, /AI guess, not proof/)
  assert.match(md, /does not change the verdict/)
  assert.match(md, /R1 \(.*\): not ranked/)
})
