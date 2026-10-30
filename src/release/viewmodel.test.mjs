// node --test src/release/viewmodel.test.mjs   (offline)
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCase, sha, writeError } from './evidence.mjs'
import { buildViewModel, verdictOf } from './viewmodel.mjs'
import { summarize } from './evidence.mjs'

const LOG = ['bisect: 100 changes between a and b', '  bisect step 1: aaaaaaa (#50 of 100) good | s', '  bisect step 2: bbbbbbb (#75 of 100) bad | s', '  bisect step 3: ccccccc (#62 of 100) bad | s', '  bisect step 4: ddddddd (#56 of 100) good | s', 'bisect: first bad change is #62 of 100, found in 4 steps']
function report({ outcome = 'regression proven', proven = true, bisect = true, decide = null, close = true } = {}) {
  const c = openCase(mkdtempSync(join(tmpdir(), 'vm-')))
  c.event('case.opened', { goodRef: '1.0', candRef: '2.0', adapter: 'freshrss', steps: [], scenario: null })
  c.event('builds.compared', { good: { ref: '1.0', sha: 'aaaaaaa111' }, candidate: { ref: '2.0', sha: 'bbbbbbb222' } })
  const facts = c.artifact('facts-diff.json', { control: [], candidate: [{ kind: 'changed', key: 'body/div[1]/a[1]@href', was: 'x', now: 'y', step: '1:click', i: 1 }] })
  c.claim('verified_fact', 'one value changed', { evidence: [facts] })
  if (proven) {
    c.event('test.exported', { id: 'R1' })
    const spec = c.artifact('R1.spec.js', 'x')
    c.claim('reproduced_failure', 'the test passes on old and fails on new', { evidence: [spec] })
    if (bisect) {
      const bis = c.artifact('bisect.json', { result: { conclusive: true, verified: true, commit: 'cccccccfff', subject: 'Fix the thing (#12)', author: 'A', date: '2026-01-01', files: ['a.js'], changes: 100, steps: 4 }, log: LOG })
      c.claim('reproduced_failure', 'first bad change is ccccccc. The change just before it passed 3 of 3 runs and it failed 3 of 3 runs.', { evidence: [bis, spec] })
    }
  }
  if (decide) c.decide(decide.choice, decide)
  if (close) c.event('case.closed', { outcome })
  return c
}

test('verdict is a recommendation read from the record', () => {
  const v = c => verdictOf(c.read(), summarize(c.read()))
  assert.equal(v(report()), 'hold')
  assert.equal(v(report({ proven: false, outcome: 'no changed facts' })), 'ship')
  assert.equal(v(report({ proven: false, outcome: 'not confirmed' })), 'inconclusive')
  assert.equal(v(report({ proven: false, outcome: 'masking not trustworthy' })), 'fail')
  assert.equal(v(report({ proven: false, outcome: 'build failed' })), 'fail')
  assert.equal(v(report({ proven: false, outcome: 'facts missing' })), 'inconclusive', 'a vanished element is never a SHIP recommendation')
  assert.equal(v(report({ proven: false, close: false })), 'running')
})

test('a run that never closed becomes "fail" once it is stale, not "running" forever', () => {
  const c = report({ proven: false, close: false })
  assert.equal(verdictOf(c.read(), summarize(c.read()), Date.now() + 16 * 60 * 1000), 'fail')
})

test('every claim carries its real hash, and the hashes chain back to the first event', () => {
  const c = report(), vm = buildViewModel(c, { caseId: 'x' }), raw = c.rawLines()
  assert.ok(vm.claims.length >= 3)
  for (const k of vm.claims) {
    assert.equal(k.hash, sha(raw[k.seq])); assert.equal(k.prevHash, sha(raw[k.seq - 1]))
    assert.equal(JSON.parse(raw[k.seq]).prev, k.prevHash, 'the stored link points at the previous event')
  }
  assert.equal(vm.chain.ok, true); assert.equal(vm.rawLines.length, vm.events)
})

test('the search is drawn from the saved record: tested steps kept, one culprit, verdicts by position', () => {
  const vm = buildViewModel(report(), { caseId: 'x' }), n = vm.bisect.nodes
  assert.equal(vm.bisect.changes, 100); assert.equal(vm.bisect.steps, 4); assert.equal(vm.bisect.verifiedText, 'verified 3/3 and 3/3')
  assert.ok(n.length <= 15 && n.every((x, i) => i === 0 || x.index > n[i - 1].index), 'at most 15, in order')
  assert.equal(n.filter(x => x.verdict === 'culprit').length, 1)
  assert.deepEqual(n.filter(x => x.tested).map(x => x.step).sort(), [1, 2, 3, 4])
  assert.ok(n.filter(x => x.verdict === 'good').every(x => x.index < 62) && n.filter(x => x.verdict === 'bad').every(x => x.index > 62))
  assert.equal(vm.bisect.ends.culprit, 'ccccccc #12')
  assert.equal(vm.culpritClaimId, vm.claims.find(k => k.text.startsWith('first bad change')).id)
})

test('a human decision appears as a human claim (the override flag is a later piece)', () => {
  const vm = buildViewModel(report({ decide: { choice: 'hold', who: 'm', note: 'blocking' } }), { caseId: 'x' })
  const d = vm.claims.at(-1)
  assert.equal(d.kind, 'human_decision'); assert.equal(d.actor, 'human'); assert.equal(vm.decision.choice, 'HOLD'); assert.equal(vm.decisions, 1)
})

test('a report with no search still renders (no search section, nothing invented)', () => {
  const vm = buildViewModel(report({ bisect: false }), { caseId: 'x' })
  assert.equal(vm.bisect, null); assert.equal(vm.culpritClaimId, null); assert.equal(vm.model.canAsk, false)
})

test('the authorship rule is one shared function, so the dashboard can ask the real rule', () => {
  assert.equal(writeError('verified_fact', 'code'), null)
  assert.match(writeError('verified_fact', 'model'), /model may not write a verified_fact claim \(allowed: code\)/)
  assert.match(writeError('made_up', 'code'), /unknown claim label/)
})

test('an empty record is refused clearly', () => {
  assert.throws(() => buildViewModel(openCase(mkdtempSync(join(tmpdir(), 'vm-'))), { caseId: 'x' }), /empty or does not exist/)
})

// ---- a run in flight: the record grows stage by stage, and the view-model reads where it is up to ----
function growing() {
  const c = openCase(mkdtempSync(join(tmpdir(), 'vm-')))
  const vm = () => buildViewModel(c, { caseId: 'x' })
  c.event('case.opened', { goodRef: '1.0', candRef: '2.0', adapter: 'freshrss', steps: [], options: { bisect: true, runs: 3 }, scenario: null })
  return { c, vm }
}

test('progress follows the record: recording, comparing, testing n of 6, searching, double-checking, then none', () => {
  const { c, vm } = growing()
  assert.equal(vm().verdict, 'running'); assert.equal(vm().progress.phase, 'recording'); assert.match(vm().sub, /Recording both versions/)
  c.event('builds.compared', { good: { ref: '1.0', sha: 'a'.repeat(40) }, candidate: { ref: '2.0', sha: 'b'.repeat(40) } })
  assert.equal(vm().progress.phase, 'comparing')
  const facts = c.artifact('facts-diff.json', { control: [], candidate: [{ kind: 'changed', key: 'body/a[1]@href', was: 'x', now: 'y', step: '1:click', i: 1 }] })
  c.claim('verified_fact', 'one value changed', { evidence: [facts] })
  c.event('test.exported', { id: 'R1' })
  assert.deepEqual([vm().progress.phase, vm().sub], ['testing', 'Running the test on fresh installs, 0 of 6 done'])
  for (let i = 0; i < 4; i++) c.event('test.run', { ref: 'r', n: i, outcome: 'passed' })
  assert.match(vm().sub, /4 of 6 done/)
  for (let i = 0; i < 2; i++) c.event('test.run', { ref: 'r', n: i, outcome: 'failed' })
  const spec = c.artifact('R1.spec.js', 'x'); c.claim('reproduced_failure', 'fails on new', { evidence: [spec] })
  assert.equal(vm().progress.phase, 'searching'); assert.match(vm().sub, /Starting the search/)
  c.event('bisect.started', { changes: 100 })
  assert.match(vm().sub, /Searching 100 code changes: step 1, 100 still possible/)
  c.event('bisect.step', { step: 1, sha: 'aaaaaaa', index: 50, verdict: 'good', goodThrough: 50, badFrom: 100, changes: 100 })
  c.event('bisect.step', { step: 2, sha: 'bbbbbbb', index: 75, verdict: 'bad', goodThrough: 50, badFrom: 75, changes: 100 })
  assert.match(vm().sub, /step 3, 25 still possible/)
  const f = vm().progress.fraction; assert.ok(f > 0.4 && f < 0.9, 'the fraction moves through the search')
  c.event('bisect.verifying', { commit: 'ccccccc', runs: 3 })
  assert.equal(vm().progress.phase, 'verifying')
  c.event('case.closed', { outcome: 'regression proven' })
  assert.equal(vm().progress, null); assert.equal(vm().verdict, 'hold')
})

test('with several exported tests the progress counts every one, and only confirmed tests are counted as proven', () => {
  const { c, vm } = growing()
  c.event('builds.compared', { good: { ref: '1.0', sha: 'a'.repeat(40) }, candidate: { ref: '2.0', sha: 'b'.repeat(40) } })
  const facts = c.artifact('facts-diff.json', { control: [], candidate: [{ kind: 'changed', key: 'body/a[1]@href', was: 'x', now: 'y', step: '1:click', i: 1 }] })
  c.claim('verified_fact', 'two values changed', { evidence: [facts] })
  c.event('test.exported', { id: 'R1' }); c.event('test.exported', { id: 'R2' })
  assert.match(vm().sub, /0 of 12 done/)
  const spec = c.artifact('R1.spec.js', 'x'); c.claim('reproduced_failure', 'R1 fails on new', { evidence: [spec] })
  c.event('test.judged', { id: 'R1', verdict: 'confirmed' }); c.event('test.judged', { id: 'R2', verdict: 'unstable' })
  c.event('case.closed', { outcome: 'regression proven' })
  assert.match(vm().sub, /^1 reproduced behaviour change(?!s)/)
})

test('while a search is running only the commits actually tested are drawn, with no culprit yet', () => {
  const { c, vm } = growing()
  c.event('builds.compared', { good: { ref: '1.0', sha: 'a'.repeat(40) }, candidate: { ref: '2.0', sha: 'b'.repeat(40) } })
  c.event('bisect.started', { changes: 100 })
  c.event('bisect.step', { step: 1, sha: 'aaaaaaa', index: 50, verdict: 'good', goodThrough: 50, badFrom: 100, changes: 100 })
  c.event('bisect.step', { step: 2, sha: 'bbbbbbb', index: 75, verdict: 'bad', goodThrough: 50, badFrom: 75, changes: 100 })
  c.event('bisect.step', { step: 3, sha: 'ccccccc', index: 60, verdict: 'skip', why: 'build failed', goodThrough: 50, badFrom: 75, changes: 100 })
  const b = vm().bisect
  assert.equal(b.partial, true); assert.equal(b.changes, 100)
  assert.deepEqual(b.nodes.map(n => [n.hash, n.verdict, n.tested]), [['aaaaaaa', 'good', true], ['bbbbbbb', 'bad', true]], 'tested only, a skipped commit is not drawn')
  assert.equal(vm().culpritClaimId, null)
})

test('structured search events give the same picture as the finished record', () => {
  const c = openCase(mkdtempSync(join(tmpdir(), 'vm-')))
  c.event('case.opened', { goodRef: '1.0', candRef: '2.0', adapter: 'freshrss', steps: [], scenario: null })
  c.event('builds.compared', { good: { ref: '1.0', sha: 'a'.repeat(40) }, candidate: { ref: '2.0', sha: 'b'.repeat(40) } })
  c.event('bisect.started', { changes: 100 })
  for (const [step, index, verdict, g, b] of [[1, 50, 'good', 50, 100], [2, 75, 'bad', 50, 75], [3, 62, 'bad', 50, 62], [4, 56, 'good', 56, 62], [5, 59, 'good', 59, 62], [6, 60, 'good', 60, 62], [7, 61, 'good', 61, 62]]) c.event('bisect.step', { step, sha: 's' + index, index, verdict, goodThrough: g, badFrom: b, changes: 100 })
  const bis = c.artifact('bisect.json', { result: { conclusive: true, verified: true, commit: 'cccccccfff', subject: 'Fix (#12)', changes: 100, steps: 7, files: [] }, log: [] })
  const spec = c.artifact('R1.spec.js', 'x'); c.claim('reproduced_failure', 'first bad change. The change just before it passed 3 of 3 runs and it failed 3 of 3 runs.', { evidence: [bis, spec] })
  c.event('case.closed', { outcome: 'regression proven' })
  const b = buildViewModel(c, { caseId: 'x' }).bisect
  assert.equal(b.nodes.filter(n => n.verdict === 'culprit').length, 1); assert.equal(b.nodes.find(n => n.verdict === 'culprit').index, 62)
  assert.equal(b.nodes.filter(n => n.tested).length, 7)
})

test('a cancelled run reads as evidence incomplete, and says it was cancelled', () => {
  const { c, vm } = growing()
  c.event('case.closed', { outcome: 'cancelled' })
  assert.deepEqual([vm().verdict, vm().sub, vm().progress], ['fail', 'Run cancelled, evidence incomplete', null])
})

test('a run cancelled mid-search still recommends HOLD (the change was proven) but never claims the search finished', () => {
  const { c, vm } = growing()
  c.event('builds.compared', { good: { ref: '1.0', sha: 'a'.repeat(40) }, candidate: { ref: '2.0', sha: 'b'.repeat(40) } })
  const spec = c.artifact('R1.spec.js', 'x'); c.event('test.exported', { id: 'R1' }); c.claim('reproduced_failure', 'fails on new', { evidence: [spec] })
  c.event('bisect.started', { changes: 227 }); c.event('bisect.step', { step: 1, sha: 'aaaaaaa', index: 113, verdict: 'bad', goodThrough: 0, badFrom: 113, changes: 227 })
  c.event('case.closed', { outcome: 'cancelled' })
  assert.equal(vm().verdict, 'hold'); assert.equal(vm().sub, '1 reproduced behaviour change, search cancelled after 1 step'); assert.ok(vm().startedAt)
})

test('a failed run says why, in words taken from the record, not from the last claim', () => {
  const why = o => { const c = report({ proven: false, outcome: o }); return buildViewModel(c, { caseId: 'x' }).failReason }
  assert.match(why('cancelled'), /cancelled before it finished/)
  assert.match(why('masking not trustworthy'), /cannot be trusted/)
  assert.equal(buildViewModel(report(), { caseId: 'x' }).failReason, null, 'only a failed run has a reason')
})

test('a report says which app it belongs to, so the sidebar can filter reports', () => {
  assert.equal(buildViewModel(report(), { caseId: 'x' }).appId, 'freshrss')
})
