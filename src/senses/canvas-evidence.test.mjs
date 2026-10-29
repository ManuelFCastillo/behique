// node --test src/senses/canvas-evidence.test.mjs   (offline: synthetic traces and tiny pictures, no browser)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCase, summarize } from '../release/evidence.mjs'
import { buildViewModel } from '../release/viewmodel.mjs'
import { blank, encode, paint } from './pixels.mjs'
import { classify, recordCanvasCase } from './canvas-evidence.mjs'

const V = 'verified', N = 'no_change', E = 'changed_elsewhere', C = 'changed'

test('a step is a regression only when it fails every run on the candidate and passes every run on the good version', () => {
  assert.equal(classify([V, V, V], [N, N, N]), 'regression')
  assert.equal(classify([C, V], [E, E]), 'regression')
  assert.equal(classify([N, N], [N, N]), 'fails_both')
  assert.equal(classify([V, V], [N, V]), 'unstable')      // fails in some candidate runs only
  assert.equal(classify([V, N], [N, N]), 'unstable')      // the good version is mixed
  assert.equal(classify([V, V], [N, E]), 'unstable')      // two different failures
  assert.equal(classify([V, V], [V, C]), 'pass')
  assert.equal(classify(['skipped_blank'], ['skipped_blank']), 'skipped')
})

/** A fake trace on disk: one step per verdict list, each with before/after/diff pictures. */
function fakeTrace(root, name, perStep) {
  const dir = join(root, name); mkdirSync(dir, { recursive: true })
  const steps = perStep.map((runs, i) => {
    const skipped = runs[0].startsWith('skipped')
    // every picture gets its own bytes: the store names evidence by content, so identical files would share one name
    if (!skipped) ['before', 'after', 'diff'].forEach((w, k) => writeFileSync(join(dir, `s${i}-${w}.png`), encode(paint(blank(8, 5), { x: i, y: k, w: 1, h: 1 }, [name === 'good' ? 0 : 255, 0, 0, 255]))))
    return { type: 'step', i, label: `control ${i}`, kind: i === 2 ? 'slider' : 'button', action: i === 2 ? { type: 'drag', from: { x: 10, y: 20 }, to: { x: 30, y: 20 } } : { type: 'click_at', x: 10 + i, y: 20 }, expectRegion: i === 1 ? { x: 0, y: 0, w: 10, h: 10 } : null, verdict: runs[0], skipped, changed: runs[0] === N ? 0 : 120, inRegion: i === 1 ? 0 : null, files: skipped ? null : { before: `s${i}-before.png`, after: `s${i}-after.png`, diff: `s${i}-diff.png` } }
  })
  writeFileSync(join(dir, 'trace.json'), JSON.stringify({ variant: name, steps, verdicts: perStep.map(r => r[0]), replayVerdicts: [0, 1].map(k => perStep.map(r => r[k + 1])) }))
  return dir
}
function setup(good, cand) {
  const root = mkdtempSync(join(tmpdir(), 'canvas-ev-'))
  writeFileSync(join(root, 'shot.png'), encode(blank(8, 5)))
  writeFileSync(join(root, 'proposals.json'), JSON.stringify([{ label: 'a', kind: 'button', point: [0.1, 0.1] }]))
  return { root, evidenceRoot: join(root, 'evidence'), goodDir: fakeTrace(root, 'good', good), candDir: fakeTrace(root, 'cand', cand), screenshot: join(root, 'shot.png'), proposals: join(root, 'proposals.json'), model: 'test-model-1', provenance: { source: 'unit test' } }
}
const read = (a, r) => { const c = openCase(join(a.evidenceRoot, r.caseId)); return { c, events: c.read(), s: summarize(c.read()) } }

test('a proven step is written as a model guess plus a code-written reproduced failure with its pictures', () => {
  const good = [[V, V, V], [V, V, V], [C, C, C], ['skipped_blank', 'skipped_blank', 'skipped_blank']], cand = [[V, V, V], [N, N, N], [C, C, C], ['skipped_blank', 'skipped_blank', 'skipped_blank']]
  const a = setup(good, cand), r = recordCanvasCase({ ...a, variantId: 'stop-dead', bug: { what: 'The Stop button does nothing.' } })
  assert.equal(r.ok, true); assert.deepEqual(r.counts, { regression: 1, fails_both: 0, unstable: 0, pass: 2, skipped: 1 })
  const { events, s } = read(a, r)
  const by = l => s.claims.filter(c => c.label === l)
  assert.equal(by('reproduced_failure').length, 1); assert.equal(by('reproduced_failure')[0].by, 'code')
  assert.equal(by('ai_hypothesis').length, 1); assert.equal(by('ai_hypothesis')[0].by, 'model'); assert.equal(by('ai_hypothesis')[0].model, 'test-model-1')
  assert.equal(by('ai_hypothesis')[0].source, 'canvas-vision')
  assert.match(by('reproduced_failure')[0].text, /Step 2: clicking the "control 1" control .* changed nothing on the stop-dead version in 3 of 3 fresh browsers .* the same step changed at the expected spot in 3 of 3/)
  const names = by('reproduced_failure')[0].evidence.map(h => s.artifacts[h].name)
  assert.ok(['step2-candidate-before.png', 'step2-candidate-after.png', 'step2-candidate-diff.png', 'step2-unchanged-after.png', 'candidate-trace.json'].every(n => names.includes(n)), names.join(', '))
  assert.equal(s.artifacts[by('reproduced_failure')[0].evidence[0]].mediaType, 'image/png')
  assert.equal(events.at(-1).type, 'case.closed'); assert.equal(events.at(-1).data.outcome, 'regression proven')
  assert.equal(events.find(e => e.type === 'case.opened').data.kind, 'canvas')
  assert.match(events.find(e => e.type === 'case.opened').data.scenario.about, /The Stop button does nothing/)
})

test('the model can never write the verdict: the store refuses it', () => {
  const a = setup([[V, V, V]], [[V, V, V]]), r = recordCanvasCase({ ...a, variantId: 'clean' })
  const c = openCase(join(a.evidenceRoot, r.caseId)), h = c.read().find(e => e.type === 'artifact').data.hash
  assert.throws(() => c.claim('reproduced_failure', 'x', { by: 'model', model: 'm', evidence: [h] }), /model may not write a reproduced_failure/)
  assert.throws(() => c.claim('verified_fact', 'x', { by: 'model', model: 'm', evidence: [h] }), /model may not write/)
})

test('a drag step names its start point, and a step that fails on both versions is not called a change', () => {
  const good = [[V, V, V], [N, N, N], [V, V, V]], cand = [[V, V, V], [N, N, N], [N, V, N]]
  const a = setup(good, cand), r = recordCanvasCase({ ...a, variantId: 'card-offset' })
  assert.deepEqual(r.counts, { regression: 0, fails_both: 1, unstable: 1, pass: 1, skipped: 0 })
  const { events, s } = read(a, r)
  assert.equal(s.claims.filter(c => c.label === 'reproduced_failure').length, 0)
  assert.match(s.claims.find(c => /on both the unchanged test app and/.test(c.text)).text, /control 1.*so it is not a difference between the versions/)
  assert.equal(events.at(-1).data.outcome, 'no candidate defects')
})

test('a clean copy against a clean copy yields no finding, a ship recommendation and an intact record', () => {
  const ok = [[V, V, V], [C, C, C], [C, C, C]]
  const a = setup(ok, ok), r = recordCanvasCase({ ...a, variantId: 'clean' })
  assert.deepEqual(r.counts, { regression: 0, fails_both: 0, unstable: 0, pass: 3, skipped: 0 })
  const c = openCase(join(a.evidenceRoot, r.caseId)), vm = buildViewModel(c, { caseId: r.caseId })
  assert.equal(vm.verdict, 'ship'); assert.equal(vm.chain.ok, true)
  assert.match(vm.title, /the unchanged test app/)
})

test('the dashboard view of a proven canvas case recommends hold and labels the model\'s part as a guess', () => {
  const a = setup([[V, V, V], [V, V, V]], [[V, V, V], [N, N, N]]), r = recordCanvasCase({ ...a, variantId: 'stop-dead' })
  const vm = buildViewModel(openCase(join(a.evidenceRoot, r.caseId)), { caseId: r.caseId })
  assert.equal(vm.verdict, 'hold')
  const guess = vm.claims.find(k => k.kind === 'ai_hypothesis'), fact = vm.claims.find(k => k.kind === 'reproduced_failure')
  assert.match(guess.foot, /a model's guess about what is on the screen/); assert.ok(guess.chips.includes('unproven'))
  assert.equal(fact.actor, 'code')
})
