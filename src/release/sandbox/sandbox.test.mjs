// sandbox tests: offline fake docker covering the lifecycle.
// Run: node --test src/release/sandbox/sandbox.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSandbox, cleanLog, cleanStale } from './sandbox.mjs'
import { isRunId } from './docker-args.mjs'

const IMAGE = 'node:22-bookworm-slim'
const LIMITS = { memoryMb: 512, cpus: 1, pids: 64 }

function makeFake(script = {}) {
  const calls = []
  const fn = async (args, opts) => {
    calls.push({ args: [...args], opts })
    for (const key of Object.keys(script)) {
      const entry = script[key]
      if (args[0] === key || args.join(' ').startsWith(key)) {
        if (typeof entry === 'function') {
          const r = await entry(args, calls.length)
          if (r) return r
        } else if (Array.isArray(entry)) {
          if (entry.length > 0) return entry.shift()
        } else if (entry && typeof entry === 'object') {
          return entry
        }
      }
    }
    if (script.__default) return script.__default
    return { code: 0, stdout: '', stderr: '' }
  }
  fn.calls = calls
  return fn
}

function sbWith(docker, extra = {}) {
  return createSandbox({
    docker,
    pack: async () => Buffer.from('archive-bytes'),
    sleep: async () => {},
    now: () => 0,
    log: () => {},
    newRunId: () => 'abc123def4',
    image: IMAGE,
    limits: LIMITS,
    ...extra
  })
}

test('prepare runs five steps in order and seed gets archive as input', async () => {
  const docker = makeFake()
  const sb = sbWith(docker)
  const r = await sb.prepare({ dir: '/tmp/x' })
  assert.equal(r.ok, true)
  assert.equal(docker.calls.length, 5)
  assert.deepEqual(docker.calls[0].args.slice(0, 2), ['network', 'create'])
  assert.ok(docker.calls[0].args.join(' ').includes('bq-abc123def4-open'))
  assert.ok(!docker.calls[0].args.includes('--internal'))
  assert.ok(docker.calls[1].args.includes('--internal'))
  assert.ok(docker.calls[1].args.join(' ').includes('bq-abc123def4-int'))
  assert.deepEqual(docker.calls[2].args.slice(0, 2), ['volume', 'create'])
  assert.ok(docker.calls[3].args.includes('chown'))
  const seed = docker.calls[4]
  assert.equal(seed.args[0], 'run')
  assert.ok(seed.args.includes('tar'))
  assert.ok(seed.opts && Buffer.isBuffer(seed.opts.input))
  assert.equal(seed.opts.input.toString(), 'archive-bytes')
  assert.ok(seed.args.includes('--rm'))
  assert.ok(seed.args.includes('-i'))
})

test('prepare stops after failing network creation', async () => {
  const docker = makeFake({ network: { code: 1, stdout: '', stderr: 'boom failed\nsecond line' } })
  const sb = sbWith(docker)
  const r = await sb.prepare({ dir: '/tmp/x' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('boom'))
  assert.equal(docker.calls.length, 1)
})

test('startServices waits for health and times out with logs', async () => {
  let healthCalls = 0
  const docker = makeFake()
  const orig = docker
  const counting = async (args, opts) => {
    if (args[0] === 'exec') {
      healthCalls += 1
      if (healthCalls < 3) return { code: 1, stdout: '', stderr: 'not yet' }
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    return orig(args, opts)
  }
  counting.calls = orig.calls
  const sb = sbWith(counting)
  const resolved = [{ name: 'db', image: 'postgres:16-alpine', env: {}, tmpfs: [], caps: [], cmd: ['postgres'], health: ['pg_isready'], alias: 'db' }]
  const r = await sb.startServices(resolved, { timeoutMs: 90000 })
  assert.equal(r.ok, true)
  assert.equal(healthCalls, 3)

  // never healthy
  let nowVal = 0
  const docker2 = makeFake({
    exec: { code: 1, stdout: '', stderr: 'sick' },
    logs: { code: 0, stdout: 'container log here', stderr: '' }
  })
  const sb2 = createSandbox({
    docker: docker2, pack: async () => Buffer.from('x'), sleep: async () => { nowVal += 1000 },
    now: () => nowVal, log: () => {}, newRunId: () => 'abc123def4', image: IMAGE, limits: LIMITS
  })
  const r2 = await sb2.startServices(resolved, { timeoutMs: 2000 })
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'Service db did not become ready within 2 seconds.')
  assert.ok(r2.logs.includes('container log here'))
  const logCall = docker2.calls.find((c) => c.args[0] === 'logs')
  assert.ok(logCall)
  assert.deepEqual(logCall.args.slice(0, 3), ['logs', '--tail', '200'])
})

test('startServices refuses missing cmd', async () => {
  const docker = makeFake()
  const sb = sbWith(docker)
  const r = await sb.startServices([{ name: 'db', image: 'postgres:16-alpine' }])
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Service db has no start command.')
})

test('install runs steps in order with create connect start and removes', async () => {
  const docker = makeFake({ start: { code: 0, stdout: 'hello\n', stderr: '' } })
  const sb = sbWith(docker)
  const r = await sb.install([{ cmd: 'npm', args: ['install'] }, { cmd: 'npm', args: ['run', 'build'] }], { env: { FOO: 'bar' } })
  assert.equal(r.ok, true)
  assert.equal(r.steps.length, 2)
  const verbs = docker.calls.map((c) => c.args[0])
  assert.deepEqual(verbs, ['create', 'network', 'start', 'rm', 'create', 'network', 'start', 'rm'])
  const createArgs = docker.calls[0].args
  assert.ok(createArgs.includes('--env'))
  const joined = createArgs.join('\n')
  assert.ok(joined.includes('CI=1'))
  assert.ok(joined.includes('HOME=/work/.home'))
  const startCall = docker.calls[2]
  assert.ok(startCall.args.includes('-a'))
})

test('install stops at first failure with code and cleaned tail', async () => {
  const docker = makeFake({
    start: [
      { code: 0, stdout: 'first ok', stderr: '' },
      { code: 3, stdout: 'out', stderr: '[31mfail text[0m' }
    ]
  })
  const sb = sbWith(docker)
  const r = await sb.install([{ cmd: 'npm', args: ['install'] }, { cmd: 'npm', args: ['test'] }])
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Step 2 (npm test) exited with code 3.')
  assert.ok(r.logs.includes('fail text'))
  assert.ok(!r.logs.includes(''))
})

test('install container on open and int, app only on int', async () => {
  const docker = makeFake({
    inspect: { code: 0, stdout: '10.0.0.5\n', stderr: '' },
    start: { code: 0, stdout: '', stderr: '' }
  })
  const sb = sbWith(docker)
  await sb.install([{ cmd: 'npm', args: ['install'] }])
  const createCall = docker.calls.find((c) => c.args[0] === 'create')
  assert.ok(createCall.args.includes('bq-abc123def4-open'))
  const connCall = docker.calls.find((c) => c.args[0] === 'network')
  assert.ok(connCall.args.join(' ').includes('bq-abc123def4-int'))
  docker.calls.length = 0
  const r = await sb.startApp({ cmd: 'node', args: ['server.js'], port: 3000 })
  assert.equal(r.ok, true)
  const runCall = docker.calls.find((c) => c.args[0] === 'run')
  assert.ok(runCall.args.join(' ').includes('--network bq-abc123def4-int'))
  assert.ok(!runCall.args.join(' ').includes('bq-abc123def4-open'))
  assert.ok(!docker.calls.some((c) => c.args[0] === 'network'))
})

test('startApp returns address and rejects non-IP', async () => {
  const docker = makeFake({ inspect: { code: 0, stdout: '172.18.0.4\n', stderr: '' } })
  const sb = sbWith(docker)
  const r = await sb.startApp({ cmd: 'node', args: [], port: 3000 })
  assert.equal(r.ok, true)
  assert.equal(r.host, '172.18.0.4')
  assert.equal(r.port, 3000)
  const docker2 = makeFake({ inspect: { code: 0, stdout: 'not-an-ip\n', stderr: '' } })
  const sb2 = sbWith(docker2)
  const r2 = await sb2.startApp({ cmd: 'node', args: [], port: 3000 })
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'Could not find the app address.')
})

test('recorded calls use known verbs and no privileged, ports or host paths', async () => {
  const docker = makeFake({
    inspect: { code: 0, stdout: '10.0.0.2\n', stderr: '' },
    start: { code: 0, stdout: '', stderr: '' },
    exec: { code: 0, stdout: '', stderr: '' }
  })
  const sb = sbWith(docker)
  await sb.prepare({ dir: '/tmp/x' })
  await sb.startServices([{ name: 'db', image: 'postgres:16-alpine', env: {}, tmpfs: [], caps: [], cmd: ['postgres'], health: ['pg_isready'], alias: 'db' }])
  await sb.install([{ cmd: 'npm', args: ['install'] }])
  await sb.startApp({ cmd: 'node', args: [], port: 3000 })
  await sb.logs()
  await sb.running()
  const known = new Set(['network', 'volume', 'run', 'create', 'start', 'exec', 'inspect', 'logs', 'ps', 'rm'])
  for (const c of docker.calls) {
    assert.ok(known.has(c.args[0]), 'unknown verb ' + c.args[0])
    const joined = c.args.join(' ')
    assert.ok(!joined.includes('--privileged'))
    assert.ok(!c.args.includes('-p'))
    for (const a of c.args) {
      assert.ok(!String(a).startsWith('/Users'))
    }
  }
})

test('destroy removes in order, tolerates failures, works before prepare and twice', async () => {
  const order = []
  const docker = async (args) => {
    order.push(args.join(' '))
    if (args[0] === 'ps') return { code: 0, stdout: 'bq-abc123def4-app\n', stderr: '' }
    if (args[0] === 'network') {
      if (args[1] === 'ls') return { code: 0, stdout: 'bq-abc123def4-int\n', stderr: '' }
      return { code: 1, stdout: '', stderr: 'nope' }
    }
    if (args[0] === 'volume') {
      if (args[1] === 'ls') return { code: 0, stdout: 'bq-abc123def4-work\n', stderr: '' }
      return { code: 1, stdout: '', stderr: 'nope' }
    }
    if (args[0] === 'rm') return { code: 1, stdout: '', stderr: 'nope' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const sb = sbWith(docker)
  const r = await sb.destroy()
  assert.equal(r.ok, true)
  assert.deepEqual(r.removed, { containers: 1, networks: 1, volumes: 1 })
  const rmIdx = order.findIndex((s) => s.startsWith('rm '))
  const netRmIdx = order.findIndex((s) => s.startsWith('network rm'))
  const volRmIdx = order.findIndex((s) => s.startsWith('volume rm'))
  assert.ok(rmIdx >= 0 && netRmIdx > rmIdx && volRmIdx > netRmIdx)
  // twice
  const r2 = await sb.destroy()
  assert.equal(r2.ok, true)
  // before prepare (empty lists)
  const dockerEmpty = makeFake()
  const sbEmpty = sbWith(dockerEmpty)
  const r3 = await sbEmpty.destroy()
  assert.equal(r3.ok, true)
  assert.deepEqual(r3.removed, { containers: 0, networks: 0, volumes: 0 })
})

test('cleanStale removes only old containers, networks and volumes and ignores unparseable dates', async () => {
  const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString()
  const newDate = new Date().toISOString()
  const removedCalls = []
  const ids = { container: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'], network: ['bq-oldrun1234-int', 'bq-newrun1234-int'], volume: ['bq-oldrun1234-work', 'bq-newrun1234-work'] }
  const docker = async (args) => {
    const line = args.join(' ')
    if (args[0] === 'ps') return { code: 0, stdout: ids.container.join('\n') + '\n', stderr: '' }
    if (args[0] === 'network' && args[1] === 'ls') return { code: 0, stdout: ids.network.join('\n') + '\n', stderr: '' }
    if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: ids.volume.join('\n') + '\n', stderr: '' }
    if (args.includes('inspect')) {
      assert.ok(line.includes('behique.run')) // the format asks for the creation time and the run label
      const id = args[args.length - 1]
      if (id === 'aaaaaaaaaaaa' || id.includes('oldrun')) return { code: 0, stdout: oldDate + ' oldrun1234\n', stderr: '' }
      if (id === 'bbbbbbbbbbbb' || id.includes('newrun')) return { code: 0, stdout: newDate + ' newrun1234\n', stderr: '' }
      return { code: 0, stdout: 'not a date\n', stderr: '' }
    }
    removedCalls.push(line)
    return { code: 0, stdout: '', stderr: '' }
  }
  const r = await cleanStale({ docker, olderThanMinutes: 120 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.removed, { containers: 1, networks: 1, volumes: 1 })
  assert.deepEqual(removedCalls, ['rm -f -v aaaaaaaaaaaa', 'network rm bq-oldrun1234-int', 'volume rm -f bq-oldrun1234-work'])
})

test('cleanStale finds an orphaned network and volume even when no container is left, and never throws', async () => {
  const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString()
  const calls = []
  const docker = async (args) => {
    if (args[0] === 'ps') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'network' && args[1] === 'ls') return { code: 0, stdout: 'bq-orphan0001-int\n', stderr: '' }
    if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: 'bq-orphan0001-work\n', stderr: '' }
    if (args.includes('inspect')) return { code: 0, stdout: oldDate + ' orphan0001\n', stderr: '' }
    calls.push(args.join(' '))
    return { code: 0, stdout: '', stderr: '' }
  }
  assert.deepEqual((await cleanStale({ docker })).removed, { containers: 0, networks: 1, volumes: 1 })
  assert.deepEqual(calls, ['network rm bq-orphan0001-int', 'volume rm -f bq-orphan0001-work'])
  const boom = async () => { throw new Error('daemon down') }
  assert.deepEqual(await cleanStale({ docker: boom }), { ok: true, removed: { containers: 0, networks: 0, volumes: 0 } })
})

test('cleanLog rules', async () => {
  assert.equal(cleanLog(123), '')
  assert.equal(cleanLog('\x1b[31mhello\x1b[0m MEH=> world'), 'hello MEH=> world') // escapes go, ordinary letters and symbols stay
  assert.equal(cleanLog('\x1b]0;title\x07text'), 'text')
  assert.equal(cleanLog('[31mhi[0m'), 'hi')
  assert.equal(cleanLog('a\x00b\x01c\nd\te'), 'abc\nd\te')
  const token = 'x'.repeat(40)
  assert.ok(cleanLog('prefix ' + token + ' suffix').includes('[redacted]'))
  assert.ok(!cleanLog('short token abc').includes('[redacted]'))
  const long = 'y '.repeat(2500) // spaces keep it from looking like a token
  assert.equal(cleanLog(long, 100).length, 100)
  assert.equal(cleanLog('abcdefghij', 5), 'fghij')
})

test('throwing docker turns into ok false and never propagates', async () => {
  const docker = async () => { throw new Error('spawn failed') }
  const sb = sbWith(docker)
  const r = await sb.prepare({ dir: '/tmp/x' })
  assert.equal(r.ok, false)
  assert.ok(typeof r.error === 'string')
  const r2 = await sb.destroy().catch(() => null)
  assert.ok(r2)
})

test('timed out rejection maps to timeout error', async () => {
  const docker = async () => { throw new Error('command timed out after 5s') }
  const sb = sbWith(docker)
  const r = await sb.prepare({ dir: '/tmp/x' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('timed out'))
})

test('invalid image fails every step and docker never called', async () => {
  const docker = makeFake()
  const sb = sbWith(docker, { image: 'not-an-image' })
  assert.ok(!isRunId('BAD'))
  const a = await sb.prepare({ dir: '/tmp/x' })
  const b = await sb.startServices([])
  const c = await sb.install([{ cmd: 'npm', args: ['x'] }])
  const d = await sb.startApp({ cmd: 'node', args: [], port: 3000 })
  const e = await sb.logs()
  const f = await sb.running()
  for (const r of [a, b, c, d, e, f]) {
    assert.equal(r.ok, false)
    assert.equal(r.error, 'invalid image.')
  }
  assert.equal(docker.calls.length, 0)
})

test('a stalled install step is removed and run again on a fresh container', async () => {
  let starts = 0
  const docker = makeFake({
    start: async () => {
      starts += 1
      if (starts === 1) throw new Error('docker start stalled: no output for 480 s')
      return { code: 0, stdout: 'ok', stderr: '' }
    }
  })
  const sb = sbWith(docker)
  const r = await sb.install([{ cmd: 'npm', args: ['ci'] }])
  assert.equal(r.ok, true)
  assert.equal(starts, 2)
  assert.equal(docker.calls.filter(c => c.args[0] === 'create').length, 2)
  assert.ok(docker.calls.some(c => c.args[0] === 'rm' && c.args.includes('-f')))
  assert.equal(docker.calls.find(c => c.args[0] === 'start').opts.idleMs, 480000)
})

test('an install step that stalls on every try fails with a clear message', async () => {
  const docker = makeFake({ start: async () => { throw new Error('docker start stalled: no output for 60 s') } })
  const sb = sbWith(docker)
  const r = await sb.install([{ cmd: 'npm', args: ['ci'] }], { stallMs: 60000 })
  assert.equal(r.ok, false)
  assert.match(r.error, /Step 1 \(npm ci\) stalled 2 times with no output for 60 seconds each/)
  assert.equal(docker.calls.filter(c => c.args[0] === 'start').length, 2)
})
