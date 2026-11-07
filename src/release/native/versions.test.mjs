// node --test src/release/native/versions.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareVersion, stepsKey } from './versions.mjs'

function repoWithTwoCommits() {
  const repo = mkdtempSync(join(tmpdir(), 'native-repo-'))
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString().trim()
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T')
  writeFileSync(join(repo, 'v.txt'), '1'); git('add', '.'); git('commit', '-qm', 'one'); git('tag', 'v1')
  writeFileSync(join(repo, 'v.txt'), '2'); git('commit', '-qam', 'two'); git('tag', 'v2')
  return repo
}

// The "build" copies v.txt into the build folder and counts how many times it ran, so reuse is visible.
const profile = repo => ({
  kind: 'command', name: 'fake', repo,
  build: { dir: 'build', steps: [['node', '-e', 'const fs=require("fs");fs.writeFileSync("out.txt",fs.readFileSync("../v.txt"));fs.appendFileSync("count.txt","x")']] },
  cases: [{ id: 'a', command: ['node', '-e', '0'] }],
})

test('each ref is built in its own worktree, by sha', async () => {
  const repo = repoWithTwoCommits(), workRoot = mkdtempSync(join(tmpdir(), 'native-wt-'))
  const a = await prepareVersion(profile(repo), 'v1', { workRoot }), b = await prepareVersion(profile(repo), 'v2', { workRoot })
  assert.ok(a.ok && b.ok)
  assert.notEqual(a.sha, b.sha)
  assert.equal(readFileSync(join(a.build, 'out.txt'), 'utf8'), '1')
  assert.equal(readFileSync(join(b.build, 'out.txt'), 'utf8'), '2')
})

test('a finished build is reused; changed build steps rebuild', async () => {
  const repo = repoWithTwoCommits(), workRoot = mkdtempSync(join(tmpdir(), 'native-wt-'))
  const p = profile(repo)
  const first = await prepareVersion(p, 'v1', { workRoot })
  const again = await prepareVersion(p, 'v1', { workRoot })
  assert.equal(again.reused, true)
  assert.equal(readFileSync(join(first.build, 'count.txt'), 'utf8'), 'x')
  const changed = { ...p, build: { ...p.build, steps: [...p.build.steps, ['node', '-e', '0']] } }
  assert.notEqual(stepsKey(p), stepsKey(changed))
  const rebuilt = await prepareVersion(changed, 'v1', { workRoot })
  assert.equal(rebuilt.reused, false)
  assert.equal(readFileSync(join(first.build, 'count.txt'), 'utf8'), 'xx')
})

test('a failed build is reported and never reused', async () => {
  const repo = repoWithTwoCommits(), workRoot = mkdtempSync(join(tmpdir(), 'native-wt-'))
  const p = { ...profile(repo), build: { dir: 'build', steps: [['node', '-e', 'process.exit(2)']] } }
  const r = await prepareVersion(p, 'v1', { workRoot })
  assert.equal(r.ok, false)
  assert.equal((await prepareVersion(p, 'v1', { workRoot })).reused, false)
  assert.ok(existsSync(join(r.build, '.behique-build.json')))
})

test('an unknown ref is an error', async () => {
  const repo = repoWithTwoCommits()
  await assert.rejects(prepareVersion(profile(repo), 'no-such-ref', { workRoot: mkdtempSync(join(tmpdir(), 'native-wt-')) }))
})
