// Offline tests for the guarded clone flow, using fakes only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseRepoRef, clonePlan, clonePreview, cloneRun } from './clone-flow.mjs'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'clone-flow-'))
}

const noExists = () => false

test('parseRepoRef accepts plain, URL, .git and trailing slash', () => {
  assert.deepEqual(parseRepoRef('octo/kitty'), { owner: 'octo', name: 'kitty' })
  assert.deepEqual(parseRepoRef('https://github.com/octo/kitty'), { owner: 'octo', name: 'kitty' })
  assert.deepEqual(parseRepoRef('octo/kitty.git'), { owner: 'octo', name: 'kitty' })
  assert.deepEqual(parseRepoRef('https://github.com/octo/kitty.git'), { owner: 'octo', name: 'kitty' })
  assert.deepEqual(parseRepoRef('octo/kitty/'), { owner: 'octo', name: 'kitty' })
  assert.deepEqual(parseRepoRef('https://github.com/octo/kitty/'), { owner: 'octo', name: 'kitty' })
  assert.deepEqual(parseRepoRef('https://github.com/octo/kitty.git/'), { owner: 'octo', name: 'kitty' })
})

test('parseRepoRef rejects bad input', () => {
  assert.equal(parseRepoRef('https://gitlab.com/octo/kitty'), null)
  assert.equal(parseRepoRef('https://github.com/octo/kitty/extra'), null)
  assert.equal(parseRepoRef('octo/kitty/extra'), null)
  assert.equal(parseRepoRef('octo/..'), null)
  assert.equal(parseRepoRef('octo/.'), null)
  assert.equal(parseRepoRef('octo/a..b'), null)
  assert.equal(parseRepoRef('octo/-abc'), null)
  assert.equal(parseRepoRef('-octo/kitty'), null)
  assert.equal(parseRepoRef('octo/kit ty'), null)
  assert.equal(parseRepoRef(' octo/kitty'), null)
  assert.equal(parseRepoRef('octo/kitty?x=1'), null)
  assert.equal(parseRepoRef('octo/kitty#frag'), null)
  assert.equal(parseRepoRef(123), null)
  assert.equal(parseRepoRef(null), null)
  assert.equal(parseRepoRef(undefined), null)
  assert.equal(parseRepoRef('justone'), null)
  assert.equal(parseRepoRef(''), null)
  assert.equal(parseRepoRef('o'.repeat(40) + '/kitty'), null)
  assert.equal(parseRepoRef('octo/' + 'k'.repeat(101)), null)
  assert.equal(parseRepoRef('octo/kitty\n'), null)
})

test('clonePlan builds the exact command', () => {
  const appsRoot = tempRoot()
  const r = clonePlan({ fullName: 'octo/kitty', appsRoot, exists: noExists, info: {} })
  assert.equal(r.ok, true)
  const target = resolve(appsRoot, 'kitty')
  assert.equal(r.plan.url, 'https://github.com/octo/kitty.git')
  assert.equal(r.plan.path, target)
  assert.deepEqual(r.plan.command, ['git', 'clone', '--filter=blob:none', '--', 'https://github.com/octo/kitty.git', target])
  assert.equal(r.plan.sizeMb, null)
  assert.deepEqual(r.plan.warnings, [])
})

test('clonePlan refuses existing folder and bad folder names', () => {
  const appsRoot = tempRoot()
  const yes = () => true
  const r1 = clonePlan({ fullName: 'octo/kitty', appsRoot, exists: yes, info: {} })
  assert.equal(r1.ok, false)
  assert.equal(r1.error, 'Already cloned: kitty is in the apps folder.')
  const r2 = clonePlan({ fullName: 'octo/w-x', appsRoot, exists: noExists, info: {} })
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'That name cannot be used as a folder in the apps folder.')
  const r3 = clonePlan({ fullName: 'octo/work', appsRoot, exists: noExists, info: {} })
  assert.equal(r3.ok, false)
  assert.equal(r3.error, 'That name cannot be used as a folder in the apps folder.')
})

test('clonePlan rejects invalid repo and escape attempts', () => {
  const appsRoot = tempRoot()
  const bad = clonePlan({ fullName: 'octo/..', appsRoot, exists: noExists, info: {} })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'That is not a GitHub repository name.')
  const bad2 = clonePlan({ fullName: 'not a repo', appsRoot, exists: noExists, info: {} })
  assert.equal(bad2.ok, false)
  assert.equal(bad2.error, 'That is not a GitHub repository name.')
})

test('clonePlan warnings and sizeMb', () => {
  const appsRoot = tempRoot()
  const mk = info => clonePlan({ fullName: 'octo/kitty', appsRoot, exists: noExists, info })
  assert.deepEqual(mk({ isPrivate: true }).plan.warnings, ['This is a private repository.'])
  assert.deepEqual(mk({ isArchived: true }).plan.warnings, ['This repository is archived.'])
  assert.deepEqual(mk({ isFork: true }).plan.warnings, ['This is a fork.'])
  const large = mk({ sizeKb: 600 * 1024 })
  assert.equal(large.plan.sizeMb, 600)
  assert.deepEqual(large.plan.warnings, ['This repository is large (about 600 MB).'])
  const all = mk({ isPrivate: true, isArchived: true, isFork: true, sizeKb: 600 * 1024 })
  assert.deepEqual(all.plan.warnings, [
    'This is a private repository.',
    'This repository is archived.',
    'This repository is large (about 600 MB).',
    'This is a fork.'
  ])
  // Rounding: 1536 Kb is 1.5 MB, 1500 Kb rounds to 1.5 MB.
  assert.equal(mk({ sizeKb: 1536 }).plan.sizeMb, 1.5)
  assert.equal(mk({ sizeKb: 1500 }).plan.sizeMb, 1.5)
  assert.equal(mk({ sizeKb: null }).plan.sizeMb, null)
  assert.equal(mk({}).plan.sizeMb, null)
  // Just above 500 triggers, exactly 500 does not.
  assert.deepEqual(mk({ sizeKb: 500 * 1024 }).plan.warnings, [])
  assert.equal(mk({ sizeKb: 500 * 1024 }).plan.warnings.length, 0)
  const over = mk({ sizeKb: 500.1 * 1024 })
  assert.ok(over.plan.warnings.length === 1)
})

test('clonePreview confirm is stable and changes with size', async () => {
  const appsRoot = tempRoot()
  let sizeKb = 1024
  const deps = { appsRoot, exists: noExists, repoInfo: async () => ({ sizeKb }) }
  const a = await clonePreview({ repo: 'octo/kitty' }, deps)
  assert.equal(a.ok, true)
  assert.equal(a.commandLine, a.plan.command.join(' '))
  assert.match(a.confirm, /^[0-9a-f]{16}$/)
  const b = await clonePreview({ repo: 'octo/kitty' }, deps)
  assert.equal(b.confirm, a.confirm)
  sizeKb = 2048
  const c = await clonePreview({ repo: 'octo/kitty' }, deps)
  assert.equal(c.ok, true)
  assert.notEqual(c.confirm, a.confirm)
})

test('clonePreview turns repoInfo throw into 404', async () => {
  const appsRoot = tempRoot()
  const r = await clonePreview({ repo: 'octo/kitty' }, { appsRoot, exists: noExists, repoInfo: async () => { throw new Error('nope') } })
  assert.equal(r.ok, false)
  assert.equal(r.status, 404)
  assert.equal(r.error, 'Could not read that repository from GitHub.')
})

test('clonePreview fails bad repo with 400', async () => {
  const appsRoot = tempRoot()
  const r = await clonePreview({ repo: 'bogus' }, { appsRoot, exists: noExists, repoInfo: async () => ({}) })
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

test('cloneRun refuses missing or wrong confirm without calling exec', async () => {
  const appsRoot = tempRoot()
  let calls = 0
  const deps = { appsRoot, exists: noExists, repoInfo: async () => ({}), exec: async () => { calls += 1; return { code: 0, stderr: '' } } }
  const prev = await clonePreview({ repo: 'octo/kitty' }, deps)
  assert.equal(prev.ok, true)
  const bad = await cloneRun({ repo: 'octo/kitty', confirm: 'wrong' }, deps)
  assert.equal(bad.ok, false)
  assert.equal(bad.status, 409)
  assert.equal(bad.stale, true)
  assert.equal(bad.error, 'What would be run has changed, or was not reviewed. Review it again before cloning.')
  const missing = await cloneRun({ repo: 'octo/kitty' }, deps)
  assert.equal(missing.status, 409)
  assert.equal(calls, 0)
})

test('cloneRun refuses existing folder without calling exec', async () => {
  const appsRoot = tempRoot()
  let calls = 0
  const deps = { appsRoot, exists: () => true, repoInfo: async () => ({}), exec: async () => { calls += 1; return { code: 0, stderr: '' } } }
  const r = await cloneRun({ repo: 'octo/kitty', confirm: 'anything' }, deps)
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.match(r.error, /Already cloned/)
  assert.equal(calls, 0)
})

test('cloneRun calls exec once and returns success', async () => {
  const appsRoot = tempRoot()
  const seen = []
  const deps = {
    appsRoot,
    exists: noExists,
    repoInfo: async () => ({}),
    exec: async (command, opts) => {
      seen.push({ command, opts })
      return { code: 0, stderr: '' }
    }
  }
  const prev = await clonePreview({ repo: 'octo/kitty' }, deps)
  const r = await cloneRun({ repo: 'octo/kitty', confirm: prev.confirm }, deps)
  assert.equal(r.ok, true)
  assert.equal(r.name, 'kitty')
  assert.equal(r.path, prev.plan.path)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].command, prev.plan.command)
})

test('cloneRun failure shape cuts stderr to 200 chars', async () => {
  const appsRoot = tempRoot()
  const longLine = 'x'.repeat(300) + '\nsecond line'
  const deps = { appsRoot, exists: noExists, repoInfo: async () => ({}), exec: async () => ({ code: 128, stderr: longLine }) }
  const prev = await clonePreview({ repo: 'octo/kitty' }, deps)
  const r = await cloneRun({ repo: 'octo/kitty', confirm: prev.confirm }, deps)
  assert.equal(r.ok, false)
  assert.equal(r.status, 502)
  const detail = r.error.slice('The clone failed: '.length)
  assert.equal(detail, 'x'.repeat(200))
  assert.ok(r.error.startsWith('The clone failed: '))
})

test('cloneRun throwing exec gives 502', async () => {
  const appsRoot = tempRoot()
  const deps = { appsRoot, exists: noExists, repoInfo: async () => ({}), exec: async () => { throw new Error('boom\nline2') } }
  const prev = await clonePreview({ repo: 'octo/kitty' }, deps)
  const r = await cloneRun({ repo: 'octo/kitty', confirm: prev.confirm }, deps)
  assert.equal(r.ok, false)
  assert.equal(r.status, 502)
  assert.equal(r.error, 'The clone failed: boom')
})
