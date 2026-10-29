// Build runner: take a git ref of the app under test, check it out, install and seed it from a clean state, serve it.
//   node src/release/build.mjs 1.30.0 8300          start, check it answers, stop
//   node src/release/build.mjs 1.30.0 8300 --serve  keep it running until Ctrl-C
// A build is identified by its commit sha, never by the ref name, so a tag that moves cannot change a result.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
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

export async function startBuild({ adapter, ref, port }) {
  const t0 = Date.now()
  const git = (...a) => run('git', ['-C', adapter.repo, ...a]).then(r => r.stdout.trim())
  const sha = await git('rev-parse', `${ref}^{commit}`)
  const dir = join(adapter.workRoot, 'w-' + sha.slice(0, 12))
  if (!existsSync(dir)) await git('worktree', 'add', '-q', '--detach', dir, sha)
  await run('git', ['-C', dir, 'clean', '-fdxq', '--', ...adapter.cleanPaths])

  const feedSrv = await startFeedServer(adapter.feed)
  const feedUrl = `http://127.0.0.1:${adapter.feed.port}/feed.xml`
  let child
  const self = { stop: async () => { active.delete(self); child?.kill(); feedSrv.close() } }
  const stop = self.stop
  active.add(self)
  try {
    const seeded = await adapter.prepare(dir, { port, feedUrl })
    if (seeded.entries !== adapter.expectedEntries) throw new Error(`seed gave ${seeded.entries} entries, expected ${adapter.expectedEntries}`)
    const { cmd, args } = adapter.serve(dir, port)
    child = spawn(cmd, args, { cwd: dir, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}${adapter.basePath ?? ''}`
    let up = false
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(base + '/')).ok } catch { await sleep(100) } }
    if (!up) throw new Error(`${adapter.name} ${ref} did not answer on ${base}`)
    return { ref, sha, dir, base, port, entries: seeded.entries, buildMs: Date.now() - t0, stop }
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
