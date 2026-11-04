// The sandbox backend for startBuild: the same contract as a host build ({ base, sha, stop, logTail, ... }), but the app, its install steps and its
// sidecars run in Docker (the local engine, or another machine over ssh), and nothing from the repository runs on this machine.
//   BEHIQUE_SANDBOX=docker                      local engine (OrbStack on a Mac)
//   BEHIQUE_SANDBOX=docker:ssh://hardac2        docker on hardac2, reached over ssh
//   BEHIQUE_SANDBOX_IMAGE=node:22-bookworm-slim base image for installs and the app (a pinned Docker Hub tag)
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutRef } from '../checkout.mjs'
import { scriptsOffEnv } from '../onboard/profile.mjs'
import { shimFile } from '../onboard/toolchain.mjs'
import { isImage } from './docker-args.mjs'
import { cacheImage, cacheInspectArgs, cacheKey } from './cache.mjs'
import { dockerHostFor, makeDocker } from './docker-exec.mjs'
import { createSandbox } from './sandbox.mjs'
import { injectedEnv, resolveServices } from './services.mjs'
import { cpArgs, seedPlan, seedSummary } from './seed.mjs'
import { rmSync as rmSeedFile, writeFileSync as writeSeedFile } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { forwardLocal, sshTunnel } from './tunnel.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_SERVER = join(HERE, '..', 'onboard', 'static-server.mjs')
const PROXY_SERVER = join(HERE, '..', 'onboard', 'proxy-server.mjs') // a static bundle that talks to a sidecar on the same origin (serve.proxy)
const LAUNCHER = join(HERE, 'launch.mjs')
const GIT_HISTORY = join(HERE, 'git-history.mjs') // one commit for a build that reads last-update dates from git (serve.gitHistory)
const DEFAULT_IMAGE = 'node:22-bookworm' // the full image: Prisma and many native modules need openssl and build tools that the slim one lacks
const IN_BOX = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn']) // the base image is a Node image: python3 and php profiles stay on this machine for now
const sleepMs = ms => new Promise(r => setTimeout(r, ms))

/** null when no sandbox is configured. Throws on a value it does not understand, so a typo never falls back to running on the host. */
export function sandboxConfigFromEnv(env = process.env) {
  const v = env.BEHIQUE_SANDBOX
  if (v === undefined || v === '' || v === 'off') return null
  const [kind, ...rest] = v.split(':')
  if (kind !== 'docker') throw new Error(`BEHIQUE_SANDBOX must be "docker" or "docker:ssh://<host>", not "${v.slice(0, 40)}"`)
  const target = rest.join(':')
  const host = dockerHostFor(target) // throws on anything but local, ssh://, unix:// or tcp://
  const image = env.BEHIQUE_SANDBOX_IMAGE ?? DEFAULT_IMAGE
  if (!isImage(image)) throw new Error(`BEHIQUE_SANDBOX_IMAGE must be a pinned Docker Hub image such as ${DEFAULT_IMAGE}`)
  const ssh = host && host.startsWith('ssh://') ? host.slice('ssh://'.length) : null
  const cfg = { target: host ?? '', image, sshHost: ssh, cache: env.BEHIQUE_CACHE !== 'off' } // cache: keep each installed commit as an image and start from it next time
  // limits for the install and app containers (the default is 4 GB, 4 CPUs; a big build such as `next build` can need more)
  const mem = env.BEHIQUE_SANDBOX_MEMORY_MB, cpus = env.BEHIQUE_SANDBOX_CPUS
  if (mem !== undefined || cpus !== undefined) {
    const memoryMb = mem === undefined ? 4096 : Number(mem), c = cpus === undefined ? 4 : Number(cpus)
    if (!Number.isInteger(memoryMb) || memoryMb < 512 || memoryMb > 16384) throw new Error('BEHIQUE_SANDBOX_MEMORY_MB must be an integer from 512 to 16384')
    if (!Number.isFinite(c) || c < 0.5 || c > 16) throw new Error('BEHIQUE_SANDBOX_CPUS must be a number from 0.5 to 16')
    cfg.limits = { memoryMb, cpus: c, pids: 1024 }
  }
  return cfg
}

/** A tar of the checkout without .git and node_modules (and without macOS resource-fork files). Resolves to a Buffer. */
export function packDir(dir) {
  return new Promise((resolve, reject) => {
    const t = spawn('tar', ['-cf', '-', '--no-xattrs', '--exclude=.git', '--exclude=node_modules', '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const chunks = []
    let err = ''
    t.stdout.on('data', d => chunks.push(d))
    t.stderr.on('data', d => { err += d })
    t.on('error', reject)
    t.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar failed: ${err.split('\n')[0]}`))))
  })
}

/** Everything the box needs besides the repository: the static file server, the launcher and yarn or pnpm shims (corepack ships with Node). */
export function writeExtras(dir, shimNames, { gitHistory = false } = {}) {
  const base = join(dir, '.behique')
  mkdirSync(join(base, 'bin'), { recursive: true })
  copyFileSync(STATIC_SERVER, join(base, 'static-server.mjs'))
  copyFileSync(PROXY_SERVER, join(base, 'proxy-server.mjs'))
  copyFileSync(LAUNCHER, join(base, 'launch.mjs'))
  if (gitHistory) copyFileSync(GIT_HISTORY, join(base, 'git-history.mjs'))
  for (const name of shimNames) {
    const f = shimFile(name)
    if (!f) continue
    writeFileSync(join(base, 'bin', name), f.content)
    chmodSync(join(base, 'bin', name), 0o755)
  }
}

const sub = (v, port) => String(v).split('{port}').join(String(port))

/** The cache key for this build, or null when the profile has a shape the key cannot describe (then the build is simply not cached). */
export function cacheKeyFor({ app, sha, image, installs, profile }) {
  const k = cacheKey({ app, sha, image, installs: (installs ?? []).map(i => ({ cmd: i.cmd, args: i.args ?? [] })), allowScripts: profile.serve?.allowScripts === true, root: profile.serve?.root ?? undefined, services: (profile.services ?? []).map(s => s.kind ?? s) })
  return k.ok ? k.key : null
}

async function imageExists(docker, image) {
  const a = cacheInspectArgs(image)
  if (!a.ok) return false
  try { const r = await docker(a.args, { timeoutMs: 30_000 }); return r.code === 0 && /\S/.test(r.stdout) } catch { return false }
}

export async function startSandboxedBuild({ adapter, ref, port, config, register, deps = {} }) {
  const t0 = Date.now()
  const p = adapter.profile
  const docker = deps.docker ?? makeDocker({ target: config.target })
  const make = deps.createSandbox ?? createSandbox
  const pack = deps.pack ?? packDir
  const sleep = deps.sleep ?? sleepMs
  const fetchFn = deps.fetch ?? fetch
  const forward = deps.forward ?? (a => (config.sshHost ? sshTunnel({ sshHost: config.sshHost, ...a }) : forwardLocal(a)))

  const cmds = [...(adapter.installs ?? []).map(i => i.cmd), ...(p.serve.kind === 'command' ? [p.serve.cmd] : [])]
  const outside = cmds.find(c => !IN_BOX.has(c))
  if (outside) throw new Error(`${p.name}: "${outside}" does not run in the sandbox yet (the sandbox image is a Node image)`)

  const { sha, dir } = await checkoutRef(adapter, ref)
  const gitHistory = p.serve.gitHistory === true // the copy gets one git commit before anything else runs: the build reads last-update dates from git
  const installs = [...(gitHistory ? [{ cmd: 'node', args: ['/work/.behique/git-history.mjs'] }] : []), ...((adapter.installsFor ? adapter.installsFor(dir) : adapter.installs) ?? [])] // which yarn flags are valid depends on this checkout
  const shimNames = [...new Set(cmds.filter(c => c === 'yarn' || c === 'pnpm'))]
  writeExtras(dir, shimNames, { gitHistory })

  // the build cache: the same commit, image, install steps and services were installed before, so the app can start from that image
  const image = p.serve.image ?? config.image // a repo that needs another Node (engine-strict) names it in its profile
  const key = config.cache === false ? null : cacheKeyFor({ app: p.name, sha, image, installs, profile: p })
  const hit = key ? await imageExists(docker, cacheImage(key)) : false
  const sb = make({ docker, pack, image, limits: config.limits, fromCache: hit ? key : null })
  let link = null, tail = ''
  const self = { stop: async () => { register?.delete(self); await link?.close().catch(() => {}); await sb.destroy() } }
  register?.add(self)
  const fail = async (message, logs) => { const e = new Error(message); e.logs = logs ?? tail; await self.stop(); throw e }

  const prep = await sb.prepare({ dir })
  if (!prep.ok) return fail(`${p.name} ${ref}: ${prep.error}`, prep.logs)

  const services = resolveServices(p.services ?? [], { runId: sb.runId })
  if (services.length > 0) {
    const up = await sb.startServices(services)
    if (!up.ok) return fail(`${p.name} ${ref}: ${up.error}`, up.logs)
  }

  const env = {}
  // a server inside a container must listen on all addresses to be reachable from outside it; the profile's own env wins over these defaults
  env.HOST = '0.0.0.0'; env.HOSTNAME = '0.0.0.0'; env.BEHIQUE_BIND = '0.0.0.0'
  if (shimNames.length > 0) { env.PATH = '/work/.behique/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'; env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0' }
  if (p.serve.allowScripts !== true) Object.assign(env, scriptsOffEnv(dir))
  for (const [k, v] of Object.entries(p.serve.env ?? {})) env[k] = sub(v, port)
  Object.assign(env, injectedEnv(services))

  if (installs.length > 0 && !hit) {
    const inst = await sb.install(installs.map(i => ({ cmd: i.cmd, args: (i.args ?? []).map(a => sub(a, port)) })), { env })
    if (!inst.ok) return fail(`${p.name} ${ref}: ${inst.error}`, inst.logs)
  }
  if (key && !hit) { const kept = await sb.commit({ key, app: p.name, sha }); if (!kept.ok) deps.log?.(`${p.name} ${ref}: the build was not kept for next time: ${kept.error}`) } // a failed commit costs time, not the run
  // serve.prepare runs on EVERY run, cached build or not: the sidecars are fresh each time, so an app's own migrations and seeding
  // (umami: `check-db`) belong here and not in the install, which a cached build skips.
  const prepares = p.serve.kind === 'static' ? [] : (p.serve.prepare ?? [])
  if (prepares.length > 0) {
    const prep2 = await sb.install(prepares.map(i => ({ cmd: i.cmd, args: (i.args ?? []).map(a => sub(a, port)) })), { env, timeoutMs: 300000, stallMs: 120000, tmpfs: hit ? ['/work/.home'] : [] })
    if (!prep2.ok) return fail(`${p.name} ${ref}: prepare: ${prep2.error}`, prep2.logs)
  }

  const root = p.serve.root ? `/work/${String(p.serve.root).replace(/^\/+/, '')}` : '/work'
  const run = p.serve.kind === 'static' && p.serve.proxy
    ? { cmd: 'node', args: ['/work/.behique/proxy-server.mjs', root, String(port), p.serve.proxy.mount, `${p.serve.proxy.service}:${p.serve.proxy.port}`] }
    : p.serve.kind === 'static'
    ? { cmd: 'node', args: ['/work/.behique/static-server.mjs', p.serve.root ? `/work/${p.serve.root.replace(/^\/+/, '')}` : '/work', String(port), JSON.stringify(p.serve.overrides ?? {})] }
    : { cmd: p.serve.cmd, args: (p.serve.args ?? []).map(a => sub(a, port)) }
  // the launcher makes a server that listens only on localhost reachable from outside the container, and runs the command as given
  if ((p.seed ?? []).length > 0) { // rows for the sidecars, after the install so the app's own migrations have run, before the app starts; sidecars are fresh every run
    const plan = seedPlan(p.seed, services, { runId: sb.runId, checkoutDir: dir })
    if (!plan.ok) return fail(`${p.name} ${ref}: seed: ${plan.error}`)
    const tmpFiles = []
    for (const [i, st] of plan.steps.entries()) {
      if (!st.cp.inline) continue // an inline script goes through a temporary file, then the same copy as a file seed
      const f = joinPath(tmpdir(), `bq-seed-${sb.runId}-${i + 1}${st.to.slice(st.to.lastIndexOf('.'))}`)
      writeSeedFile(f, st.source.script); tmpFiles.push(f)
      const cp = cpArgs({ runId: sb.runId, short: st.short, from: f, to: st.to })
      if (!cp.ok) return fail(`${p.name} ${ref}: seed ${i + 1}: ${cp.error}`)
      st.cp = cp
    }
    const seeded = await sb.seed(plan.steps)
    for (const f of tmpFiles) rmSeedFile(f, { force: true })
    const summary = seedSummary(plan.steps, seeded.outcomes)
    deps.log?.(`${p.name} ${ref}: ${summary}`)
    if (!seeded.ok) return fail(`${p.name} ${ref}: ${summary}`, seeded.outcomes.find(o => !o.ok)?.logs)
  }
  const app = await sb.startApp({ cmd: 'node', args: ['/work/.behique/launch.mjs', String(port), '--', run.cmd, ...run.args], env, port })
  if (!app.ok) { const l = await sb.logs(200); return fail(`${p.name} ${ref}: ${app.error}`, app.logs ?? (l.ok ? l.text : '')) } // an app that exits at once has no address, so its own last lines say why

  try { link = await forward({ listenPort: port, host: app.host, port }) } catch (e) { return fail(`${p.name} ${ref}: ${e.message}`) }

  const base = `http://127.0.0.1:${port}${adapter.basePath ?? ''}`
  const readyMs = adapter.readyMs ?? 10_000
  const probe = base + (adapter.readyPath && adapter.readyPath !== '/' ? adapter.readyPath : '/')
  let up = false, stopped = false
  for (const t = Date.now(); Date.now() - t < readyMs && !up && !stopped;) {
    // a bounded probe: a connection that hangs (a route to a fresh container network that is not up yet) must not eat the whole wait
    try { up = (await fetchFn(probe, { signal: AbortSignal.timeout(3000) })).ok } catch { await sleep(300) }
    if (!up) { const r = await sb.running(); stopped = r.ok && r.running === false }
  }
  if (!up) {
    const l = await sb.logs(200)
    tail = l.ok ? l.text : ''
    return fail(`${p.name} ${ref} did not answer on ${base}${stopped ? ' (the server stopped)' : ` within ${Math.round(readyMs / 1000)} s`}`, tail)
  }
  return { ref, sha, dir, base, port, entries: 0, buildMs: Date.now() - t0, cached: hit, stop: self.stop, logTail: () => tail, sandbox: { runId: sb.runId, target: config.target || 'local', appAddress: `${app.host}:${app.port}` } }
}
