// Profile v2: environment, static builds and sub-directories, scripts disabled on installs, corepack shims.
//   node --test src/release/onboard/profile-v2.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeCommands, profileToAdapter, validateProfile } from './profile.mjs'

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
