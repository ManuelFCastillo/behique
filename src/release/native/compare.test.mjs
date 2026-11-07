// node --test src/release/native/compare.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compareRecordings, rankOf, recordVersion, stableFacts } from './compare.mjs'

const FAKE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-model.mjs'), 'utf8')

/** A checkout holding the fake program, optionally edited the way a candidate version would be. */
function checkout(edit = s => s) {
  const src = mkdtempSync(join(tmpdir(), 'native-src-'))
  writeFileSync(join(src, 'model.mjs'), edit(FAKE))
  return src
}

const profile = (cases, noise = {}) => ({
  kind: 'command', name: 'fake', repo: '/x', build: { dir: 'build', steps: [['make']] },
  cases: cases.map(([id, cfg]) => ({ id, command: ['node', '{src}/model.mjs', '{run}/run.cfg'], files: { 'run.cfg': cfg }, outputs: ['*.asc'] })),
  noise: { lines: ['seconds\\.$'], ...noise },
})

const record = (p, src, runs = 2) => recordVersion(p, { src, build: join(src, 'build'), workDir: mkdtempSync(join(tmpdir(), 'native-work-')), runs })

test('stable facts and masked noise', () => {
  const r = stableFacts([{ a: '1', b: '2', c: 'x' }, { a: '1', b: '3' }])
  assert.deepEqual(r.stable, { a: '1' })
  assert.deepEqual(r.masked, ['b', 'c'])
})

test('ranking puts what a person sees first', () => {
  assert.ok(rankOf('exit').rank < rankOf('final').rank)
  assert.ok(rankOf('final').rank < rankOf('message:x').rank)
  assert.ok(rankOf('probe:x').rank < rankOf('grid:a.asc:stats').rank)
  assert.ok(rankOf('grid:a.asc:stats').rank < rankOf('file:a.asc').rank)
})

test('the same version twice shows no differences', async () => {
  const p = profile([['base', 'speed = 5\n'], ['nodata', 'fail = clear\n']])
  const src = checkout()
  const a = await record(p, src), b = await record(p, src)
  const cmp = compareRecordings(a, b)
  assert.deepEqual(cmp.diffs, [])
  assert.deepEqual(a.cases.base.masked, [], 'the timing line is dropped by the noise rule, so nothing else varies')
})

test('a changed error message and changed values are found and ranked', async () => {
  const p = profile([['base', 'speed = 5\n'], ['nodata', 'fail = clear\n']])
  const good = await record(p, checkout())
  const cand = await record(p, checkout(s => s
    .replace("console.error('Exception caught: The grid does not contain any values.')", "console.error('Exception caught: std::exception')")
    .replace('(speed + r * 0.5 + c * 0.25)', '(speed + r * 0.5 + c * 0.25 + (r === 2 && c === 3 ? 1 : 0))')))
  const cmp = compareRecordings(good, cand)
  const keys = cmp.diffs.map(d => `${d.case} ${d.kind} ${d.key}`)
  assert.deepEqual(keys, [
    'nodata changed final',
    'nodata added message:Exception caught: std::exception',
    'nodata removed message:Exception caught: The grid does not contain any values.',
    'base changed grid:grid_vel.asc:stats',
    'base changed file:grid_vel.asc',
  ])
  const file = cmp.diffs.find(d => d.key === 'file:grid_vel.asc')
  assert.equal(file.cls, 'output')
  assert.equal(file.grid.changed, 1)
  assert.deepEqual(file.grid.where, { row: 2, col: 3, good: 6.75, cand: 7.75 })
})

test('a file whose bytes change but whose values do not is churn', async () => {
  const p = profile([['base', 'speed = 5\n']])
  const good = await record(p, checkout(), 1)
  const cand = await record(p, checkout(s => s.replace('.toFixed(2)', '.toFixed(3)')), 1)
  const [d] = compareRecordings(good, cand).diffs
  assert.equal(d.key, 'file:grid_vel.asc')
  assert.equal(d.cls, 'churn')
})

test('a file named with a timestamp is masked as noise, unless a name rule normalizes it', async () => {
  const cfg = 'speed = 5\nstamp = yes\n'
  const src = checkout()
  const raw = await record(profile([['base', cfg]]), src)
  assert.ok(raw.cases.base.masked.some(k => k.startsWith('file:grid_')), 'each run wrote a differently named file')
  const named = await record(profile([['base', cfg]], { names: [['_\\d{13}', '_<time>']] }), src)
  assert.deepEqual(named.cases.base.masked, [])
  assert.ok('file:grid_<time>_vel.asc' in named.cases.base.stable)
})
