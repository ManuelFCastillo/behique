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
import { dockerHostFor, makeDocker } from './docker-exec.mjs'
import { createSandbox } from './sandbox.mjs'
import { injectedEnv, resolveServices } from './services.mjs'
import { forwardLocal, sshTunnel } from './tunnel.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_SERVER = join(HERE, '..', 'onboard', 'static-server.mjs')
const LAUNCHER = join(HERE, 'launch.mjs')
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
  const cfg = { target: host ?? '', image, sshHost: ssh }
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
export function writeExtras(dir, shimNames) {
  const base = join(dir, '.behique')
  mkdirSync(join(base, 'bin'), { recursive: true })
  copyFileSync(STATIC_SERVER, join(base, 'static-server.mjs'))
  copyFileSync(LAUNCHER, join(base, 'launch.mjs'))
  for (const name of shimNames) {
    const f = shimFile(name)
    if (!f) continue
    writeFileSync(join(base, 'bin', name), f.content)
    chmodSync(join(base, 'bin', name), 0o755)
  }
}

const sub = (v, port) => String(v).split('{port}').join(String(port))

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
  const installs = (adapter.installsFor ? adapter.installsFor(dir) : adapter.installs) ?? [] // which yarn flags are valid depends on this checkout
  const shimNames = [...new Set(cmds.filter(c => c === 'yarn' || c === 'pnpm'))]
  writeExtras(dir, shimNames)

  const sb = make({ docker, pack, image: config.image, limits: config.limits })
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

  if (installs.length > 0) {
    const inst = await sb.install(installs.map(i => ({ cmd: i.cmd, args: (i.args ?? []).map(a => sub(a, port)) })), { env })
    if (!inst.ok) return fail(`${p.name} ${ref}: ${inst.error}`, inst.logs)
  }

  const run = p.serve.kind === 'static'
    ? { cmd: 'node', args: ['/work/.behique/static-server.mjs', p.serve.root ? `/work/${p.serve.root.replace(/^\/+/, '')}` : '/work', String(port), JSON.stringify(p.serve.overrides ?? {})] }
    : { cmd: p.serve.cmd, args: (p.serve.args ?? []).map(a => sub(a, port)) }
  // the launcher makes a server that listens only on localhost reachable from outside the container, and runs the command as given
  const app = await sb.startApp({ cmd: 'node', args: ['/work/.behique/launch.mjs', String(port), '--', run.cmd, ...run.args], env, port })
  if (!app.ok) { const l = await sb.logs(200); return fail(`${p.name} ${ref}: ${app.error}`, app.logs ?? (l.ok ? l.text : '')) } // an app that exits at once has no address, so its own last lines say why

  try { link = await forward({ listenPort: port, host: app.host, port }) } catch (e) { return fail(`${p.name} ${ref}: ${e.message}`) }

  const base = `http://127.0.0.1:${port}${adapter.basePath ?? ''}`
  const readyMs = adapter.readyMs ?? 10_000
  const probe = base + (adapter.readyPath && adapter.readyPath !== '/' ? adapter.readyPath : '/')
  let up = false, stopped = false
  for (const t = Date.now(); Date.now() - t < readyMs && !up && !stopped;) {
    try { up = (await fetchFn(probe)).ok } catch { await sleep(300) }
    if (!up) { const r = await sb.running(); stopped = r.ok && r.running === false }
  }
  if (!up) {
    const l = await sb.logs(200)
    tail = l.ok ? l.text : ''
    return fail(`${p.name} ${ref} did not answer on ${base}${stopped ? ' (the server stopped)' : ` within ${Math.round(readyMs / 1000)} s`}`, tail)
  }
  return { ref, sha, dir, base, port, entries: 0, buildMs: Date.now() - t0, stop: self.stop, logTail: () => tail, sandbox: { runId: sb.runId, target: config.target || 'local', appAddress: `${app.host}:${app.port}` } }
}
