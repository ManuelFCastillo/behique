// node --test src/release/native/cli.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openCase } from '../evidence.mjs'
import { isCommandProfile, runNativeCheck } from './cli.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FAKE = readFileSync(join(ROOT, 'src', 'release', 'native', 'fixtures', 'fake-model.mjs'), 'utf8')

/** A git repo whose v1 prints the real error and whose v2 hides it, like WindNinja #348. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'native-cli-repo-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T')
  writeFileSync(join(dir, 'model.mjs'), FAKE); git('add', '.'); git('commit', '-qm', 'good'); git('tag', 'v1')
  writeFileSync(join(dir, 'model.mjs'), FAKE.replace("console.error('Exception caught: The grid does not contain any values.')", "console.error('Exception caught: std::exception')"))
  git('commit', '-qam', 'hide the error'); git('tag', 'v2')
  return dir
}

const profile = r => ({
  kind: 'command', name: 'fake', repo: r,
  build: { dir: 'build', steps: [['node', '-e', '0']] },
  cases: [
    { id: 'base', command: ['node', '{src}/model.mjs', '{run}/run.cfg'], files: { 'run.cfg': 'speed = 5\n' }, outputs: ['*.asc'] },
    { id: 'nodata', command: ['node', '{src}/model.mjs', '{run}/run.cfg'], files: { 'run.cfg': 'fail = clear\n' }, outputs: ['*.asc'] },
  ],
  noise: { lines: ['seconds\\.$'] },
})

test('command profiles are told apart from web profiles', () => {
  assert.equal(isCommandProfile({ kind: 'command' }), true)
  assert.equal(isCommandProfile({ serve: { kind: 'static' } }), false)
  assert.equal(isCommandProfile(null), false)
})

test('the profile is validated before anything runs', async () => {
  await assert.rejects(runNativeCheck({ kind: 'command', name: 'x' }, 'v1', 'v2', { outRoot: mkdtempSync(join(tmpdir(), 'o-')) }), /not valid/)
})

// Build steps must start with a real build tool; `cmake -E` gives portable no-op and compare steps for the tests.
let haveCmake = true
try { execFileSync('cmake', ['--version'], { stdio: 'pipe' }) } catch { haveCmake = false }
const needsCmake = { skip: haveCmake ? false : 'cmake is not installed' }

test('two refs end to end: HOLD with exit code 1, a report, and a verifiable record', needsCmake, async () => {
  const r = repo(), outRoot = mkdtempSync(join(tmpdir(), 'native-out-'))
  const p = { ...profile(r), build: { dir: 'build', steps: [['cmake', '-E', 'true']] } }
  const run = await runNativeCheck(p, 'v1', 'v2', { outRoot })
  assert.equal(run.result.recommendation, 'hold')
  assert.equal(run.exitCode, 1)
  assert.match(run.markdown, /^## Behique: HOLD for fake v1 → v2/)
  assert.match(run.markdown, /`Exception caught: The grid does not contain any values.`/)
  assert.match(run.markdown, /confirmed: good passed 3\/3, candidate failed 3\/3/)
  assert.ok(existsSync(join(run.caseDir, 'result.json')))
  assert.ok(openCase(run.caseDir).verify().ok)
})

test('--bisect names the commit that hid the error and records it', needsCmake, async () => {
  const r = repo(), outRoot = mkdtempSync(join(tmpdir(), 'native-out-'))
  // one unrelated commit after v2, so the search has more than one change to look at
  writeFileSync(join(r, 'README'), 'docs'); execFileSync('git', ['-C', r, 'add', '.'], { stdio: 'pipe' }); execFileSync('git', ['-C', r, 'commit', '-qm', 'docs'], { stdio: 'pipe' })
  const p = { ...profile(r), build: { dir: 'build', steps: [['cmake', '-E', 'true']] } }
  const run = await runNativeCheck(p, 'v1', 'HEAD', { outRoot, bisect: true })
  assert.equal(run.result.recommendation, 'hold')
  const v2 = execFileSync('git', ['-C', r, 'rev-parse', 'v2'], { stdio: 'pipe' }).toString().trim()
  assert.equal(run.result.bisect.commit, v2)
  assert.equal(run.result.bisect.verified, true)
  assert.match(run.markdown, /\*\*First bad commit for N1:\*\* `[0-9a-f]{12}` "hide the error"/)
  const ev = openCase(run.caseDir)
  assert.ok(ev.verify().ok)
  assert.ok(ev.read().some(e => e.type === 'claim' && e.data.label === 'reproduced_failure' && /first change behind N1/.test(e.data.text)))
})

test('a candidate that does not build is INCOMPLETE with exit code 3', needsCmake, async () => {
  const r = repo(), outRoot = mkdtempSync(join(tmpdir(), 'native-out-'))
  // The "build" succeeds only when model.mjs equals v1's copy, so v1 builds and v2 does not.
  const v1Copy = join(mkdtempSync(join(tmpdir(), 'native-v1-')), 'model.mjs')
  writeFileSync(v1Copy, FAKE)
  const p = { ...profile(r), build: { dir: 'build', steps: [['cmake', '-E', 'compare_files', '{src}/model.mjs', v1Copy]] } }
  const run = await runNativeCheck(p, 'v1', 'v2', { outRoot })
  assert.equal(run.result.recommendation, 'fail')
  assert.equal(run.exitCode, 3)
  assert.deepEqual(run.result.buildFailed, ['cand'])
  assert.match(run.markdown, /\*\*Incomplete:\*\* the candidate did not build/)
  assert.ok(openCase(run.caseDir).verify().ok)
})
