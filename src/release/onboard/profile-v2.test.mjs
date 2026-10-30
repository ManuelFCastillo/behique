// Profile v2: environment, static builds and sub-directories, scripts disabled on installs, corepack shims.
//   node --test src/release/onboard/profile-v2.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeCommands, profileToAdapter, scriptsOffEnv, validateProfile, yarnMajor } from './profile.mjs'

const base = (serve, over = {}) => ({ name: 'demo', repo: '/tmp/repo', workRoot: '/tmp/work', serve, ...over })

describe('serve.env', () => {
  it('accepts plain values and the port placeholder', () => {
    assert.deepEqual(validateProfile(base({ kind: 'command', cmd: 'npm', args: ['start'], env: { PORT: '{port}', NODE_ENV: 'development' } })), [])
  })
  it('refuses credential-looking keys, lower case keys, long values and newlines', () => {
    const problems = validateProfile(base({ kind: 'command', cmd: 'npm', args: ['start'], env: { API_KEY: 'x', NEXTAUTH_SECRET: 'x', SESSION_KEY: 'x', lower: 'x', LONG: 'x'.repeat(201), MULTI: 'a\nb' } }))
    assert.equal(problems.filter(p => /credential/.test(p)).length, 3)
    assert.ok(problems.some(p => /upper case/.test(p)))
    assert.equal(problems.filter(p => /one-line string/.test(p)).length, 2)
  })
  it('is listed for a person to read before approving', () => {
    const lines = describeCommands(base({ kind: 'command', cmd: 'npm', args: ['start'], env: { PORT: '{port}' } }))
    assert.ok(lines.includes('env: PORT={port}'))
    assert.ok(describeCommands(base({ kind: 'static', env: { DEBUG: 'true' } })).includes('env: DEBUG=true'))
  })
  it('allowScripts must be a boolean and is shown as a warning when on', () => {
    assert.ok(validateProfile(base({ kind: 'command', cmd: 'npm', args: ['start'], allowScripts: 'yes' })).some(p => /allowScripts/.test(p)))
    assert.ok(describeCommands(base({ kind: 'command', cmd: 'npm', args: ['start'], install: [{ cmd: 'npm', args: ['ci'] }], allowScripts: true })).some(l => /lifecycle scripts/.test(l)))
  })
})

describe('static serve with a build and a sub-directory', () => {
  it('may have install steps and a root, and says so', () => {
    const p = base({ kind: 'static', root: 'dist', install: [{ cmd: 'npm', args: ['ci'] }, { cmd: 'npm', args: ['run', 'build'] }] })
    assert.deepEqual(validateProfile(p), [])
    const lines = describeCommands(p)
    assert.deepEqual(lines.slice(0, 2), ['install: npm ci', 'install: npm run build'])
    assert.ok(lines.includes('serve: built-in static file server (folder dist)'))
  })
  it('a plain static profile still shows exactly the one line', () => {
    assert.deepEqual(describeCommands(base({ kind: 'static' })), ['serve: built-in static file server'])
  })
  it('root must stay inside the repository', () => {
    for (const root of ['/etc', '../x', 'a/../b', 'a\\b']) assert.ok(validateProfile(base({ kind: 'static', root })).some(p => /serve\.root/.test(p)), root)
    assert.ok(validateProfile(base({ kind: 'command', cmd: 'npm', args: ['start'], root: 'dist' })).some(p => /only applies to a static/.test(p)))
  })
  it('the adapter serves the sub-directory', () => {
    const a = profileToAdapter(base({ kind: 'static', root: 'dist' }), { env: { PATH: '/usr/bin' } })
    const { args } = a.serve('/work/w-abc', 8301)
    assert.equal(args[1], join('/work/w-abc', 'dist'))
  })
})

describe('the adapter', () => {
  it('never runs lifecycle scripts unless the profile allows it', () => {
    const serve = { kind: 'command', cmd: 'npm', args: ['start'], install: [{ cmd: 'npm', args: ['ci'] }, { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] }, { cmd: 'node', args: ['setup.js'] }] }
    const off = profileToAdapter(base(serve), { env: { PATH: '/usr/bin' } }).installs
    assert.deepEqual(off, [{ cmd: 'npm', args: ['ci', '--ignore-scripts'] }, { cmd: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] }, { cmd: 'node', args: ['setup.js'] }])
    const on = profileToAdapter(base({ ...serve, allowScripts: true }), { env: { PATH: '/usr/bin' } }).installs
    assert.deepEqual(on, serve.install)
  })
  it('passes the profile env to serve with the port filled in, and keeps the rest of the environment', () => {
    const a = profileToAdapter(base({ kind: 'command', cmd: 'npm', args: ['start'], env: { PORT: '{port}', APP_URL: 'http://127.0.0.1:{port}' } }), { env: { PATH: '/usr/bin', HOME: '/h' } })
    const { env } = a.serve('/w', 8302)
    assert.equal(env.PORT, '8302'); assert.equal(env.APP_URL, 'http://127.0.0.1:8302'); assert.equal(env.HOME, '/h'); assert.equal(env.PATH, '/usr/bin')
  })
  it('puts corepack shims LAST on PATH for yarn and pnpm, so a real one wins, and writes them into the work root', () => {
    const work = mkdtempSync(join(tmpdir(), 'shim-'))
    const a = profileToAdapter({ ...base({ kind: 'command', cmd: 'yarn', args: ['dev'], install: [{ cmd: 'pnpm', args: ['install'] }] }), workRoot: work }, { env: { PATH: '/usr/bin' } })
    const { env } = a.serve('/w', 8303)
    assert.equal(env.PATH, `/usr/bin:${join(work, '.behique-shims')}`)
    assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0')
    for (const n of ['yarn', 'pnpm']) {
      const f = join(work, '.behique-shims', n)
      assert.equal(readFileSync(f, 'utf8'), `#!/bin/sh\nexec corepack ${n} "$@"\n`)
      assert.ok(statSync(f).mode & 0o100, 'executable')
    }
  })
  it('a profile that does not use yarn or pnpm gets no shims and an untouched PATH', () => {
    const work = mkdtempSync(join(tmpdir(), 'noshim-'))
    const a = profileToAdapter({ ...base({ kind: 'command', cmd: 'npm', args: ['start'] }), workRoot: work }, { env: { PATH: '/usr/bin' } })
    assert.equal(a.serve('/w', 8304).env.PATH, '/usr/bin')
    assert.equal(existsSync(join(work, '.behique-shims')), false)
  })
  it('hands the readiness settings to the build runner', () => {
    const a = profileToAdapter(base({ kind: 'command', cmd: 'npm', args: ['start'] }, { ready: { path: '/health', timeoutMs: 45000 } }), { env: {} })
    assert.equal(a.readyMs, 45000); assert.equal(a.readyPath, '/health')
  })
})

describe('services (sidecar databases)', () => {
  const cmd = { kind: 'command', cmd: 'npm', args: ['start'] }
  it('accepts a valid list and refuses a bad one with a plain sentence', () => {
    assert.deepEqual(validateProfile(base(cmd, { services: [{ kind: 'postgres', name: 'db', inject: { DATABASE_URL: 'url' } }] })), [])
    const problems = validateProfile(base(cmd, { services: [{ kind: 'oracle', name: 'db' }] }))
    assert.ok(problems.some(p => /unknown kind oracle/.test(p)))
    assert.ok(validateProfile(base(cmd, { services: 'postgres' })).length > 0)
  })
  it('is listed for a person to read, and a static profile with services is no longer "nothing to approve"', () => {
    const lines = describeCommands(base(cmd, { services: [{ kind: 'redis', name: 'cache' }] }))
    assert.ok(lines.includes('service: redis (redis:7-alpine) as cache, injects REDIS_URL'))
    const staticLines = describeCommands(base({ kind: 'static' }, { services: [{ kind: 'postgres', name: 'db' }] }))
    assert.ok(staticLines.some(l => l.startsWith('service: postgres')))
  })
  it('the adapter carries the normalized profile so a sandbox can read its services', () => {
    const a = profileToAdapter(base(cmd, { services: [{ kind: 'mongo', name: 'mongo' }] }), { env: {} })
    assert.equal(a.profile.services[0].kind, 'mongo')
  })
})

describe('scripts stay off for every package manager', () => {
  const checkout = files => { const d = mkdtempSync(join(tmpdir(), 'bq-yarn-')); for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c); return d }
  it('npm, pnpm and yarn 1 get the flag; yarn Berry gets none because it refuses it', () => {
    const a = profileToAdapter(base({ kind: 'command', cmd: 'npm', args: ['start'], install: [{ cmd: 'npm', args: ['ci'] }, { cmd: 'pnpm', args: ['install'] }, { cmd: 'yarn', args: ['install'] }] }), { env: {} })
    assert.deepEqual(a.installs.map(i => i.args), [['ci', '--ignore-scripts'], ['install', '--ignore-scripts'], ['install', '--ignore-scripts']]) // a checkout we cannot read counts as yarn 1
    assert.deepEqual(a.installsFor(checkout({ '.yarnrc.yml': '' })).map(i => i.args), [['ci', '--ignore-scripts'], ['install', '--ignore-scripts'], ['install']])
    assert.deepEqual(a.installsFor(checkout({ 'package.json': '{}' })).map(i => i.args)[2], ['install', '--ignore-scripts'])
  })
  it('knows yarn 1 from Berry by the files in the checkout', () => {
    assert.equal(yarnMajor(checkout({ 'package.json': '{}' })), 1)
    assert.equal(yarnMajor(checkout({ '.yarnrc.yml': 'nodeLinker: node-modules' })), 2)
    assert.equal(yarnMajor(checkout({ 'package.json': '{"packageManager":"yarn@3.6.1"}' })), 2)
    assert.equal(yarnMajor(checkout({ 'package.json': '{"packageManager":"yarn@1.22.19"}' })), 1)
    assert.equal(yarnMajor(checkout({ 'package.json': '{}', 'yarn.lock': '# yarn lockfile v1' })), 1)
    assert.equal(yarnMajor(checkout({ 'package.json': '{}', 'yarn.lock': '__metadata:\n  version: 6' })), 2)
    assert.equal(yarnMajor('/definitely/not/here'), 1)
  })
  it('turns scripts off through the setting that version understands', () => {
    assert.deepEqual(scriptsOffEnv(checkout({ '.yarnrc.yml': '' })), { YARN_ENABLE_SCRIPTS: 'false' })
    assert.deepEqual(scriptsOffEnv(checkout({ 'package.json': '{}' })), {})
    const a = profileToAdapter(base({ kind: 'command', cmd: 'yarn', args: ['dev'] }), { env: {} })
    assert.equal(a.serve(checkout({ '.yarnrc.yml': '' }), 8300).env.YARN_ENABLE_SCRIPTS, 'false')
  })
  it('a profile that allows scripts sets nothing', () => {
    const a = profileToAdapter(base({ kind: 'command', cmd: 'npm', args: ['start'], allowScripts: true, install: [{ cmd: 'yarn', args: ['install'] }] }), { env: {} })
    assert.deepEqual(a.installs.map(i => i.args), [['install']])
    const e = a.serve(checkout({ '.yarnrc.yml': '' }), 8300).env
    assert.equal(e.YARN_ENABLE_SCRIPTS, undefined)
  })
})
