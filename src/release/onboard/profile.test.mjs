// Tests for the app profile: validation, normalisation, commands, adapter, save/load.
//   node --test src/release/onboard/profile.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOWED_COMMANDS, describeCommands, loadProfile, normalizeProfile, profileToAdapter, saveProfile, validateProfile } from './profile.mjs'

function validStatic() {
  return {
    name: 'musicblocks',
    repo: '~/dev/behique-apps/musicblocks',
    workRoot: '~/dev/behique-apps',
    defaults: { good: 'v3.8.0', cand: 'master' },
    serve: { kind: 'static', overrides: { '/env.js': 'window.MB_ENV="development";' } },
    ready: { path: '/', timeoutMs: 30000 },
    viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
    setup: [{ type: 'click_at', x: 220, y: 155 }],
    regions: { 'edge-left': { x: 0, y: 0, w: 8, h: 800 } },
    anchors: { workspace: { x: 520, y: 80, w: 400, h: 600 } },
    notes: 'unsure about click',
  }
}

function validCommand() {
  return {
    name: 'my-app',
    repo: '/tmp/repo',
    workRoot: '/tmp/work',
    serve: { kind: 'command', cmd: 'npm', args: ['run', 'dev', '--', '--port', '{port}'], install: [{ cmd: 'npm', args: ['ci'] }], basePath: '' },
  }
}

describe('validateProfile', () => {
  it('accepts a valid profile', () => {
    assert.deepEqual(validateProfile(validStatic()), [])
  })

  it('reports all problems together', () => {
    const p = {
      name: 'Bad Name!',
      workRoot: '~/w',
      serve: { kind: 'static' },
      viewport: { width: 0, height: 800, deviceScaleFactor: 3 },
      regions: { bad: { x: 0, y: 0, w: 0, h: -1 } },
      bogus: true,
    }
    const problems = validateProfile(p)
    assert.ok(problems.some(m => m.includes('name')), 'bad name')
    assert.ok(problems.some(m => m.includes('repo')), 'missing repo')
    assert.ok(problems.some(m => m.includes('unknown field')), 'unknown field')
    assert.ok(problems.some(m => m.includes('viewport.width')), 'bad viewport')
    assert.ok(problems.some(m => m.includes('regions.bad')), 'bad region')
    assert.ok(problems.length >= 5, `expected many problems, got ${problems.length}`)
  })

  it('refuses an executable outside the allowlist', () => {
    const p = validCommand()
    p.serve.cmd = 'curl'
    assert.ok(validateProfile(p).some(m => m.includes('curl')))
  })

  it('refuses a path in cmd', () => {
    const p = validCommand()
    p.serve.cmd = '/bin/npm'
    const problems = validateProfile(p)
    assert.ok(problems.some(m => m.includes('bare name')))
  })

  it('refuses a shell operator in args', () => {
    const p = validCommand()
    p.serve.args = ['run', 'dev; rm -rf /']
    assert.ok(validateProfile(p).some(m => m.includes('shell operator')))
  })

  it('refuses overrides with a bad key', () => {
    const p = validStatic()
    p.serve.overrides = { 'env.js': 'x' }
    assert.ok(validateProfile(p).some(m => m.includes('must start with /')))
  })

  it('checks setup, viewport and regions', () => {
    const p = validStatic()
    p.setup = [{ type: 'wait', ms: 9000 }]
    p.viewport = { width: 1280, height: 800, deviceScaleFactor: 5 }
    p.regions = { r: { x: 0, y: 0, w: 0, h: 2 } }
    const problems = validateProfile(p)
    assert.ok(problems.some(m => m.includes('ms')), JSON.stringify(problems))
    assert.ok(problems.some(m => m.includes('deviceScaleFactor')), JSON.stringify(problems))
    assert.ok(problems.some(m => m.includes('regions.r')), JSON.stringify(problems))
  })

  it('refuses the arguments that run inline code, program by program', () => {
    const table = {
      node: ['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--loader', '--experimental-loader', '--eval=x', '--print=x'],
      python3: ['-c'],
      php: ['-r', '-R', '-B', '-E', '--run'],
      npm: ['-c', '--call', '--call=x'],
      npx: ['-c', '--call'],
      pnpm: ['-c'],
      yarn: ['-c'],
    }
    for (const [cmd, args] of Object.entries(table)) {
      for (const arg of args) {
        const p = validCommand()
        p.serve.cmd = cmd
        p.serve.args = [arg]
        const problems = validateProfile(p)
        assert.ok(problems.some(m => m.includes('inline code')), `${cmd} ${arg}: ${JSON.stringify(problems)}`)
      }
    }
  })

  it('does not mistake a framework port flag for inline code', () => {
    for (const [cmd, args] of [['pnpm', ['--filter', 'web', 'dev', '--', '-p', '{port}']], ['yarn', ['dev', '-p', '{port}']], ['npm', ['run', 'dev', '--', '-p', '{port}']]]) {
      const p = validCommand()
      p.serve.cmd = cmd
      p.serve.args = args
      assert.deepEqual(validateProfile(p), [], `${cmd} ${args.join(' ')}`)
    }
    const p = validCommand()
    p.serve.cmd = 'node'
    p.serve.args = ['-p', '1']
    assert.ok(validateProfile(p).some(m => m.includes('inline code')), 'but node -p still is')
  })

  it('allows a real file argument to node', () => {
    const p = validCommand()
    p.serve.cmd = 'node'
    p.serve.args = ['script.mjs']
    assert.deepEqual(validateProfile(p), [])
  })
})

describe('normalizeProfile', () => {
  it('fills defaults', () => {
    const p = validCommand()
    delete p.serve.install
    delete p.serve.basePath
    const n = normalizeProfile(p)
    assert.deepEqual(n.viewport, { width: 1280, height: 800, deviceScaleFactor: 2 })
    assert.deepEqual(n.ready, { path: '/', timeoutMs: 30000 })
    assert.deepEqual(n.setup, [])
    assert.deepEqual(n.regions, {})
    assert.deepEqual(n.anchors, {})
    assert.deepEqual(n.serve.install, [])
    assert.equal(n.serve.basePath, '')
  })

  it('keeps an explicit install list', () => {
    const n = normalizeProfile(validCommand())
    assert.deepEqual(n.serve.install, [{ cmd: 'npm', args: ['ci'] }])
  })

  it('fills static overrides default', () => {
    const p = validStatic()
    delete p.serve.overrides
    const n = normalizeProfile(p)
    assert.deepEqual(n.serve.overrides, {})
  })

  it('throws on invalid input', () => {
    assert.throws(() => normalizeProfile({}), /invalid profile/)
  })
})

describe('describeCommands', () => {
  it('says when the copy gets a git commit, and refuses a gitHistory that is not a boolean', () => {
    const p = validCommand(); p.serve.gitHistory = true
    assert.ok(describeCommands(p).some(l => /one git commit/.test(l)))
    assert.deepEqual(validateProfile(p), [])
    p.serve.gitHistory = 'yes'
    assert.ok(validateProfile(p).some(x => /gitHistory/.test(x)))
  })

  it('describes the static server', () => {
    assert.deepEqual(describeCommands(validStatic()), ['serve: built-in static file server'])
  })

  it('lists every command', () => {
    const lines = describeCommands(validCommand())
    assert.deepEqual(lines, ['install: npm ci', 'serve: npm run dev -- --port {port}'])
  })

  it('warns for npx and dlx', () => {
    const p = validCommand()
    p.serve.cmd = 'npx'
    p.serve.args = ['vite', '--port', '{port}']
    const lines = describeCommands(p)
    assert.ok(lines[1].endsWith(' (downloads and runs packages from the internet)'), lines[1])
    const q = validCommand()
    q.serve.install = [{ cmd: 'pnpm', args: ['dlx', 'foo'] }]
    const lines2 = describeCommands(q)
    assert.ok(lines2[0].endsWith(' (downloads and runs packages from the internet)'), lines2[0])
  })
})

describe('profileToAdapter', () => {
  it('expands ~/ with fake home and sets harmless cleanPaths', () => {
    const a = profileToAdapter(validStatic(), { home: '/fake/home' })
    assert.equal(a.repo, '/fake/home/dev/behique-apps/musicblocks')
    assert.equal(a.workRoot, '/fake/home/dev/behique-apps')
    assert.deepEqual(a.cleanPaths, ['.behique-never-exists'])
    assert.equal(a.feed, null)
    assert.equal(a.basePath, '')
  })

  it('builds static serve output', () => {
    const a = profileToAdapter(validStatic(), { home: '/fake/home', serverPath: '/srv/static-server.mjs' })
    const out = a.serve('/tmp/dir', 8123)
    assert.equal(out.cmd, 'node')
    assert.equal(out.args[0], '/srv/static-server.mjs')
    assert.equal(out.args[1], '/tmp/dir')
    assert.equal(out.args[2], '8123')
    assert.equal(JSON.parse(out.args[3])['/env.js'], 'window.MB_ENV="development";')
  })

  it('builds command serve output with port substituted', () => {
    const a = profileToAdapter(validCommand())
    const out = a.serve('/tmp/dir', 9000)
    assert.equal(out.cmd, 'npm')
    assert.ok(out.args.includes('9000'), JSON.stringify(out.args))
    assert.ok(!out.args.some(x => x.includes('{port}')))
  })

  it('prepare runs install steps in dir without a shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behique-prep-'))
    const script = join(dir, 'mark.mjs')
    writeFileSync(script, 'import { writeFileSync } from "node:fs"\nimport { join } from "node:path"\nwriteFileSync(join(process.cwd(), "did-run.txt"), "yes")\n')
    const p = validCommand()
    p.serve.install = [{ cmd: 'node', args: [script] }]
    const a = profileToAdapter(p)
    const res = await a.prepare(dir)
    assert.deepEqual(res, { entries: 0 })
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync(join(dir, 'did-run.txt'), 'utf8'), 'yes')
  })
})

describe('saveProfile and loadProfile', () => {
  it('round-trips through a temp dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behique-profiles-'))
    const p = validStatic()
    const path = saveProfile(p, dir)
    assert.ok(path.startsWith(dir))
    const loaded = loadProfile('musicblocks', dir)
    assert.equal(loaded.name, 'musicblocks')
    assert.deepEqual(loaded.viewport, p.viewport)
  })

  it('reads PROFILE_DIR from the environment at call time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behique-env-'))
    process.env.BEHIQUE_PROFILE_DIR = dir
    try {
      saveProfile(validStatic())
      const loaded = loadProfile('musicblocks')
      assert.equal(loaded.name, 'musicblocks')
    } finally {
      delete process.env.BEHIQUE_PROFILE_DIR
    }
  })

  it('refuses a bad name before touching the filesystem', () => {
    assert.throws(() => loadProfile('../evil'), /invalid profile name/)
    assert.throws(() => saveProfile({ ...validStatic(), name: '../evil' }), /invalid profile/)
  })

  it('throws a clear error when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'behique-missing-'))
    assert.throws(() => loadProfile('nope', dir), /not found/)
  })
})

describe('serve.prepare', () => {
  it('is validated like install and described as running before every start', () => {
    const p = validCommand()
    p.serve.prepare = [{ cmd: 'pnpm', args: ['exec', 'node', 'scripts/check-db.js'] }]
    assert.deepEqual(validateProfile(p), [])
    assert.ok(describeCommands(p).some(l => l === 'prepare (before every start): pnpm exec node scripts/check-db.js'))
    p.serve.prepare = [{ cmd: 'bash', args: ['-c', 'x'] }]
    assert.ok(validateProfile(p).some(x => x.includes('serve.prepare[0].cmd')))
    p.serve.prepare = 'pnpm'
    assert.deepEqual(validateProfile(p), ['serve.prepare must be an array'])
  })
})
