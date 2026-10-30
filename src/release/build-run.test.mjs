// The build runner with a tiny local fixture app (written by the test): output capture, fast failure, process-group stop.
//   node --test src/release/build-run.test.mjs
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBuild } from './build.mjs'
import { profileToAdapter } from './onboard/profile.mjs'

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim()
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const portOpen = port => new Promise(res => { const s = createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))) }) // true = free

let repo, work
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'bld-repo-')); work = mkdtempSync(join(tmpdir(), 'bld-work-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'ok.js'), "const p=+process.argv[2];require('http').createServer((q,r)=>r.end('hello')).listen(p,'127.0.0.1');console.log('listening',p)\n")
  writeFileSync(join(repo, 'crash.js'), "console.error('Error: Cannot find module \"left-pad\"');process.exit(3)\n")
  writeFileSync(join(repo, 'quiet.js'), "setInterval(()=>{},1000)\n") // never answers
  // a launcher that starts the real server as ITS child, like yarn or npm do
  writeFileSync(join(repo, 'launch.js'), "const {spawn}=require('child_process');spawn(process.execPath,['ok.js',process.argv[2]],{stdio:'inherit'});setInterval(()=>{},1000)\n")
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'tag', 'v1')
})
after(() => { /* temp dirs are left to the OS */ })

const adapterFor = (file, extra = {}) => profileToAdapter({ name: 'fx', repo, workRoot: work, serve: { kind: 'command', cmd: 'node', args: [file, '{port}'] }, ready: { path: '/', timeoutMs: 4000 }, ...extra }, { env: { PATH: process.env.PATH } })

describe('startBuild with a profile adapter', () => {
  it('starts, answers, and keeps the app output', async () => {
    const port = await freePort()
    const b = await startBuild({ adapter: adapterFor('ok.js'), ref: 'v1', port })
    try {
      assert.equal(await (await fetch(b.base + '/')).text(), 'hello')
      assert.match(b.logTail(), /listening/)
    } finally { await b.stop() }
  })
  it('a server that crashes fails fast and the error carries its last output', async () => {
    const t0 = Date.now()
    await assert.rejects(startBuild({ adapter: adapterFor('crash.js'), ref: 'v1', port: await freePort() }), e => {
      assert.match(e.message, /the server stopped: 3/)
      assert.match(e.logs, /Cannot find module "left-pad"/)
      return true
    })
    assert.ok(Date.now() - t0 < 3500, 'did not wait for the whole timeout')
  })
  it('a server that never answers fails after the readiness timeout, and says so', async () => {
    const t0 = Date.now()
    await assert.rejects(startBuild({ adapter: adapterFor('quiet.js', { ready: { path: '/', timeoutMs: 1500 } }), ref: 'v1', port: await freePort() }), e => { assert.match(e.message, /within 2 s|within 1 s/); return true })
    assert.ok(Date.now() - t0 < 4000)
  })
  it('stopping stops the whole process tree, so the port is free again', async () => {
    const port = await freePort()
    const b = await startBuild({ adapter: adapterFor('launch.js'), ref: 'v1', port })
    assert.equal(await portOpen(port), false, 'in use while running')
    await b.stop()
    for (let i = 0; i < 30 && !(await portOpen(port)); i++) await new Promise(r => setTimeout(r, 100))
    assert.equal(await portOpen(port), true, 'the grandchild server is gone')
  })
})
