// Run: node --test src/release/sandbox/launch.test.mjs   (local processes and sockets only)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const LAUNCH = join(dirname(fileURLToPath(import.meta.url)), 'launch.mjs')
const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
const freePort = async () => { const s = createServer().listen(0, '127.0.0.1'); await new Promise(r => s.once('listening', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p }
const ask = (host, port) => new Promise((resolve, reject) => { const c = connect({ host, port }); c.once('error', reject); c.once('close', () => reject(new Error('closed without an answer'))); c.on('data', d => { resolve(String(d)); c.destroy() }); c.write('x') })

describe('launch.mjs', () => {
  it('refuses a bad command line', async () => {
    for (const argv of [[], ['abc', '--', 'node'], ['8000', 'node'], ['8000', '--']]) {
      const code = await new Promise(r => spawn('node', [LAUNCH, ...argv], { stdio: 'ignore' }).on('exit', r))
      assert.equal(code, 2)
    }
  })
  it('makes a localhost-only server reachable on the machine address, and passes the exit code through', { skip: !lan && 'no non-loopback address' }, async () => {
    const port = await freePort()
    const server = `require('net').createServer(s=>s.on('data',()=>s.end('hello from localhost'))).listen(${port},'127.0.0.1')`
    const child = spawn('node', [LAUNCH, String(port), '--', 'node', '-e', server], { stdio: 'ignore' })
    let answer
    for (let i = 0; i < 40 && !answer; i++) { try { answer = await ask(lan, port) } catch { await new Promise(r => setTimeout(r, 100)) } }
    child.kill('SIGTERM')
    assert.equal(answer, 'hello from localhost')
    await new Promise(r => child.on('exit', r))
  })
  it('does not get in the way of an app that listens on every address', { skip: !lan && 'no non-loopback address' }, async () => {
    const port = await freePort()
    const server = `require('net').createServer(s=>s.on('data',()=>s.end('hello from everywhere'))).listen(${port},'0.0.0.0')`
    const child = spawn('node', [LAUNCH, String(port), '--', 'node', '-e', server], { stdio: 'ignore' })
    let answer
    for (let i = 0; i < 40 && !answer; i++) { try { answer = await ask(lan, port) } catch { await new Promise(r => setTimeout(r, 100)) } }
    await new Promise(r => setTimeout(r, 800)) // long enough for the launcher to look and decide it has nothing to relay
    const again = await ask(lan, port)
    child.kill('SIGTERM')
    assert.equal(answer, 'hello from everywhere'); assert.equal(again, 'hello from everywhere')
    await new Promise(r => child.on('exit', r))
  })
  it('exits with the command\'s own exit code', async () => {
    const code = await new Promise(r => spawn('node', [LAUNCH, '8000', '--', 'node', '-e', 'process.exit(7)'], { stdio: 'ignore' }).on('exit', r))
    assert.equal(code, 7)
  })
  it('does not use a shell: metacharacters in an argument stay plain text', async () => {
    let out = ''
    const c = spawn('node', [LAUNCH, '8000', '--', 'echo', 'a; echo b', '$(id)'], { stdio: ['ignore', 'pipe', 'ignore'] })
    c.stdout.on('data', d => { out += d })
    await new Promise(r => c.on('exit', r))
    assert.equal(out.trim(), 'a; echo b $(id)')
  })
})
