// Build runner: take a git ref of the app under test, check it out, install and seed it from a clean state, serve it.
//   node src/release/build.mjs 1.30.0 8300          start, check it answers, stop
//   node src/release/build.mjs 1.30.0 8300 --serve  keep it running until Ctrl-C
// A build is identified by its commit sha, never by the ref name, so a tag that moves cannot change a result.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkoutRef } from './checkout.mjs'
import { sandboxConfigFromEnv, startSandboxedBuild } from './sandbox/backend.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Serve the adapter's fixed feed files on localhost so every build sees the same data. */
function startFeedServer({ dir, port }) {
  const srv = createServer((req, res) => {
    const f = join(dir, req.url.split('?')[0].replace(/^\/+/, '') || 'feed.xml')
    if (!f.startsWith(dir) || !existsSync(f)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(readFileSync(f))
  })
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', () => resolve(srv)) })
}

const active = new Set() // running builds, so a cancelled run can stop them all (a killed process would leave its servers behind)
export async function stopAll() { await Promise.all([...active].map(b => b.stop())) }

export async function startBuild({ adapter, ref, port, sandbox = sandboxConfigFromEnv(process.env) }) {
  const t0 = Date.now()
  // an app set up from a repository we do not control runs in a sandbox when one is configured (BEHIQUE_SANDBOX), never as a process here
  if (sandbox && adapter.profile) return startSandboxedBuild({ adapter, ref, port, config: sandbox, register: active })
  const { sha, dir } = await checkoutRef(adapter, ref)

  const feedSrv = adapter.feed ? await startFeedServer(adapter.feed) : null // an app with no feed (a static site) leaves adapter.feed null
  const feedUrl = adapter.feed ? `http://127.0.0.1:${adapter.feed.port}/feed.xml` : null
  let child
  // a dev server started through yarn, pnpm or npm leaves its own child behind when only the first process is killed, and that child keeps the
  // port: so the whole process group is stopped
  const killTree = () => { if (!child) return; try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() } }
  const self = { stop: async () => { active.delete(self); killTree(); feedSrv?.close() } }
  const stop = self.stop
  active.add(self)
  try {
    const seeded = await adapter.prepare(dir, { port, feedUrl })
    if (adapter.expectedEntries !== undefined && seeded.entries !== adapter.expectedEntries) throw new Error(`seed gave ${seeded.entries} entries, expected ${adapter.expectedEntries}`)
    const { cmd, args, env } = adapter.serve(dir, port)
    // the end of the app's own output is kept so a failure can say why (a dev server that crashes says so in its last lines)
    let tail = '', exited = null
    child = spawn(cmd, args, { cwd: dir, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const keep = d => { tail = (tail + String(d)).slice(-8000) }
    child.stdout.on('data', keep); child.stderr.on('data', keep)
    child.on('exit', (code, signal) => { exited = signal ?? code }); child.on('error', e => { exited = e.message; tail += `\n${e.message}` })
    const base = `http://127.0.0.1:${port}${adapter.basePath ?? ''}`
    const readyMs = adapter.readyMs ?? 10_000, probe = base + (adapter.readyPath && adapter.readyPath !== '/' ? adapter.readyPath : '/')
    let up = false
    for (const t0 = Date.now(); Date.now() - t0 < readyMs && !up && exited === null;) { try { up = (await fetch(probe)).ok } catch { await sleep(100) } }
    if (!up) {
      const e = new Error(`${adapter.name} ${ref} did not answer on ${base}${exited !== null ? ` (the server stopped: ${exited})` : ` within ${Math.round(readyMs / 1000)} s`}`)
      e.logs = tail
      throw e
    }
    return { ref, sha, dir, base, port, entries: seeded.entries, buildMs: Date.now() - t0, stop, logTail: () => tail }
  } catch (e) { await stop(); throw e }
}

// Command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ref, port = '8300', ...flags] = process.argv.slice(2)
  if (!ref) { console.error('usage: node src/release/build.mjs <ref> [port] [--serve] [--adapter freshrss]'); process.exit(2) }
  const name = flags.includes('--adapter') ? flags[flags.indexOf('--adapter') + 1] : 'freshrss'
  const adapter = (await import(`./adapters/${name}.mjs`)).default
  const b = await startBuild({ adapter, ref, port: +port })
  const html = await (await fetch(b.base + '/')).text()
  console.log(JSON.stringify({ ref: b.ref, sha: b.sha, base: b.base, entries: b.entries, buildSeconds: +(b.buildMs / 1000).toFixed(1), articlesInPage: (html.match(/class="flux /g) ?? []).length }, null, 1))
  if (flags.includes('--serve')) { console.log('serving, Ctrl-C to stop'); process.on('SIGINT', async () => { await b.stop(); process.exit(0) }); await new Promise(() => {}) }
  else await b.stop()
}
