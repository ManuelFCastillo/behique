// inspect-more tests: fake repos in temp dirs, offline.
// Run: node --test src/release/onboard/inspect-more.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectMore } from './inspect-more.mjs'

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'inspect-more-'))
}

function write(repo, rel, content) {
  const parts = rel.split('/')
  if (parts.length > 1) mkdirSync(join(repo, parts.slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(repo, rel), content)
}

function emptyCheck(result) {
  assert.deepEqual(result.packageManager, { name: null, version: null, source: null })
  assert.deepEqual(result.engines, { node: null })
  assert.equal(result.nodeVersionFile, null)
  assert.deepEqual(result.workspaces, [])
  assert.deepEqual(result.frameworks, [])
  assert.equal(result.envExample, null)
  assert.equal(result.compose, null)
  assert.deepEqual(result.staticRoots, [])
}

test('packageManager from field with hash', async () => {
  const r = makeRepo()
  write(r, 'package.json', JSON.stringify({ packageManager: 'pnpm@9.1.0+sha512.abc' }))
  const res = await inspectMore(r)
  assert.deepEqual(res.packageManager, { name: 'pnpm', version: '9.1.0', source: 'packageManager field' })
})

test('packageManager from field without hash', async () => {
  const r = makeRepo()
  write(r, 'package.json', JSON.stringify({ packageManager: 'yarn@1.22.19' }))
  const res = await inspectMore(r)
  assert.deepEqual(res.packageManager, { name: 'yarn', version: '1.22.19', source: 'packageManager field' })
})

test('packageManager from each lockfile, and none', async () => {
  const pairs = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun']
  ]
  for (const [file, name] of pairs) {
    const r = makeRepo()
    write(r, 'package.json', JSON.stringify({ name: 'x' }))
    write(r, file, 'lock')
    const res = await inspectMore(r)
    assert.deepEqual(res.packageManager, { name, version: null, source: 'lockfile' })
  }
  const none = makeRepo()
  write(none, 'package.json', JSON.stringify({ name: 'x' }))
  assert.deepEqual((await inspectMore(none)).packageManager, { name: null, version: null, source: null })
})

test('unknown field falls back to lockfile', async () => {
  const r = makeRepo()
  write(r, 'package.json', JSON.stringify({ packageManager: 'other@1.2.3' }))
  write(r, 'yarn.lock', 'lock')
  const res = await inspectMore(r)
  assert.deepEqual(res.packageManager, { name: 'yarn', version: null, source: 'lockfile' })
})

test('engines and nvmrc', async () => {
  const r = makeRepo()
  write(r, 'package.json', JSON.stringify({ engines: { node: '>=18' } }))
  write(r, '.nvmrc', 'v20.11.0\nsecond\n')
  const res = await inspectMore(r)
  assert.deepEqual(res.engines, { node: '>=18' })
  assert.equal(res.nodeVersionFile, 'v20.11.0')
})

test('nodeVersionFile trims to 20 chars', async () => {
  const r = makeRepo()
  write(r, '.nvmrc', '  0123456789abcdefghijEXTRA\n')
  assert.equal((await inspectMore(r)).nodeVersionFile, '0123456789abcdefghij')
  const r2 = makeRepo()
  write(r2, '.node-version', '18.5.0\n')
  assert.equal((await inspectMore(r2)).nodeVersionFile, '18.5.0')
})

test('workspaces from array form with script limits', async () => {
  const r = makeRepo()
  const scripts = {}
  for (let i = 0; i < 15; i++) scripts['s' + String(i).padStart(2, '0')] = 'x'.repeat(150)
  write(r, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }))
  write(r, 'packages/a/package.json', JSON.stringify({ name: 'a', scripts: { start: 'node x', build: 'y' } }))
  write(r, 'packages/b/package.json', JSON.stringify({ name: 'b', scripts }))
  const res = await inspectMore(r)
  assert.equal(res.workspaces.length, 2)
  assert.equal(res.workspaces[0].dir, 'packages/a')
  assert.equal(res.workspaces[1].dir, 'packages/b')
  assert.equal(Object.keys(res.workspaces[1].scripts).length, 12)
  for (const v of Object.values(res.workspaces[1].scripts)) assert.ok(v.length <= 120)
})

test('workspaces from object form', async () => {
  const r = makeRepo()
  write(r, 'package.json', JSON.stringify({ workspaces: { packages: ['excalidraw-app'] } }))
  write(r, 'excalidraw-app/package.json', JSON.stringify({ name: 'app', scripts: { dev: 'vite' } }))
  const res = await inspectMore(r)
  assert.equal(res.workspaces.length, 1)
  assert.deepEqual(res.workspaces[0], { dir: 'excalidraw-app', name: 'app', scripts: { dev: 'vite' } })
})

test('workspaces from pnpm-workspace.yaml ignoring bad patterns', async () => {
  const r = makeRepo()
  write(r, 'package.json', JSON.stringify({ name: 'root' }))
  write(r, 'pnpm-workspace.yaml', 'packages:\n  - \'packages/*\'\n  - \'!packages/skip\'\n  - \'docs/**\'\n')
  write(r, 'packages/ok/package.json', JSON.stringify({ name: 'ok' }))
  write(r, 'packages/skip/package.json', JSON.stringify({ name: 'skip' }))
  const res = await inspectMore(r)
  const dirs = res.workspaces.map((w) => w.dir).sort()
  assert.ok(dirs.includes('packages/ok'))
  assert.ok(dirs.includes('packages/skip'))
  assert.ok(!dirs.some((d) => d.includes('!') || d.includes('**')))
})

test('frameworks detection in root and workspace', async () => {
  const r = makeRepo()
  write(r, 'package.json', JSON.stringify({ workspaces: ['apps/*'] }))
  write(r, 'vite.config.js', 'x')
  write(r, 'angular.json', '{}')
  write(r, 'apps/web/package.json', JSON.stringify({ name: 'web' }))
  write(r, 'apps/web/next.config.js', 'x')
  const res = await inspectMore(r)
  assert.deepEqual(res.frameworks, ['vite', 'next', 'angular'])
})

test('vitepress and jekyll frameworks', async () => {
  const r = makeRepo()
  mkdirSync(join(r, 'docs', '.vitepress'), { recursive: true })
  write(r, '_config.yml', 'x')
  const res = await inspectMore(r)
  assert.ok(res.frameworks.includes('vitepress'))
  assert.ok(res.frameworks.includes('jekyll'))
})

test('envExample truncation and secrets never read', async () => {
  const r = makeRepo()
  const marker = 'MARKER_SECRET_zzz_12345'
  write(r, '.env', 'SECRET=' + marker + '\n')
  write(r, '.env.local', 'SECRET=' + marker + '\n')
  write(r, '.env.production', 'SECRET=' + marker + '\n')
  const lines = []
  for (let i = 0; i < 50; i++) lines.push('KEY' + i + '=' + 'v'.repeat(200) + '   ')
  write(r, '.env.example', lines.join('\n'))
  const res = await inspectMore(r)
  assert.equal(res.envExample.file, '.env.example')
  assert.equal(res.envExample.lines.length, 40)
  for (const l of res.envExample.lines) assert.ok(l.length <= 160)
  assert.ok(!JSON.stringify(res).includes(marker))
})

test('compose services', async () => {
  const r = makeRepo()
  write(r, 'docker-compose.yml', 'services:\n  web:\n    image: x\n  db:\n    image: y\nvolumes:\n  data:\n')
  const res = await inspectMore(r)
  assert.deepEqual(res.compose, { file: 'docker-compose.yml', services: ['web', 'db'] })
})

test('static roots with node_modules ignored', async () => {
  const r = makeRepo()
  write(r, 'index.html', '<html></html>')
  write(r, 'public/index.html', 'x')
  write(r, 'examples/react/index.html', 'x')
  write(r, 'node_modules/x/index.html', 'x')
  const res = await inspectMore(r)
  assert.deepEqual(res.staticRoots.map((s) => s.dir), ['.', 'examples/react', 'public'])
  for (const s of res.staticRoots) assert.equal(s.hasIndexHtml, true)
})

test('symlinked directory is not followed', async () => {
  const r = makeRepo()
  const outside = makeRepo()
  write(outside, 'index.html', 'x')
  write(outside, 'package.json', JSON.stringify({ name: 'evil' }))
  symlinkSync(outside, join(r, 'linked'))
  write(r, 'package.json', JSON.stringify({ workspaces: ['linked'] }))
  const res = await inspectMore(r)
  assert.deepEqual(res.workspaces, [])
  assert.deepEqual(res.staticRoots, [])
})

test('missing or empty directory returns empty', async () => {
  const missing = join(makeRepo(), 'nope')
  emptyCheck(await inspectMore(missing))
  emptyCheck(await inspectMore(makeRepo()))
})

test('path that is a file does not throw', async () => {
  const r = makeRepo()
  const f = join(r, 'file.txt')
  writeFileSync(f, 'hello')
  emptyCheck(await inspectMore(f))
})
