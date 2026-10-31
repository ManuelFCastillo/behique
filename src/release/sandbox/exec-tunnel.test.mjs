// Run: node --test src/release/sandbox/exec-tunnel.test.mjs   (local sockets and tiny system programs only, no docker)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { EventEmitter } from 'node:events'
import { dockerHostFor, makeDocker } from './docker-exec.mjs'
import { forwardLocal, sshTunnel } from './tunnel.mjs'

describe('dockerHostFor', () => {
  it('local when empty, ssh addresses pass, anything else is refused', () => {
    assert.equal(dockerHostFor(''), null)
    assert.equal(dockerHostFor(undefined), null)
    assert.equal(dockerHostFor('local'), null)
    assert.equal(dockerHostFor('ssh://hardac2'), 'ssh://hardac2')
    assert.equal(dockerHostFor('ssh://mcastill@10.0.0.2'), 'ssh://mcastill@10.0.0.2')
    assert.throws(() => dockerHostFor('ssh://x; rm -rf /'))
    assert.throws(() => dockerHostFor('http://example.com'))
    assert.throws(() => dockerHostFor('--privileged'))
  })
})

describe('makeDocker', () => {
  it('sets DOCKER_HOST only for a remote target and clears it for local', async () => {
    const remote = makeDocker({ target: 'ssh://hardac2', bin: 'sh', baseEnv: { PATH: process.env.PATH } })
    assert.equal((await remote(['-c', 'echo $DOCKER_HOST'])).stdout.trim(), 'ssh://hardac2')
    const local = makeDocker({ target: 'local', bin: 'sh', baseEnv: { PATH: process.env.PATH, DOCKER_HOST: 'ssh://other' } })
    assert.equal((await local(['-c', 'echo "[$DOCKER_HOST]"'])).stdout.trim(), '[]')
  })
  it('passes stdin, returns the exit code and stderr, never uses a shell', async () => {
    const cat = makeDocker({ bin: 'cat', baseEnv: process.env })
    assert.equal((await cat([], { input: Buffer.from('hello') })).stdout, 'hello')
    const sh = makeDocker({ bin: 'sh', baseEnv: process.env })
    const r = await sh(['-c', 'echo oops >&2; exit 3'])
    assert.equal(r.code, 3); assert.match(r.stderr, /oops/)
    const echo = makeDocker({ bin: 'echo', baseEnv: process.env })
    assert.equal((await echo(['a; echo b', '$(id)'])).stdout.trim(), 'a; echo b $(id)') // metacharacters stay plain text
  })
  it('times out and rejects bad arguments', async () => {
    const sleep = makeDocker({ bin: 'sleep', baseEnv: process.env })
    await assert.rejects(sleep(['5'], { timeoutMs: 100 }), /timed out/)
    await assert.rejects(sleep([1]), /array of strings/)
    await assert.rejects(sleep('x'), /array of strings/)
  })
  it('stops a command that goes silent, but not one that keeps printing', async () => {
    const sh = makeDocker({ bin: 'sh', baseEnv: process.env })
    await assert.rejects(sh(['-c', 'sleep 5'], { idleMs: 150 }), /stalled: no output for 0 s/)
    const r = await sh(['-c', 'for i in 1 2 3 4; do echo $i; sleep 0.1; done'], { idleMs: 300 })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /4/)
  })
})

describe('forwardLocal', () => {
  it('relays bytes both ways and stops on close', async () => {
    const echo = createServer(s => s.on('data', d => s.write(Buffer.concat([Buffer.from('echo:'), d])))).listen(0, '127.0.0.1')
    await new Promise(r => echo.once('listening', r))
    const target = echo.address().port
    const probe = createServer().listen(0, '127.0.0.1'); await new Promise(r => probe.once('listening', r))
    const listenPort = probe.address().port; await new Promise(r => probe.close(r))
    const fwd = await forwardLocal({ listenPort, host: '127.0.0.1', port: target })
    const got = await new Promise((resolve, reject) => {
      const c = connect(listenPort, '127.0.0.1'); c.once('error', reject)
      c.on('data', d => { resolve(String(d)); c.destroy() }); c.write('ping')
    })
    assert.equal(got, 'echo:ping')
    await fwd.close()
    await new Promise(r => echo.close(r))
    await assert.rejects(new Promise((res, rej) => { const c = connect(listenPort, '127.0.0.1'); c.once('connect', () => res(c.destroy())); c.once('error', rej) }))
  })
  it('refuses a host that is not an IPv4 address', async () => {
    await assert.rejects(forwardLocal({ listenPort: 1, host: 'example.com; id', port: 80 }), /IPv4/)
  })
})

describe('sshTunnel', () => {
  it('builds a fixed argument list and refuses bad hosts', async () => {
    await assert.rejects(sshTunnel({ sshHost: '-oProxyCommand=x', listenPort: 1, host: '1.2.3.4', port: 80 }), /valid ssh host/)
    await assert.rejects(sshTunnel({ sshHost: 'hardac2', listenPort: 1, host: '1.2.3.4;id', port: 80 }), /IPv4/)
    let seen
    const fake = (bin, args) => { seen = { bin, args }; const c = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => c.emit('exit'); setTimeout(() => c.emit('exit'), 20); return c }
    await assert.rejects(sshTunnel({ sshHost: 'hardac2', listenPort: 59999, host: '172.18.0.2', port: 8300, spawnFn: fake }), /stopped/)
    assert.equal(seen.bin, 'ssh')
    assert.deepEqual(seen.args, ['-N', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-L', '127.0.0.1:59999:172.18.0.2:8300', 'hardac2'])
  })
})
