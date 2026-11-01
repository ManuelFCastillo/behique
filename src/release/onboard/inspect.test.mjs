// Tests for inspectRepo: read-only facts, never reads .env, skips failures.
//   node --test src/release/onboard/inspect.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectRepo } from './inspect.mjs'

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

test('collects facts from a git repo without leaking .env or config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-'))
  git(dir, 'init')
  git(dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'first subject')
  git(dir, 'tag', 'v0.1.0')
  git(dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'second subject')
  git(dir, 'tag', 'v0.2.0')
  writeFileSync(join(dir, 'index.html'), '<html></html>')
  const pkg = {
    name: 'demo',
    scripts: { dev: 'vite --port 5173', start: 'node server.js' },
    dependencies: { react: '^1.0.0' },
    devDependencies: { vite: '^2.0.0' },
    config: { secret: 'config-secret-value' }
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  writeFileSync(join(dir, 'README.md'), '# hello\n' + 'x'.repeat(5000))
  writeFileSync(join(dir, '.env'), 'SECRET=env-secret-value')
  return inspectRepo(dir).then((facts) => {
    assert.equal(facts.path, dir)
    assert.equal(facts.isGit, true)
    assert.deepEqual(facts.tags, ['v0.2.0', 'v0.1.0'])
    assert.equal(facts.headSubject, 'second subject')
    assert.ok(typeof facts.branch === 'string' || facts.branch === null)
    assert.ok(facts.topLevel.includes('index.html'))
    assert.ok(facts.topLevel.includes('package.json'))
    assert.ok(!facts.topLevel.includes('.git'))
    assert.deepEqual([...facts.topLevel].sort(), facts.topLevel)
    assert.ok(facts.topLevel.length <= 60)
    assert.equal(facts.packageJson.name, 'demo')
    assert.deepEqual(facts.packageJson.scripts, { dev: 'vite --port 5173', start: 'node server.js' })
    assert.deepEqual(facts.packageJson.dependencies, ['react'])
    assert.deepEqual(facts.packageJson.devDependencies, ['vite'])
    assert.equal(facts.lockfile, 'package-lock.json')
    assert.equal(facts.hasIndexHtml, true)
    assert.equal(facts.hasDockerfile, false)
    assert.equal(facts.hasMakefile, false)
    assert.ok(typeof facts.readme === 'string')
    assert.ok(facts.readme.length <= 3000)
    const blob = JSON.stringify(facts)
    assert.ok(!blob.includes('env-secret-value'))
    assert.ok(!blob.includes('config-secret-value'))
  })
})

test('non git directory does not throw', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-nogit-'))
  writeFileSync(join(dir, 'a.txt'), 'hi')
  const facts = await inspectRepo(dir)
  assert.equal(facts.isGit, false)
  assert.deepEqual(facts.tags, [])
  assert.equal(facts.branch, null)
  assert.equal(facts.headSubject, null)
  assert.deepEqual(facts.recent, [])
  assert.deepEqual(facts.topLevel, ['a.txt'])
  assert.equal(facts.packageJson, null)
  assert.equal(facts.lockfile, null)
})

test('fake git function is used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-fake-'))
  const calls = []
  async function fake(args) {
    calls.push(args)
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true'
    if (args[0] === 'tag') return 'v9.0.0\nv8.0.0'
    if (args[0] === 'rev-parse') return 'mybranch'
    if (args[0] === 'log' && args[1] === '-8') return 'abc1234 Data: nightly sky\ndef5678 Fix the legend\n9999999'
    if (args[0] === 'log') return 'fake subject'
    throw new Error('unexpected')
  }
  const facts = await inspectRepo(dir, { git: fake })
  assert.equal(facts.isGit, true)
  assert.deepEqual(facts.tags, ['v9.0.0', 'v8.0.0'])
  assert.equal(facts.branch, 'mybranch')
  assert.equal(facts.headSubject, 'fake subject')
  assert.deepEqual(facts.recent, [
    { sha: 'abc1234', subject: 'Data: nightly sky' },
    { sha: 'def5678', subject: 'Fix the legend' },
    { sha: '9999999', subject: '' },
  ])
  assert.ok(calls.length >= 4)
})
