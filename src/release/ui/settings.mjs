// The dashboard's Settings: where checks run (this machine, the local Docker engine, or Docker on another machine over ssh).
// The choice is saved in out/settings.json and applied to process.env.BEHIQUE_SANDBOX, so runs the server starts use it.
// Never touches .env. Pure functions plus a small file store; tests: node --test src/release/ui/settings.test.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ // an ssh alias or host name: no user@, no port, no slashes, never a flag
export const DEFAULTS = { sandbox: { mode: 'off', host: '', memoryMb: null, cpus: null } }

/** The settings that BEHIQUE_SANDBOX and its limits describe, or the defaults for an empty or unknown value. */
export function settingsFromEnv(env = process.env) {
  const v = env.BEHIQUE_SANDBOX
  const out = { sandbox: { ...DEFAULTS.sandbox } }
  if (v === 'docker') out.sandbox.mode = 'local'
  else if (typeof v === 'string' && v.startsWith('docker:ssh://') && HOST_RE.test(v.slice('docker:ssh://'.length))) { out.sandbox.mode = 'ssh'; out.sandbox.host = v.slice('docker:ssh://'.length) }
  const mem = Number(env.BEHIQUE_SANDBOX_MEMORY_MB), cpus = Number(env.BEHIQUE_SANDBOX_CPUS)
  if (Number.isInteger(mem) && mem >= 512 && mem <= 16384) out.sandbox.memoryMb = mem
  if (Number.isFinite(cpus) && cpus >= 0.5 && cpus <= 16) out.sandbox.cpus = cpus
  return out
}

/** { ok: true, settings } (cleaned) or { ok: false, error } in plain words. Unknown fields are dropped, never kept. */
export function validateSettings(input) {
  const s = input && typeof input === 'object' ? input.sandbox : null
  if (!s || typeof s !== 'object') return { ok: false, error: 'No sandbox setting was sent.' }
  if (!['off', 'local', 'ssh'].includes(s.mode)) return { ok: false, error: 'Choose where checks run: this machine, local Docker, or Docker over ssh.' }
  const host = s.mode === 'ssh' ? String(s.host ?? '').trim() : ''
  if (s.mode === 'ssh' && !HOST_RE.test(host)) return { ok: false, error: 'The ssh host must be a plain host name or alias such as hardac2.' }
  const num = (v, lo, hi, label, int) => {
    if (v === null || v === undefined || v === '') return { v: null }
    const n = Number(v)
    if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) return { error: `${label} must be ${int ? 'a whole number' : 'a number'} from ${lo} to ${hi}.` }
    return { v: n }
  }
  const mem = num(s.memoryMb, 512, 16384, 'Memory (MB)', true); if (mem.error) return { ok: false, error: mem.error }
  const cpus = num(s.cpus, 0.5, 16, 'CPUs', false); if (cpus.error) return { ok: false, error: cpus.error }
  return { ok: true, settings: { sandbox: { mode: s.mode, host, memoryMb: mem.v, cpus: cpus.v } } }
}

/** Put the settings into an environment object (process.env on the server). Every value was validated, so none can become a flag. */
export function applySettings(settings, env = process.env) {
  const s = settings.sandbox
  if (s.mode === 'off') delete env.BEHIQUE_SANDBOX
  else env.BEHIQUE_SANDBOX = s.mode === 'local' ? 'docker' : `docker:ssh://${s.host}`
  if (s.memoryMb) env.BEHIQUE_SANDBOX_MEMORY_MB = String(s.memoryMb); else delete env.BEHIQUE_SANDBOX_MEMORY_MB
  if (s.cpus) env.BEHIQUE_SANDBOX_CPUS = String(s.cpus); else delete env.BEHIQUE_SANDBOX_CPUS
  return env
}

/** The saved settings; if there is no usable file, whatever the environment says. */
export function loadSettings(path, env = process.env) {
  try {
    const v = validateSettings(JSON.parse(readFileSync(path, 'utf8')))
    if (v.ok) return { settings: v.settings, source: 'saved' }
  } catch {}
  return { settings: settingsFromEnv(env), source: 'environment' }
}

export function saveSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

/** An app whose profile runs the repository's own commands (install, build, a dev server) is third-party code; a static profile only serves files. */
export function needsSandbox(profile) {
  const serve = profile && profile.serve
  if (!serve || typeof serve !== 'object') return true // unknown shape: treat it as code
  return serve.kind !== 'static' || (Array.isArray(profile.setup) && profile.setup.length > 0)
}

export const SANDBOX_REQUIRED = 'This app runs the repository\'s own code (install, build, a server). Turn on the sandbox in Settings first, so none of it runs on this machine.'
