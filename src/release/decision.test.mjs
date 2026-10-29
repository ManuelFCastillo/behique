// node --test src/release/decision.test.mjs   (offline)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkDecision, recordDecision, REASON } from './decision.mjs'
import { openCase } from './evidence.mjs'
import { buildViewModel } from './viewmodel.mjs'

// a finished report whose recommendation is `kind`: hold (a proven change), ship (nothing differed), review, fail; or one still running
function report(kind) {
  const c = openCase(mkdtempSync(join(tmpdir(), 'dec-')))
  c.event('case.opened', { goodRef: '1.0', candRef: '2.0', adapter: 'freshrss', steps: [], scenario: null })
  c.event('builds.compared', { good: { ref: '1.0', sha: 'a'.repeat(40) }, candidate: { ref: '2.0', sha: 'b'.repeat(40) } })
  const facts = c.artifact('facts-diff.json', { control: [], candidate: [] })
  c.claim('verified_fact', 'recorded', { evidence: [facts] })
  if (kind === 'hold') { c.event('test.exported', { id: 'R1' }); c.claim('reproduced_failure', 'fails on the new version', { evidence: [c.artifact('R1.spec.js', 'x')] }) }
  if (kind !== 'running') c.event('case.closed', { outcome: { hold: 'regression proven', ship: 'no changed facts', review: 'not confirmed', fail: 'build failed' }[kind] })
  return c
}
const lines = c => readFileSync(join(c.dir, 'events.ndjson'), 'utf8')
const D = (extra = {}) => ({ decision: 'hold', note: 'blocking this one', who: '', ...extra })

test('the rule table', () => {
  const ok = (x, y) => assert.deepEqual({ ok: x.ok, status: x.status, needsOverride: x.needsOverride, override: x.override }, y)
  const c = (o) => checkDecision({ verdict: 'hold', choice: 'hold', reason: 'because', ...o })
  ok(c({}), { ok: true, status: undefined, needsOverride: undefined, override: false })
  ok(c({ choice: 'maybe' }), { ok: false, status: 400, needsOverride: undefined, override: undefined })
  ok(c({ verdict: 'running' }), { ok: false, status: 400, needsOverride: undefined, override: undefined })
  ok(c({ verdict: 'fail', choice: 'ship', reason: 'ship it anyway please' }), { ok: false, status: 400, needsOverride: undefined, override: undefined })
  ok(c({ verdict: 'fail' }), { ok: true, status: undefined, needsOverride: undefined, override: false })
  ok(c({ reason: 'ab' }), { ok: false, status: 400, needsOverride: undefined, override: undefined })
  ok(c({ reason: 'abc' }), { ok: true, status: undefined, needsOverride: undefined, override: false })
  ok(c({ reason: '   ' }), { ok: false, status: 400, needsOverride: undefined, override: undefined })
  ok(c({ reason: 'x'.repeat(REASON.max + 1) }), { ok: false, status: 400, needsOverride: undefined, override: undefined })
  ok(c({ reason: 'x'.repeat(REASON.max) }), { ok: true, status: undefined, needsOverride: undefined, override: false })
  ok(c({ who: 'n'.repeat(81) }), { ok: false, status: 400, needsOverride: undefined, override: undefined })
  // shipping against a proven change is an override: it needs an explicit yes AND a longer reason
  ok(c({ choice: 'ship' }), { ok: false, status: 409, needsOverride: true, override: undefined })
  ok(c({ choice: 'ship', confirmOverride: 'yes' }), { ok: false, status: 409, needsOverride: true, override: undefined })
  ok(c({ choice: 'ship', confirmOverride: true, reason: 'nine chrs' }), { ok: false, status: 400, needsOverride: undefined, override: undefined })
  ok(c({ choice: 'ship', confirmOverride: true, reason: 'ten chars!' }), { ok: true, status: undefined, needsOverride: undefined, override: true })
  // shipping when Behique recommends ship, or has no proven change, is not an override
  ok(c({ verdict: 'ship', choice: 'ship' }), { ok: true, status: undefined, needsOverride: undefined, override: false })
  ok(c({ verdict: 'inconclusive', choice: 'ship' }), { ok: true, status: undefined, needsOverride: undefined, override: false })
})

test('the reason is collapsed to one line and a name is trimmed', () => {
  const r = checkDecision({ verdict: 'hold', choice: 'hold', reason: '  two\n lines\t here  ', who: '  Manny  ' })
  assert.equal(r.reason, 'two lines here'); assert.equal(r.who, 'Manny')
})

test('a refused decision appends nothing, whatever the reason for refusing', () => {
  for (const [kind, input] of [['hold', D({ note: 'x' })], ['hold', D({ decision: 'ship' })], ['hold', D({ decision: 'ship', confirmOverride: true, note: 'short' })], ['running', D()], ['fail', D({ decision: 'ship', note: 'ship it anyway' })], ['hold', D({ decision: 'bogus' })], ['hold', D({ who: 'n'.repeat(81) })]]) {
    const c = report(kind), before = lines(c), r = recordDecision(c, input)
    assert.equal(r.ok, false, `${kind} ${JSON.stringify(input).slice(0, 60)}`); assert.equal(lines(c), before, 'the record is byte for byte unchanged')
  }
})

test('a decision records what Behique recommended, whether it was an override, and what it replaces', () => {
  const c = report('hold')
  const first = recordDecision(c, D({ decision: 'ship', confirmOverride: true, note: 'accepting this for the demo build', who: 'Manny' }))
  assert.deepEqual([first.ok, first.override, first.recommendation, first.supersedes], [true, true, 'hold', null])
  const second = recordDecision(c, D({ note: 'changed my mind, holding' }))
  assert.deepEqual([second.ok, second.override, second.recommendation, second.supersedes], [true, false, 'hold', first.seq])
  const ev = c.read().filter(e => e.type === 'decision')
  assert.equal(ev.length, 2, 'both decisions stay on the record'); assert.equal(ev[0].data.decision, 'ship'); assert.equal(ev[1].data.supersedes, ev[0].seq)
  assert.equal(c.verify().ok, true, 'the chain is intact after decisions')
})

test('the dashboard sees the recommendation and the decision separately, with the full history', () => {
  const c = report('hold')
  recordDecision(c, D({ decision: 'ship', confirmOverride: true, note: 'accepting this knowingly', who: 'Manny' }))
  recordDecision(c, D({ note: 'on reflection, hold' }))
  const vm = buildViewModel(c, { caseId: 'x' })
  assert.equal(vm.verdict, 'hold'); assert.equal(vm.recommendation, 'hold', 'the recommendation does not move with the decision')
  assert.deepEqual([vm.decision.choice, vm.decision.agrees, vm.decision.override, vm.decision.recommendation], ['HOLD', true, false, 'hold'])
  assert.deepEqual(vm.decisionHistory.map(d => [d.choice, d.override, d.agrees]), [['HOLD', false, true], ['SHIP', true, false]], 'newest first')
  assert.equal(vm.decisions, 2); assert.equal(vm.canDecide, true); assert.equal(vm.canShip, true)
  const human = vm.claims.filter(k => k.kind === 'human_decision')
  assert.deepEqual(human.map(k => k.chips), [['decision', 'against recommendation'], ['decision']]); assert.match(human[0].foot, /actor: human \(Manny\)/)
})

test('agreement is only judged against a hold or ship recommendation', () => {
  const r = report('review'); recordDecision(r, D({ decision: 'ship', note: 'looked at it, fine' }))
  assert.equal(buildViewModel(r, { caseId: 'x' }).decision.agrees, null)
  const s = report('ship'); recordDecision(s, D({ decision: 'ship', note: 'nothing changed' }))
  assert.deepEqual([buildViewModel(s, { caseId: 'x' }).decision.agrees, buildViewModel(s, { caseId: 'x' }).decision.override], [true, false])
})

test('what can be decided follows the recommendation', () => {
  assert.deepEqual([report('running'), report('fail'), report('hold'), report('ship'), report('review')].map(c => { const v = buildViewModel(c, { caseId: 'x' }); return [v.verdict, v.canDecide, v.canShip] }),
    [['running', false, false], ['fail', true, false], ['hold', true, true], ['ship', true, true], ['inconclusive', true, true]])
  const f = report('fail'); assert.equal(recordDecision(f, D()).ok, true, 'hold is possible on incomplete evidence')
})

test('a long reason is refused and never stored cut short', () => {
  const c = report('hold'); const r = recordDecision(c, D({ note: 'x'.repeat(501) }))
  assert.equal(r.ok, false); assert.match(r.error, /too long/)
  assert.equal(recordDecision(c, D({ note: 'y'.repeat(500) })).ok, true)
  assert.equal(c.read().filter(e => e.type === 'decision')[0].data.note.length, 500)
})
