// node --test src/release/native/bisect.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyNative, nativeBisect } from './bisect.mjs'

const FAKE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-model.mjs'), 'utf8')
const REAL = "console.error('Exception caught: The grid does not contain any values.')"
const GENERIC = "console.error('Exception caught: std::exception')"

/**
 * A history built from steps: each step is [message, {file: text}], where text null deletes that file.
 * A commit that has a BROKEN file does not build (see the profile below). Returns the commit shas in order.
 */
function history(steps) {
  const dir = mkdtempSync(join(tmpdir(), 'native-bisect-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim()
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T')
  const shas = []
  for (const [msg, files] of steps) {
    for (const [n, t] of Object.entries(files)) { if (t === null) git('rm', '-q', n); else writeFileSync(join(dir, n), t) }
    git('add', '-A'); git('commit', '-qm', msg); shas.push(git('rev-parse', 'HEAD'))
  }
  return { dir, shas }
}

// The build creates a folder inside {src}/BROKEN: that fails exactly when BROKEN is a file, i.e. on a broken commit.
const profileFor = dir => ({
  kind: 'command', name: 'fake', repo: dir,
  build: { dir: 'build', steps: [['cmake', '-E', 'make_directory', '{src}/BROKEN/x']] },
  cases: [{ id: 'nodata', command: ['node', '{src}/model.mjs', '{run}/run.cfg'], files: { 'run.cfg': 'fail = clear\n' } }],
  noise: { lines: ['seconds\\.$'] },
})
const finding = { case: 'nodata', key: 'final', good: 'Exception caught: The grid does not contain any values.', cand: 'Exception caught: std::exception' }

let haveCmake = true
try { execFileSync('cmake', ['--version'], { stdio: 'pipe' }) } catch { haveCmake = false }

test('one commit is classified by the value of the proven fact only', () => {
  const f = { good: 'real error', cand: 'std::exception' }
  assert.deepEqual(classifyNative('real error', f), { verdict: 'good' })
  assert.deepEqual(classifyNative('std::exception', f), { verdict: 'bad' })
  assert.equal(classifyNative('something else', f).verdict, 'skip')
  assert.deepEqual(classifyNative(null, { good: null, cand: '1' }), { verdict: 'good' }) // a fact that must be absent
})

const needsCmake = { skip: haveCmake ? false : 'cmake is not installed' }

test('finds and verifies the commit that hid the error, stepping past a commit that does not build', needsCmake, async () => {
  // Searched changes: #1 unrelated, #2 broken build, #3 fixes the build, #4 hides the error, #5 unrelated.
  // The first pick is #2 (the middle), which cannot build: it must be skipped, not counted as good or bad.
  const h = history([
    ['c0 good', { 'model.mjs': FAKE }],
    ['c1 unrelated', { README: 'docs' }],
    ['c2 broken build', { BROKEN: '1' }],
    ['c3 fix the build', { BROKEN: null }],
    ['c4 hide the error', { 'model.mjs': FAKE.replace(REAL, GENERIC) }],
    ['c5 unrelated', { README: 'more docs' }],
  ])
  const logs = []
  const r = await nativeBisect(profileFor(h.dir), finding, { goodRef: h.shas[0], candRef: h.shas.at(-1), workRoot: mkdtempSync(join(tmpdir(), 'native-bwt-')), log: l => logs.push(l) })
  assert.ok(logs.some(l => /c2 broken build/.test(l) && /skip \(build failed\)/.test(l)), 'the broken commit was tested and skipped')
  assert.equal(r.conclusive, true)
  assert.equal(r.verified, true)
  assert.equal(r.commit, h.shas[4])
  assert.equal(r.subject, 'c4 hide the error')
})

test('a broken build right before the culprit makes the answer a range, not a guess', needsCmake, async () => {
  // #2 cannot build and #3 both fixes it and hides the error: the first bad change is #2 or #3, and nothing can tell which.
  const h = history([
    ['c0 good', { 'model.mjs': FAKE }],
    ['c1 unrelated', { README: 'docs' }],
    ['c2 broken build', { BROKEN: '1' }],
    ['c3 fix the build and hide the error', { BROKEN: null, 'model.mjs': FAKE.replace(REAL, GENERIC) }],
    ['c4 unrelated', { README: 'more docs' }],
  ])
  const r = await nativeBisect(profileFor(h.dir), finding, { goodRef: h.shas[0], candRef: h.shas.at(-1), workRoot: mkdtempSync(join(tmpdir(), 'native-bwt-')) })
  assert.equal(r.conclusive, false)
  assert.deepEqual(r.range, [2, 3], 'the first bad change is #2 or #3 of the searched changes')
})
