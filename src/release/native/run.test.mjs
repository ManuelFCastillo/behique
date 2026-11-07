// node --test src/release/native/run.test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateCommandProfile, expand, safeRelative } from './profile.mjs'
import { buildCheckout, globToRegex, runArgv, runCase } from './run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'fixtures', 'fake-model.mjs')

const profile = (over = {}) => ({
  kind: 'command',
  name: 'fake',
  repo: '/tmp/x',
  build: { dir: 'build', steps: [['cmake', '{src}'], ['make', '-j4']] },
  env: { FAKE_DATA: '{src}/data' },
  cases: [{ id: 'base', command: ['node', FAKE, '{run}/run.cfg'], files: { 'run.cfg': 'speed = 5\n' }, outputs: ['*.asc'] }],
  ...over,
})

test('a valid command profile has no problems', () => {
  assert.deepEqual(validateCommandProfile(profile()), [])
})

test('profile validation refuses what a shell or an accident could abuse', () => {
  const bad = (over, re) => assert.ok(validateCommandProfile(profile(over)).some(m => re.test(m)), `expected ${re}`)
  bad({ kind: 'web' }, /"kind" must be "command"/)
  bad({ name: 'Wind Ninja' }, /"name"/)
  bad({ build: { dir: '../out', steps: [['make']] } }, /build\.dir/)
  bad({ build: { dir: 'build', steps: ['make -j4 && rm -rf /'] } }, /list of strings/)
  bad({ build: { dir: 'build', steps: [['bash', '-c', 'make']] } }, /not a known build tool/)
  bad({ build: { dir: 'build', steps: [['make', '{home}']] } }, /unknown placeholder \{home\}/)
  bad({ cases: [{ id: 'a', command: ['/bin/sh', '-c', 'x'] }] }, /program must start with \{build\}/)
  bad({ cases: [{ id: 'a', command: ['{build}/../../bin/sh'] }] }, /may not contain/)
  bad({ cases: [{ id: 'a', command: ['node', 'x'], files: { '../escape.cfg': 'x' } }] }, /relative path inside the run folder/)
  bad({ cases: [{ id: 'a', command: ['node', 'x'] }, { id: 'a', command: ['node', 'y'] }] }, /used twice/)
  bad({ cases: [{ id: 'a', command: ['node', 'x'], timeoutMs: -1 }] }, /timeoutMs/)
  bad({ noise: { lines: ['('] } }, /not a valid pattern/)
  bad({ env: { 'bad-name': 'x' } }, /not a valid variable name/)
  bad({ extra: 1 }, /unknown field "extra"/)
})

test('placeholders and safe paths', () => {
  assert.equal(expand('{src}/a {build} {run}/x {other}', { src: '/s', build: '/b', run: '/r' }), '/s/a /b /r/x {other}')
  assert.ok(safeRelative('run.cfg') && safeRelative('in/run.cfg'))
  assert.ok(!safeRelative('/etc/passwd') && !safeRelative('../x') && !safeRelative('a/../../x') && !safeRelative('C:\\x'))
})

test('glob patterns match relative paths', () => {
  assert.ok(globToRegex('*.asc').test('grid_vel.asc'))
  assert.ok(!globToRegex('*.asc').test('sub/grid_vel.asc'))
  assert.ok(globToRegex('**/*.asc').test('sub/deep/grid.asc'))
  assert.ok(globToRegex('*_vel.asc').test('a_vel.asc') && !globToRegex('*_vel.asc').test('a_ang.asc'))
})

test('a case runs in a fresh folder; outputs are collected, inputs are not', async () => {
  const p = profile(), runDir = join(mkdtempSync(join(tmpdir(), 'native-')), 'run')
  const r = await runCase(p, p.cases[0], { src: '/tmp/src', build: '/tmp/build', runDir })
  assert.equal(r.exitCode, 0)
  assert.equal(r.timedOut, false)
  assert.deepEqual(Object.keys(r.outputs), ['grid_vel.asc'])
  assert.match(r.outputs['grid_vel.asc'].toString(), /^ncols 4\n/)
  assert.match(r.stdout, /Run number 0 done!/)
  assert.equal(readFileSync(join(runDir, 'run.cfg'), 'utf8'), 'speed = 5\n')
  // a second run starts from an empty folder
  const again = await runCase(p, { ...p.cases[0], files: { 'run.cfg': 'fail = clear\n' } }, { src: '/tmp/src', build: '/tmp/build', runDir })
  assert.equal(again.exitCode, 255)
  assert.deepEqual(Object.keys(again.outputs), [])
  assert.match(again.stderr, /does not contain any values/)
})

test('placeholders in input files point at the run folder', async () => {
  const p = profile({ cases: [{ id: 'echo', command: ['node', '-e', 'console.log(require("fs").readFileSync(process.argv[1], "utf8"))', '{run}/in.txt'], files: { 'in.txt': 'run={run} src={src}' } }] })
  const runDir = join(mkdtempSync(join(tmpdir(), 'native-')), 'run')
  const r = await runCase(p, p.cases[0], { src: '/s', build: '/b', runDir })
  assert.equal(r.stdout.trim(), `run=${runDir} src=/s`)
})

test('a case that runs too long is stopped and says so', async () => {
  const r = await runArgv(['node', '-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 })
  assert.equal(r.timedOut, true)
  assert.notEqual(r.exitCode, 0)
})

test('a program that does not exist is reported, not thrown', async () => {
  const r = await runArgv(['/nonexistent/program'], {})
  assert.equal(r.exitCode, null)
  assert.ok(r.spawnError)
})

test('a build stops at the first failing step', async () => {
  const src = mkdtempSync(join(tmpdir(), 'native-src-'))
  const p = profile({ build: { dir: 'build', steps: [['node', '-e', 'require("fs").writeFileSync("made.txt", "1")'], ['node', '-e', 'process.exit(3)'], ['node', '-e', 'require("fs").writeFileSync("never.txt", "1")']] } })
  const r = await buildCheckout(p, src)
  assert.equal(r.ok, false)
  assert.deepEqual(r.steps.map(s => s.exitCode), [0, 3])
  assert.ok(existsSync(join(src, 'build', 'made.txt')))
  assert.ok(!existsSync(join(src, 'build', 'never.txt')))
})
