// seed: validate and plan sidecar database seeding.
// Pure builders only: no processes, no files, no network.
// Run: node --test src/release/sandbox/seed.test.mjs
import { join } from 'node:path'
import { names, execArgs, isRunId, isShortName } from './docker-args.mjs'

export const SEED_FILE_EXT = {
  postgres: '.sql',
  mysql: '.sql',
  mariadb: '.sql',
  mongo: '.js',
  redis: '.redis'
}

const ALLOWED_KEYS = new Set(['service', 'file', 'script'])
const MAX_SEEDS = 10
const MAX_FILE_LEN = 200
const MAX_SCRIPT_LEN = 20000

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function addressOf(entry) {
  if (!isRecord(entry)) return null
  if (typeof entry.name === 'string') return entry.name
  if (typeof entry.kind === 'string') return entry.kind
  return null
}

function kindForService(services, name) {
  if (!Array.isArray(services)) return null
  for (const entry of services) {
    if (!isRecord(entry)) continue
    if (addressOf(entry) === name) {
      if (typeof entry.kind === 'string' && entry.kind in SEED_FILE_EXT) return entry.kind
      return typeof entry.kind === 'string' ? entry.kind : null
    }
  }
  return null
}

function hasService(services, name) {
  if (!Array.isArray(services)) return false
  for (const entry of services) {
    if (!isRecord(entry)) continue
    if (addressOf(entry) === name) return true
  }
  return false
}

function validFilePath(file) {
  if (typeof file !== 'string' || file === '') return false
  if (file.length > MAX_FILE_LEN) return false
  if (file.startsWith('/')) return false
  if (/\s/.test(file)) return false
  const parts = file.split('/')
  for (const part of parts) {
    if (part === '..') return false
  }
  return true
}

export function validateSeeds(list, services) {
  if (list === undefined) return []
  if (!Array.isArray(list)) return ['seed must be an array']
  const problems = []
  if (list.length > MAX_SEEDS) problems.push(`seed has too many entries (maximum ${MAX_SEEDS})`)
  const count = Math.min(list.length, MAX_SEEDS)
  for (let i = 0; i < list.length; i += 1) {
    const n = i + 1
    if (i >= count) break
    const entry = list[i]
    if (!isRecord(entry)) {
      problems.push(`seed ${n}: must be an object`)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_KEYS.has(key)) problems.push(`seed ${n}: has unknown property ${key}`)
    }
    const { service, file, script } = entry
    let known = false
    let kind = null
    if (typeof service !== 'string' || !hasService(services, service)) {
      problems.push(`seed ${n}: no service named "${String(service)}" in services`)
    } else {
      known = true
      kind = kindForService(services, service)
    }
    const hasFile = file !== undefined
    const hasScript = script !== undefined
    if (hasFile && hasScript) {
      problems.push(`seed ${n}: must have exactly one of file or script`)
    } else if (!hasFile && !hasScript) {
      problems.push(`seed ${n}: must have exactly one of file or script`)
    } else if (hasFile) {
      let pathOk = true
      if (typeof file !== 'string' || file === '') {
        problems.push(`seed ${n}: file must be a non-empty string`)
        pathOk = false
      } else {
        if (file.length > MAX_FILE_LEN) {
          problems.push(`seed ${n}: file is too long (maximum ${MAX_FILE_LEN} characters)`)
          pathOk = false
        }
        if (file.startsWith('/')) {
          problems.push(`seed ${n}: file must be relative`)
          pathOk = false
        }
        if (/\s/.test(file)) {
          problems.push(`seed ${n}: file must not contain whitespace`)
          pathOk = false
        }
        if (file.split('/').includes('..')) {
          problems.push(`seed ${n}: file must not contain ..`)
          pathOk = false
        }
      }
      if (known && kind in SEED_FILE_EXT && typeof file === 'string') {
        const ext = SEED_FILE_EXT[kind]
        if (!file.endsWith(ext)) {
          problems.push(`seed ${n}: a ${kind} seed must be a ${ext} file`)
        } else if (!pathOk) {
          // path problems already reported
        }
      }
    } else {
      if (typeof script !== 'string') {
        problems.push(`seed ${n}: script must be a string`)
      } else {
        if (script.length > MAX_SCRIPT_LEN) {
          problems.push(`seed ${n}: script is too long (maximum ${MAX_SCRIPT_LEN} characters)`)
        }
        if (script.includes('\0')) {
          problems.push(`seed ${n}: script must not contain NUL`)
        }
      }
    }
  }
  return problems
}

export function describeSeeds(list, services) {
  if (!Array.isArray(list)) return []
  const lines = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const service = entry.service
    if (typeof service !== 'string') continue
    const kind = kindForService(services, service)
    if (typeof kind !== 'string') continue
    if (typeof entry.file === 'string') {
      lines.push(`seed: ${service} (${kind}) from ${entry.file}`)
    } else if (typeof entry.script === 'string') {
      lines.push(`seed: ${service} (${kind}) from an inline script (${entry.script.length} characters)`)
    }
  }
  return lines
}

export function cpArgs(input) {
  if (!isRecord(input)) return { ok: false, error: 'runId, short, from and to are required.' }
  const { runId, short, from, to } = input
  if (!isRunId(runId)) return { ok: false, error: 'invalid runId.' }
  if (!isShortName(short)) return { ok: false, error: 'invalid short name.' }
  if (typeof from !== 'string' || !from.startsWith('/') || /\s/.test(from)) {
    return { ok: false, error: 'from must be an absolute path without whitespace.' }
  }
  if (typeof to !== 'string' || !to.startsWith('/seed/')) {
    return { ok: false, error: 'to must start with /seed/.' }
  }
  const container = names(runId, short)
  if (container === null) return { ok: false, error: 'invalid runId.' }
  return { ok: true, args: ['cp', from, `${container}:${to}`] }
}

function shortFor(resolvedEntry, fallbackName) {
  if (isRecord(resolvedEntry) && typeof resolvedEntry.short === 'string' && resolvedEntry.short !== '') {
    return resolvedEntry.short
  }
  return `svc-${fallbackName}`
}

function findResolved(resolved, service) {
  if (!Array.isArray(resolved)) return null
  for (const entry of resolved) {
    if (!isRecord(entry)) continue
    const addr = addressOf(entry)
    if (addr === service) return entry
  }
  return null
}

function clientCmd(kind, env, to) {
  const e = isRecord(env) ? env : {}
  if (kind === 'postgres') {
    return ['psql', '-v', 'ON_ERROR_STOP=1', '-U', String(e.POSTGRES_USER), '-d', String(e.POSTGRES_DB), '-f', to]
  }
  if (kind === 'mysql') {
    return ['mysql', '-uroot', '-p' + String(e.MYSQL_ROOT_PASSWORD), String(e.MYSQL_DATABASE), '-e', 'source ' + to]
  }
  if (kind === 'mariadb') {
    return ['mariadb', '-uroot', '-p' + String(e.MARIADB_ROOT_PASSWORD), String(e.MARIADB_DATABASE), '-e', 'source ' + to]
  }
  if (kind === 'mongo') {
    return ['mongosh', '--quiet', 'app', to]
  }
  if (kind === 'redis') {
    return ['sh', '-c', 'redis-cli < ' + to]
  }
  return null
}

export function seedPlan(list, resolved, opts = {}) {
  const { runId, checkoutDir } = isRecord(opts) ? opts : {}
  const items = list === undefined ? [] : list
  const problems = validateSeeds(items, resolved)
  if (problems.length > 0) return { ok: false, error: problems.join('; ') }
  // a bad run id is reported by cpArgs / execArgs with the seed number, as every other refusal is
  if (typeof checkoutDir !== 'string' || !checkoutDir.startsWith('/')) {
    return { ok: false, error: 'checkoutDir must be an absolute path.' }
  }
  const steps = []
  for (let i = 0; i < items.length; i += 1) {
    const n = i + 1
    const entry = items[i]
    const matched = findResolved(resolved, entry.service)
    // validated above, match must exist
    const kind = matched.kind
    const ext = SEED_FILE_EXT[kind]
    const to = `/seed/${n}${ext}`
    const short = shortFor(matched, entry.service)
    let source
    let cp
    if (entry.file !== undefined) {
      source = { file: entry.file }
      const from = join(checkoutDir, entry.file)
      const built = cpArgs({ runId, short, from, to })
      if (!built.ok) return { ok: false, error: `seed ${n}: ${built.error}` }
      cp = built
    } else {
      source = { script: entry.script }
      cp = { ok: true, args: null, inline: true }
    }
    const cmd = clientCmd(kind, matched.env, to)
    const builtExec = execArgs({ runId, short, cmd })
    if (!builtExec.ok) return { ok: false, error: `seed ${n}: ${builtExec.error}` }
    steps.push({ service: entry.service, kind, short, source, to, cp, exec: builtExec })
  }
  return { ok: true, steps }
}

export function seedSummary(steps, outcomes) {
  if (!Array.isArray(steps) || steps.length === 0) return 'nothing to seed'
  const list = Array.isArray(outcomes) ? outcomes : []
  let done = 0
  const parts = []
  for (let i = 0; i < steps.length; i += 1) {
    const service = isRecord(steps[i]) && typeof steps[i].service === 'string' ? steps[i].service : 'unknown'
    const outcome = list[i]
    if (isRecord(outcome) && outcome.ok === true) {
      done += 1
      parts.push(`${service} ok`)
    } else {
      let msg = ''
      if (isRecord(outcome) && typeof outcome.error === 'string') msg = outcome.error.split('\n')[0]
      parts.push(`${service} FAILED (${msg})`)
    }
  }
  return `seeded ${done} of ${steps.length}: ${parts.join(', ')}`
}
