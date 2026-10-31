// node --test src/release/ui/settings.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySettings, loadSettings, needsSandbox, saveSettings, settingsFromEnv, validateSettings } from './settings.mjs'

const ssh = (host, extra = {}) => ({ sandbox: { mode: 'ssh', host, ...extra } })

test('validate: the three modes, and the host must be a plain name', () => {
  assert.equal(validateSettings({ sandbox: { mode: 'off' } }).ok, true)
  assert.equal(validateSettings({ sandbox: { mode: 'local' } }).ok, true)
  const v = validateSettings(ssh(' hardac2 '))
  assert.equal(v.ok, true)
  assert.equal(v.settings.sandbox.host, 'hardac2')
  for (const bad of ['', '-oProxyCommand=x', 'a b', 'user@host', 'host:22', 'a/b', 'h;rm', 'x'.repeat(65)]) assert.equal(validateSettings(ssh(bad)).ok, false, bad)
  assert.equal(validateSettings({ sandbox: { mode: 'tcp' } }).ok, false)
  assert.equal(validateSettings(null).ok, false)
})

test('validate: limits are bounded and unknown fields are dropped', () => {
  assert.equal(validateSettings(ssh('hardac2', { memoryMb: 100 })).ok, false)
  assert.equal(validateSettings(ssh('hardac2', { memoryMb: 4096.5 })).ok, false)
  assert.equal(validateSettings(ssh('hardac2', { cpus: 99 })).ok, false)
  const v = validateSettings({ sandbox: { mode: 'local', host: 'ignored', memoryMb: '8192', cpus: '2', extra: 'x' }, other: 1 })
  assert.deepEqual(v.settings, { sandbox: { mode: 'local', host: '', memoryMb: 8192, cpus: 2 }, speed: { pool: 3, cache: true } })
})

test('apply: writes the env the backend reads, and clears it when off', () => {
  const env = { BEHIQUE_SANDBOX_MEMORY_MB: '999' }
  applySettings(validateSettings(ssh('hardac2', { memoryMb: 10240, cpus: 4 })).settings, env)
  assert.deepEqual(env, { BEHIQUE_SANDBOX: 'docker:ssh://hardac2', BEHIQUE_SANDBOX_MEMORY_MB: '10240', BEHIQUE_SANDBOX_CPUS: '4', BEHIQUE_POOL: '3' })
  applySettings(validateSettings({ sandbox: { mode: 'local' } }).settings, env)
  assert.equal(env.BEHIQUE_SANDBOX, 'docker'); assert.equal('BEHIQUE_SANDBOX_MEMORY_MB' in env, false)
  applySettings(validateSettings({ sandbox: { mode: 'off' } }).settings, env)
  assert.equal('BEHIQUE_SANDBOX' in env, false)
})

test('from env: reads the same values back, and ignores a bad one', () => {
  assert.deepEqual(settingsFromEnv({ BEHIQUE_SANDBOX: 'docker:ssh://hardac2', BEHIQUE_SANDBOX_CPUS: '2' }).sandbox, { mode: 'ssh', host: 'hardac2', memoryMb: null, cpus: 2 })
  assert.equal(settingsFromEnv({ BEHIQUE_SANDBOX: 'docker' }).sandbox.mode, 'local')
  assert.equal(settingsFromEnv({ BEHIQUE_SANDBOX: 'docker:ssh://-bad' }).sandbox.mode, 'off')
  assert.equal(settingsFromEnv({}).sandbox.mode, 'off')
})

test('load and save: a saved file wins; a missing or broken file falls back to the environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bq-settings-')), path = join(dir, 'out', 'settings.json')
  assert.equal(loadSettings(path, { BEHIQUE_SANDBOX: 'docker' }).source, 'environment')
  saveSettings(path, validateSettings(ssh('hardac2')).settings)
  const l = loadSettings(path, { BEHIQUE_SANDBOX: 'docker' })
  assert.equal(l.source, 'saved'); assert.equal(l.settings.sandbox.host, 'hardac2')
  writeFileSync(path, '{ not json')
  assert.equal(loadSettings(path, {}).source, 'environment')
  writeFileSync(path, JSON.stringify({ sandbox: { mode: 'ssh', host: '-oBad' } }))
  assert.equal(loadSettings(path, {}).source, 'environment') // a hand-edited bad value is not trusted
})

test('speed: pool and cache are validated, applied and read back', () => {
  const v = validateSettings({ sandbox: { mode: 'local' }, speed: { pool: '4', cache: false } })
  assert.deepEqual(v.settings.speed, { pool: 4, cache: false })
  assert.equal(validateSettings({ sandbox: { mode: 'local' }, speed: { pool: 9 } }).ok, false)
  assert.equal(validateSettings({ sandbox: { mode: 'local' }, speed: { pool: 2.5 } }).ok, false)
  assert.deepEqual(validateSettings({ sandbox: { mode: 'off' } }).settings.speed, { pool: 3, cache: true })
  const env = {}
  applySettings(v.settings, env)
  assert.equal(env.BEHIQUE_POOL, '4'); assert.equal(env.BEHIQUE_CACHE, 'off')
  applySettings(validateSettings({ sandbox: { mode: 'off' } }).settings, env)
  assert.equal(env.BEHIQUE_POOL, '3'); assert.equal('BEHIQUE_CACHE' in env, false)
  assert.deepEqual(settingsFromEnv({ BEHIQUE_POOL: '2', BEHIQUE_CACHE: 'off' }).speed, { pool: 2, cache: false })
  assert.deepEqual(settingsFromEnv({ BEHIQUE_POOL: '99' }).speed, { pool: 3, cache: true })
})

test('needsSandbox: only a static profile with no setup may run on this machine', () => {
  assert.equal(needsSandbox({ serve: { kind: 'static' }, setup: [] }), false)
  assert.equal(needsSandbox({ serve: { kind: 'static' } }), false)
  assert.equal(needsSandbox({ serve: { kind: 'static' }, setup: [{ cmd: 'npm' }] }), true)
  assert.equal(needsSandbox({ serve: { kind: 'command', cmd: 'pnpm' } }), true)
  assert.equal(needsSandbox({}), true)
  assert.equal(needsSandbox(null), true)
})
