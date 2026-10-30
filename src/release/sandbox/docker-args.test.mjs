// Tests for the docker argument policy. Offline, no docker daemon.
//   node --test src/release/sandbox/docker-args.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LABEL, ALLOWED_CAPS, isRunId, isShortName, isImage, isEnvKey, isEnvValue, names,
  networkCreateArgs, volumeCreateArgs, networkConnectArgs, startArgs,
  createArgs, runArgs, execArgs, inspectIpArgs, listArgs, listAllArgs,
  removeArgs, initVolumeArgs
} from './docker-args.mjs'

function goodPlan(role) {
  return {
    runId: 'abc123',
    short: role,
    role,
    image: 'myorg/myapp:1.2.3',
    networks: ['neta', 'netb'],
    aliases: ['web'],
    volume: { short: 'data', path: '/work' },
    workdir: '/work',
    user: '1000:1000',
    cmd: ['node', 'server.mjs'],
    env: { BETA: '2', ALPHA: '1' },
    tmpfs: ['/cache'],
    caps: role === 'service' ? ['CHOWN'] : [],
    limits: { memoryMb: 256, cpus: 1, pids: 64 },
    interactive: false,
    detach: false,
    rm: false,
    readOnly: true
  }
}

describe('constants and validators', () => {
  it('LABEL is behique', () => {
    assert.equal(LABEL, 'behique')
  })
  it('isRunId accepts good and refuses bad', () => {
    assert.equal(isRunId('abc123'), true)
    assert.equal(isRunId('ABC123'), false)
    assert.equal(isRunId('ab'), false)
    assert.equal(isRunId('a'.repeat(17)), false)
    assert.equal(isRunId('ab c12'), false)
    assert.equal(isRunId(42), false)
  })
  it('isShortName accepts good and refuses bad', () => {
    assert.equal(isShortName('a'), true)
    assert.equal(isShortName('web-1'), true)
    assert.equal(isShortName('-web'), false)
    assert.equal(isShortName('A'), false)
    assert.equal(isShortName('a'.repeat(32)), false)
    assert.equal(isShortName('a b'), false)
  })
  it('isImage pins tag and refuses registry, latest, digest', () => {
    assert.equal(isImage('myorg/myapp:1.2.3'), true)
    assert.equal(isImage('library/node:20.1.0'), true)
    assert.equal(isImage('registry.example.com/img:1.0'), false)
    assert.equal(isImage('myorg/myapp:latest'), false)
    assert.equal(isImage('myorg/myapp'), false)
    assert.equal(isImage('myorg/myapp@sha256:abc'), false)
    assert.equal(isImage('MyOrg/app:1.0'), false)
    assert.equal(isImage('localhost:5000/img:1.0'), false)
  })
  it('isEnvKey refuses LD_ and DOCKER_ and bad case', () => {
    assert.equal(isEnvKey('PORT'), true)
    assert.equal(isEnvKey('A1_B2'), true)
    assert.equal(isEnvKey('LD_PRELOAD'), false)
    assert.equal(isEnvKey('DOCKER_HOST'), false)
    assert.equal(isEnvKey('lower'), false)
    assert.equal(isEnvKey('1ABC'), false)
  })
  it('isEnvValue refuses newline and long values', () => {
    assert.equal(isEnvValue('hello'), true)
    assert.equal(isEnvValue('a\nb'), false)
    assert.equal(isEnvValue('a\rb'), false)
    assert.equal(isEnvValue('a\0b'), false)
    assert.equal(isEnvValue('x'.repeat(2001)), false)
    assert.equal(isEnvValue('x'.repeat(2000)), true)
  })
  it('names builds bq names', () => {
    assert.equal(names('abc123', 'web'), 'bq-abc123-web')
    assert.equal(names('ABC123', 'web'), null)
    assert.equal(names('abc123', '-web'), null)
  })
})

describe('simple builders produce exact arrays', () => {
  it('networkCreateArgs internal and not', () => {
    assert.deepEqual(networkCreateArgs({ runId: 'abc123', short: 'neta', internal: true }), {
      ok: true,
      args: ['network', 'create', '--driver', 'bridge', '--internal', '--label', 'behique=1', '--label', 'behique.run=abc123', 'bq-abc123-neta']
    })
    assert.deepEqual(networkCreateArgs({ runId: 'abc123', short: 'neta', internal: false }), {
      ok: true,
      args: ['network', 'create', '--driver', 'bridge', '--label', 'behique=1', '--label', 'behique.run=abc123', 'bq-abc123-neta']
    })
  })
  it('volumeCreateArgs', () => {
    assert.deepEqual(volumeCreateArgs({ runId: 'abc123', short: 'data' }), {
      ok: true, args: ['volume', 'create', '--label', 'behique=1', '--label', 'behique.run=abc123', 'bq-abc123-data']
    })
  })
  it('networkConnectArgs with aliases', () => {
    assert.deepEqual(networkConnectArgs({ runId: 'abc123', networkShort: 'neta', containerShort: 'web', aliases: ['a', 'b'] }), {
      ok: true, args: ['network', 'connect', '--alias', 'a', '--alias', 'b', 'bq-abc123-neta', 'bq-abc123-web']
    })
    assert.deepEqual(networkConnectArgs({ runId: 'abc123', networkShort: 'neta', containerShort: 'web' }), {
      ok: true, args: ['network', 'connect', 'bq-abc123-neta', 'bq-abc123-web']
    })
    assert.equal(networkConnectArgs({ runId: 'abc123', networkShort: 'neta', containerShort: 'web', aliases: ['BAD'] }).ok, false)
  })
  it('startArgs attach and not', () => {
    assert.deepEqual(startArgs({ runId: 'abc123', short: 'web' }), { ok: true, args: ['start', 'bq-abc123-web'] })
    assert.deepEqual(startArgs({ runId: 'abc123', short: 'web', attach: true }), { ok: true, args: ['start', '-a', 'bq-abc123-web'] })
  })
  it('execArgs exact array with sorted env', () => {
    const r = execArgs({ runId: 'abc123', short: 'web', cmd: ['ls', '-la'], env: { B: '2', A: '1' }, workdir: '/work' })
    assert.deepEqual(r, { ok: true, args: ['exec', '--workdir', '/work', '--env', 'A=1', '--env', 'B=2', 'bq-abc123-web', 'ls', '-la'] })
  })
  it('inspectIpArgs exact format', () => {
    const r = inspectIpArgs({ runId: 'abc123', short: 'web', networkShort: 'neta' })
    assert.deepEqual(r, { ok: true, args: ['inspect', '--format', '{{(index .NetworkSettings.Networks "bq-abc123-neta").IPAddress}}', 'bq-abc123-web'] })
  })
  it('listArgs for each kind', () => {
    assert.deepEqual(listArgs({ runId: 'abc123', kind: 'container' }), { ok: true, args: ['ps', '-aq', '--filter', 'label=behique.run=abc123'] })
    assert.deepEqual(listArgs({ runId: 'abc123', kind: 'network' }), { ok: true, args: ['network', 'ls', '-q', '--filter', 'label=behique.run=abc123'] })
    assert.deepEqual(listArgs({ runId: 'abc123', kind: 'volume' }), { ok: true, args: ['volume', 'ls', '-q', '--filter', 'label=behique.run=abc123'] })
    assert.deepEqual(listAllArgs({ kind: 'container' }), { ok: true, args: ['ps', '-aq', '--filter', 'label=behique=1'] })
    assert.deepEqual(listAllArgs({ kind: 'network' }), { ok: true, args: ['network', 'ls', '-q', '--filter', 'label=behique=1'] })
    assert.deepEqual(listAllArgs({ kind: 'volume' }), { ok: true, args: ['volume', 'ls', '-q', '--filter', 'label=behique=1'] })
  })
  it('removeArgs exact arrays and bad ids refused', () => {
    const id = 'a'.repeat(12)
    assert.deepEqual(removeArgs({ kind: 'container', ids: [id] }), { ok: true, args: ['rm', '-f', '-v', id] })
    assert.deepEqual(removeArgs({ kind: 'network', ids: [id, 'bq-abc123-web'] }), { ok: true, args: ['network', 'rm', id, 'bq-abc123-web'] })
    assert.deepEqual(removeArgs({ kind: 'volume', ids: [id] }), { ok: true, args: ['volume', 'rm', '-f', id] })
    assert.equal(removeArgs({ kind: 'container', ids: ['--privileged'] }).ok, false)
    assert.equal(removeArgs({ kind: 'container', ids: [] }).ok, false)
    assert.equal(removeArgs({ kind: 'container', ids: ['ABC'] }).ok, false)
    assert.equal(removeArgs({ kind: 'container', ids: ['/etc/passwd'] }).ok, false)
  })
  it('initVolumeArgs exact array', () => {
    const r = initVolumeArgs({ runId: 'abc123', short: 'data', image: 'myorg/myapp:1.2.3', uid: 1000, gid: 1000 })
    assert.deepEqual(r, {
      ok: true,
      args: ['run', '--rm', '--label', 'behique=1', '--label', 'behique.run=abc123', '--user', '0:0', '--cap-drop=ALL', '--cap-add=CHOWN', '--security-opt=no-new-privileges', '--network', 'none', '--volume', 'bq-abc123-data:/work', 'myorg/myapp:1.2.3', 'chown', '1000:1000', '/work']
    })
  })
})

describe('createArgs and runArgs', () => {
  it('full good plan for each role gives exact array shape', () => {
    for (const role of ['install', 'app', 'service', 'seed']) {
      const p = goodPlan(role)
      const c = createArgs(p)
      assert.equal(c.ok, true, role)
      assert.equal(c.args[0], 'create')
      assert.ok(c.args.includes('myorg/myapp:1.2.3'))
      assert.ok(!c.args.includes('-d'))
      assert.ok(!c.args.includes('--rm'))
      const r = runArgs({ ...p, detach: true, rm: true })
      assert.equal(r.ok, true, role)
      assert.equal(r.args[0], 'run')
      assert.ok(r.args.includes('-d'))
      assert.ok(r.args.includes('--rm'))
      // create never has -d or --rm even when asked
      const c2 = createArgs({ ...p, detach: true, rm: true })
      assert.equal(c2.ok, true)
      assert.ok(!c2.args.includes('-d'))
      assert.ok(!c2.args.includes('--rm'))
    }
  })
  it('always present flags are present for every role', () => {
    for (const role of ['install', 'app', 'service', 'seed']) {
      const r = createArgs(goodPlan(role))
      assert.equal(r.ok, true)
      const a = r.args
      assert.ok(a.includes('--cap-drop=ALL'))
      assert.ok(a.includes('--security-opt=no-new-privileges'))
      assert.ok(a.includes('--pids-limit'))
      assert.ok(a.includes('--memory'))
      assert.ok(a.includes('--memory-swap'))
      assert.ok(a.includes('--cpus'))
      assert.ok(a.includes('--init'))
      assert.ok(a.includes('--read-only'))
      assert.ok(a.includes('--tmpfs'))
    }
  })
  it('env sorted and tmpfs default /tmp', () => {
    const r = createArgs(goodPlan('app'))
    assert.equal(r.ok, true)
    const envs = r.args.filter((_, i) => r.args[i - 1] === '--env')
    assert.deepEqual(envs, ['ALPHA=1', 'BETA=2'])
    assert.ok(r.args.includes('/tmp:rw,exec,nosuid,size=1g'))
    const r2 = createArgs({ ...goodPlan('app'), tmpfs: ['/tmp'] })
    assert.equal(r2.ok, true)
    assert.equal(r2.args.filter((x) => x.startsWith('/tmp:')).length, 1)
  })
  it('caps only for service and only from allowed list', () => {
    assert.equal(createArgs({ ...goodPlan('app'), caps: ['CHOWN'] }).ok, false)
    assert.equal(createArgs({ ...goodPlan('service'), caps: ['CHOWN'] }).ok, true)
    assert.equal(createArgs({ ...goodPlan('service'), caps: ['SYS_ADMIN'] }).ok, false)
    for (const c of ALLOWED_CAPS) {
      assert.equal(createArgs({ ...goodPlan('service'), caps: [c] }).ok, true)
    }
  })
  it('root user refused, null only for service', () => {
    assert.equal(createArgs({ ...goodPlan('app'), user: '0:0' }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), user: 'root' }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), user: '0:5' }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), user: '00:00' }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), user: '1000:0' }).ok, false)
    assert.equal(createArgs({ ...goodPlan('service'), user: null }).ok, true)
    assert.equal(createArgs({ ...goodPlan('app'), user: null }).ok, false)
    assert.equal(createArgs({ ...goodPlan('install'), user: null }).ok, false)
    assert.equal(createArgs({ ...goodPlan('seed'), user: null }).ok, false)
  })
  it('bind mount looking volume refused', () => {
    assert.equal(createArgs({ ...goodPlan('app'), volume: { short: '/etc:/work', path: '/work' } }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), volume: { short: '..', path: '/work' } }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), volume: { short: 'data', path: '/etc/passwd' } }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), workdir: '/etc' }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), workdir: '/work/../etc' }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), tmpfs: ['/tmp/../etc'] }).ok, false)
  })
  it('unknown property refused', () => {
    const r = createArgs({ ...goodPlan('app'), publish: true })
    assert.equal(r.ok, false)
    assert.match(r.error, /Unknown option: publish/)
  })
  it('limits out of range refused', () => {
    assert.equal(createArgs({ ...goodPlan('app'), limits: { memoryMb: 8, cpus: 1, pids: 64 } }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), limits: { memoryMb: 256, cpus: 99, pids: 64 } }).ok, false)
    assert.equal(createArgs({ ...goodPlan('app'), limits: { memoryMb: 256, cpus: 1, pids: 4 } }).ok, false)
    const { limits, ...rest } = goodPlan('app')
    assert.equal(createArgs(rest).ok, false)
  })
  it('cmd starting with dash refused', () => {
    assert.equal(createArgs({ ...goodPlan('app'), cmd: ['--privileged'] }).ok, false)
  })
  it('readOnly false only for service', () => {
    assert.equal(createArgs({ ...goodPlan('app'), readOnly: false }).ok, false)
    assert.equal(createArgs({ ...goodPlan('service'), readOnly: false }).ok, true)
  })
  it('mounts the volume with nocopy so the init step is not undone', () => {
    const r = createArgs(goodPlan('app'))
    assert.ok(r.args.includes('bq-abc123-data:/work:nocopy'))
  })
  it('first network only on command', () => {
    const r = createArgs(goodPlan('app'))
    assert.equal(r.ok, true)
    const nets = r.args.filter((_, i) => r.args[i - 1] === '--network')
    assert.deepEqual(nets, ['bq-abc123-neta'])
  })
})

describe('property based check on generated plans', () => {
  it('ok results never carry hostile flags or paths', () => {
    let seed = 123456789
    function rnd() {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    function pick(arr) {
      return arr[Math.floor(rnd() * arr.length)]
    }
    const goodShorts = ['web', 'neta', 'data', 'app-1']
    const hostile = ['--privileged', '$(id)', '--mount', '/etc/passwd', '/var/run/docker.sock', '/root/x', '/Users/x', 'a\nb', '-p', '--device', '--entrypoint', 'x; rm -rf /', '..', '/etc:/work', 'latest', 'LD_PRELOAD', '']
    const exactForbidden = ['--privileged', '-p', '--publish', '--mount', '--device', '--entrypoint']
    for (let i = 0; i < 400; i++) {
      const mix = (good) => (rnd() < 0.3 ? pick(hostile) : good)
      const role = pick(['install', 'app', 'service', 'seed'])
      const plan = {
        runId: mix('abc123'),
        short: mix('web'),
        role,
        image: mix('myorg/myapp:1.2.3'),
        networks: [mix('neta')],
        aliases: [],
        volume: rnd() < 0.5 ? { short: mix('data'), path: mix('/work') } : null,
        workdir: rnd() < 0.5 ? mix('/work') : undefined,
        user: mix('1000:1000'),
        cmd: [mix('node'), 'server.mjs'],
        env: { HELLO: mix('world') },
        tmpfs: [],
        caps: [],
        limits: { memoryMb: 256, cpus: 1, pids: 64 },
        interactive: false,
        detach: false,
        rm: false,
        readOnly: true
      }
      const c = createArgs(plan)
      const r = runArgs(plan)
      for (const out of [c, r]) {
        if (out.ok === true) {
          for (const f of exactForbidden) {
            assert.ok(!out.args.includes(f), `forbidden flag ${f} in ${JSON.stringify(out.args)}`)
          }
          assert.ok(!out.args.includes('-t'), 'must never include -t')
          // the docker flags (before the image, env values excluded): the command after the image is the program's own business inside the container
          const head = out.args.slice(0, out.args.indexOf(plan.image)).filter((a, k, arr) => arr[k - 1] !== '--env')
          for (const a of head) {
            assert.ok(!String(a).includes('docker.sock'), `docker.sock in ${a}`)
            for (const pre of ['/etc', '/var/run', '/root', '/Users']) {
              assert.ok(!(String(a) === pre || String(a).startsWith(pre + '/') || String(a).includes(':' + pre)), `sensitive path ${a}`)
            }
          }
        } else {
          assert.equal(typeof out.error, 'string')
          assert.ok(out.error.length > 0)
        }
      }
    }
  })
})
