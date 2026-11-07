// node --test src/release/native/check.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openCase, summarize } from '../evidence.mjs'
import { checkVersions } from './check.mjs'
import { judge, recommend } from './confirm.mjs'

const FAKE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-model.mjs'), 'utf8')
const checkout = (edit = s => s) => {
  const src = mkdtempSync(join(tmpdir(), 'native-src-'))
  writeFileSync(join(src, 'model.mjs'), edit(FAKE))
  return { src, build: join(src, 'build') }
}
const profile = {
  kind: 'command', name: 'fake', repo: '/x', build: { dir: 'build', steps: [['make']] },
  cases: [
    { id: 'base', command: ['node', '{src}/model.mjs', '{run}/run.cfg'], files: { 'run.cfg': 'speed = 5\n' }, outputs: ['*.asc'] },
    { id: 'nodata', command: ['node', '{src}/model.mjs', '{run}/run.cfg'], files: { 'run.cfg': 'fail = clear\n' }, outputs: ['*.asc'] },
  ],
  noise: { lines: ['seconds\\.$'] },
}
const dirs = () => ({ caseDir: mkdtempSync(join(tmpdir(), 'native-case-')), workDir: mkdtempSync(join(tmpdir(), 'native-work-')) })
const GENERIC = s => s.replace("console.error('Exception caught: The grid does not contain any values.')", "console.error('Exception caught: std::exception')")

test('judging a test from its outcomes', () => {
  assert.equal(judge([true, true, true], [false, false, false]).verdict, 'confirmed')
  assert.equal(judge([true, true, true], [true, true, true]).verdict, 'not_reproduced')
  assert.equal(judge([true, true, true], [false, true, false]).verdict, 'unstable')
  assert.equal(judge([true, false, true], [false, false, false]).verdict, 'unstable')
})

test('the recommendation is computed from the evidence alone', () => {
  const real = { cls: 'notice' }, churn = { cls: 'churn' }
  assert.equal(recommend({ judged: [], diffs: [], incomplete: false }), 'ship')
  assert.equal(recommend({ judged: [], diffs: [churn], incomplete: false }), 'ship')
  assert.equal(recommend({ judged: [{ verdict: 'unstable', cls: 'notice' }], diffs: [real], incomplete: false }), 'inconclusive')
  assert.equal(recommend({ judged: [{ verdict: 'confirmed', cls: 'notice' }], diffs: [real], incomplete: false }), 'hold')
  assert.equal(recommend({ judged: [{ verdict: 'confirmed', cls: 'notice' }], diffs: [real], incomplete: true }), 'fail')
})

test('same version against itself: ship, with nothing to prove', async () => {
  const v = checkout(), d = dirs()
  const r = await checkVersions(profile, { good: v, cand: v }, d)
  assert.equal(r.recommendation, 'ship')
  assert.deepEqual(r.findings, [])
  assert.ok(openCase(d.caseDir).verify().ok)
})

test('a candidate that hides the real error is held, with the proof in a verifiable record', async () => {
  const d = dirs()
  const r = await checkVersions(profile, { good: { ...checkout(), ref: 'v1' }, cand: { ...checkout(GENERIC), ref: 'v2' } }, d)
  assert.equal(r.recommendation, 'hold')
  assert.deepEqual(r.findings.map(f => `${f.case} ${f.key} ${f.verdict}`), [
    'nodata final confirmed',
    'nodata message:Exception caught: std::exception confirmed',
    'nodata message:Exception caught: The grid does not contain any values. confirmed',
  ])
  const final = r.findings[0]
  assert.equal(final.good, 'Exception caught: The grid does not contain any values.')
  assert.equal(final.cand, 'Exception caught: std::exception')
  assert.deepEqual([final.goodPassed, final.candFailed, final.runs], [3, 3, 3])

  const ev = openCase(d.caseDir)
  assert.ok(ev.verify().ok)
  const s = summarize(ev.read())
  assert.equal(s.opened.mode, 'native')
  assert.equal(s.claims.filter(c => c.label === 'reproduced_failure').length, 3)
  assert.ok(s.claims.every(c => c.by === 'code'))
  assert.equal(ev.read().filter(e => e.type === 'test.run').length, 18) // 3 tests x 2 versions x 3 runs
})

test('a candidate that only sometimes misbehaves is not counted as proven', async () => {
  // The candidate alternates between the real message and the generic one, run by run.
  const flaky = s => s.replace("if (cfg.fail === 'clear') {",
    "const fs = await import('node:fs'); const n = Number(fs.existsSync(process.argv[1] + '.n') ? fs.readFileSync(process.argv[1] + '.n', 'utf8') : 0); fs.writeFileSync(process.argv[1] + '.n', String(n + 1));\nif (cfg.fail === 'clear' && n % 2 === 1) { console.error('Exception caught: std::exception'); process.exit(255) }\nif (cfg.fail === 'clear') {")
  const d = dirs()
  const r = await checkVersions(profile, { good: checkout(), cand: checkout(flaky) }, { ...d, recordRuns: 2 })
  // run 1 shows the real message, run 2 the generic one: the candidate varies where the good version is steady.
  assert.ok(r.masked.byCase.nodata.includes('final'))
  assert.equal(r.recommendation, 'inconclusive', 'a sometimes-wrong candidate is never shipped')
  assert.ok(r.unsteady.some(u => u.case === 'nodata' && u.key === 'final' && u.side === 'cand'))
  assert.equal(r.findings.length, 0, 'nothing that varies is claimed as proven')
})

test('a program that cannot start on the good version means the evidence is incomplete', async () => {
  const p = { ...profile, cases: [{ id: 'gone', command: ['{build}/missing-program'], outputs: [] }] }
  const v = checkout(), d = dirs()
  const r = await checkVersions(p, { good: v, cand: v }, d)
  assert.equal(r.recommendation, 'fail')
  assert.deepEqual(r.notStarted, ['gone'])
})
