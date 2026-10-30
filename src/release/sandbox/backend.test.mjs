// Run: node --test src/release/sandbox/backend.test.mjs   (a throwaway local git repo, fake sandbox, fake tunnel, fake fetch: no docker, no network)
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileToAdapter } from '../onboard/profile.mjs'
import { sandboxConfigFromEnv, startSandboxedBuild, writeExtras } from './backend.mjs'

let repo, work
before(() => {
  const root = mkdtempSync(join(tmpdir(), 'bq-backend-'))
  repo = join(root, 'repo'); work = join(root, 'work'); mkdirSync(repo); mkdirSync(work)
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
  writeFileSync(join(repo, 'index.html'), '<h1>hi</h1>'); git('add', '.'); git('commit', '-q', '-m', 'one')
})

const adapterFor = (serve, extra = {}) => profileToAdapter({ name: 'demo', repo, workRoot: work, serve, ...extra }, { env: {} })

function fakes({ prepare = { ok: true }, services = { ok: true }, install = { ok: true, steps: [] }, app = { ok: true, host: '172.20.0.2', port: 8300 }, answers = [true], running = true } = {}) {
  const calls = []
  let destroyed = 0
  const sbx = {
    runId: 'abc123xyz0',
    prepare: async a => { calls.push(['prepare', a.dir]); return prepare },
    startServices: async (r, o) => { calls.push(['services', r.map(s => s.kind)]); return services },
    install: async (steps, o) => { calls.push(['install', steps, o.env]); return install },
    startApp: async a => { calls.push(['app', a]); return app },
    logs: async () => ({ ok: true, text: 'last app lines' }),
    running: async () => ({ ok: true, running }),
    destroy: async () => { destroyed += 1; return { ok: true } },
  }
  const closed = []
  const deps = {
    createSandbox: opts => { calls.push(['create', opts.image]); return sbx },
    pack: async () => Buffer.alloc(0),
    forward: async a => { calls.push(['forward', a]); return { close: async () => { closed.push(1) } } },
    fetch: async () => ({ ok: answers.shift() ?? false }),
    sleep: async () => {},
  }
  return { deps, calls, destroyedCount: () => destroyed, closed }
}

describe('sandboxConfigFromEnv', () => {
  it('is off unless asked, understands local and ssh, refuses anything else', () => {
    assert.equal(sandboxConfigFromEnv({}), null)
    assert.equal(sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'off' }), null)
    assert.deepEqual(sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'docker' }), { target: '', image: 'node:22-bookworm', sshHost: null })
    assert.deepEqual(sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'docker:ssh://hardac2' }), { target: 'ssh://hardac2', image: 'node:22-bookworm', sshHost: 'hardac2' })
    assert.deepEqual(sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'docker', BEHIQUE_SANDBOX_MEMORY_MB: '10240' }).limits, { memoryMb: 10240, cpus: 4, pids: 1024 })
    assert.throws(() => sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'docker', BEHIQUE_SANDBOX_MEMORY_MB: '100' }), /MEMORY_MB/)
    assert.throws(() => sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'docker', BEHIQUE_SANDBOX_CPUS: 'many' }), /CPUS/)
    assert.throws(() => sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'dockr' }), /must be/)
    assert.throws(() => sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'docker:http://x' }), /Unknown docker target/)
    assert.throws(() => sandboxConfigFromEnv({ BEHIQUE_SANDBOX: 'docker', BEHIQUE_SANDBOX_IMAGE: 'node:latest' }), /pinned/)
  })
})

describe('writeExtras', () => {
  it('puts the static server and executable shims in .behique', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bq-extras-'))
    writeExtras(dir, ['yarn', 'pnpm'])
    assert.ok(existsSync(join(dir, '.behique', 'static-server.mjs')))
    assert.match(readFileSync(join(dir, '.behique', 'bin', 'yarn'), 'utf8'), /exec corepack yarn/)
    assert.ok(statSync(join(dir, '.behique', 'bin', 'pnpm')).mode & 0o100)
  })
})

describe('startSandboxedBuild', () => {
  const config = { target: '', image: 'node:22-bookworm', sshHost: null }

  it('runs a command app: services, install with the port filled in, app with injected env, then a tunnel on the same port', async () => {
    const a = adapterFor({ kind: 'command', cmd: 'pnpm', args: ['run', 'start', '--', '-p', '{port}'], install: [{ cmd: 'pnpm', args: ['install'] }], env: { APP_PORT: '{port}' } }, { services: [{ kind: 'postgres', name: 'db' }] })
    const f = fakes()
    const b = await startSandboxedBuild({ adapter: a, ref: 'HEAD', port: 8300, config, deps: f.deps })
    assert.equal(b.base, 'http://127.0.0.1:8300')
    assert.match(b.sha, /^[0-9a-f]{40}$/)
    assert.equal(b.sandbox.appAddress, '172.20.0.2:8300')
    const names = f.calls.map(c => c[0])
    assert.deepEqual(names, ['create', 'prepare', 'services', 'install', 'app', 'forward'])
    assert.deepEqual(f.calls[2][1], ['postgres'])
    const install = f.calls[3]
    assert.deepEqual(install[1], [{ cmd: 'pnpm', args: ['install', '--ignore-scripts'] }]) // scripts stay off
    assert.equal(install[2].DATABASE_URL, 'postgresql://behique:behique@db:5432/app')
    assert.equal(install[2].APP_PORT, '8300'); assert.equal(install[2].HOST, '0.0.0.0'); assert.equal(install[2].BEHIQUE_BIND, '0.0.0.0')
    assert.match(install[2].PATH, /^\/work\/\.behique\/bin:/)
    const app = f.calls[4][1]
    assert.deepEqual([app.cmd, app.args, app.port], ['node', ['/work/.behique/launch.mjs', '8300', '--', 'pnpm', 'run', 'start', '--', '-p', '8300'], 8300])
    assert.deepEqual(f.calls[5][1], { listenPort: 8300, host: '172.20.0.2', port: 8300 })
    await b.stop()
    assert.equal(f.destroyedCount(), 1); assert.equal(f.closed.length, 1)
  })

  it('serves a static app with the bundled server inside the box, from its folder', async () => {
    const a = adapterFor({ kind: 'static', root: 'public', overrides: {} })
    const f = fakes()
    const b = await startSandboxedBuild({ adapter: a, ref: 'HEAD', port: 8301, config, deps: f.deps })
    const app = f.calls.find(c => c[0] === 'app')[1]
    assert.deepEqual(app.args.slice(0, 7), ['/work/.behique/launch.mjs', '8301', '--', 'node', '/work/.behique/static-server.mjs', '/work/public', '8301'])
    assert.ok(!f.calls.some(c => c[0] === 'install'))
    await b.stop()
  })

  it('a failing install destroys the sandbox and carries the logs', async () => {
    const a = adapterFor({ kind: 'command', cmd: 'npm', args: ['start'], install: [{ cmd: 'npm', args: ['ci'] }] })
    const f = fakes({ install: { ok: false, error: 'Step 1 (npm ci) exited with code 1.', logs: 'npm ERR! boom' } })
    await assert.rejects(startSandboxedBuild({ adapter: a, ref: 'HEAD', port: 8302, config, deps: f.deps }), e => /exited with code 1/.test(e.message) && e.logs === 'npm ERR! boom')
    assert.equal(f.destroyedCount(), 1)
    assert.ok(!f.calls.some(c => c[0] === 'app'))
  })

  it('an app that never answers fails with its last output and cleans up; a stopped app fails fast', async () => {
    const a = adapterFor({ kind: 'command', cmd: 'npm', args: ['start'] }, {})
    a.readyMs = 50
    const f = fakes({ answers: [] })
    await assert.rejects(startSandboxedBuild({ adapter: a, ref: 'HEAD', port: 8303, config, deps: f.deps }), e => /did not answer/.test(e.message) && e.logs === 'last app lines')
    assert.equal(f.destroyedCount(), 1); assert.equal(f.closed.length, 1)
    const g = fakes({ answers: [], running: false })
    await assert.rejects(startSandboxedBuild({ adapter: a, ref: 'HEAD', port: 8304, config, deps: g.deps }), /the server stopped/)
  })

  it('a program the Node image does not have is refused before anything is checked out or started', async () => {
    const a = adapterFor({ kind: 'command', cmd: 'python3', args: ['app.py'] })
    const f = fakes()
    await assert.rejects(startSandboxedBuild({ adapter: a, ref: 'HEAD', port: 8305, config, deps: f.deps }), /"python3" does not run in the sandbox/)
    assert.equal(f.calls.length, 0)
  })

  it('an app that exits at once reports its own last lines', async () => {
    const a = adapterFor({ kind: 'command', cmd: 'npm', args: ['start'] })
    const f = fakes({ app: { ok: false, error: 'Could not find the app address.' } })
    await assert.rejects(startSandboxedBuild({ adapter: a, ref: 'HEAD', port: 8307, config, deps: f.deps }), e => /Could not find the app address/.test(e.message) && e.logs === 'last app lines')
    assert.equal(f.destroyedCount(), 1)
  })

  it('a service that does not come up stops the build and everything is removed', async () => {
    const a = adapterFor({ kind: 'command', cmd: 'npm', args: ['start'] }, { services: [{ kind: 'redis', name: 'cache' }] })
    const f = fakes({ services: { ok: false, error: 'Service cache did not become ready within 90 seconds.', logs: 'redis log' } })
    await assert.rejects(startSandboxedBuild({ adapter: a, ref: 'HEAD', port: 8306, config, deps: f.deps }), /did not become ready/)
    assert.equal(f.destroyedCount(), 1)
  })
})
