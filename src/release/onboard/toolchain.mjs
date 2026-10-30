// Toolchain helpers: package manager detection, install commands, shims, env templates.
// Pure functions only: no processes, no files, no network.
//   node --test src/release/onboard/toolchain.test.mjs
import { basename } from 'node:path'

const FIELD_NAMES = new Set(['npm', 'pnpm', 'yarn', 'bun'])

const LOCKFILE_MAP = new Map([
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
])

export function detectPackageManager({ packageManager, lockfile } = {}) {
  if (typeof packageManager === 'string') {
    const trimmed = packageManager.trim()
    let name = null
    let rest = null
    const at = trimmed.indexOf('@')
    if (at > 0) {
      name = trimmed.slice(0, at).trim()
      rest = trimmed.slice(at + 1)
    } else if (at < 0) {
      name = trimmed
      rest = null
    } else {
      name = null
    }
    if (name !== null && FIELD_NAMES.has(name)) {
      let version = null
      if (rest !== null) {
        if (rest.length === 0) {
          version = null
        } else {
          version = rest.split('+')[0] || null
        }
      }
      return { name, version, source: 'packageManager field' }
    }
  }
  if (typeof lockfile === 'string' && lockfile.length > 0) {
    const base = basename(lockfile)
    if (LOCKFILE_MAP.has(base)) {
      return { name: LOCKFILE_MAP.get(base), version: null, source: 'lockfile' }
    }
    const trimmed = lockfile.trim()
    if (LOCKFILE_MAP.has(trimmed)) {
      return { name: LOCKFILE_MAP.get(trimmed), version: null, source: 'lockfile' }
    }
  }
  return { name: 'npm', version: null, source: 'default' }
}

function yarnMajor(version) {
  if (typeof version !== 'string' || version.length === 0) return null
  const m = version.trim().match(/^(\d+)/)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isNaN(n) ? null : n
}

export function installItem(pm, { hasLockfile = true, ignoreScripts = true } = {}) {
  if (!pm || typeof pm.name !== 'string') return null
  const name = pm.name
  if (name === 'bun') return null
  if (name === 'npm') {
    const args = [hasLockfile ? 'ci' : 'install']
    if (ignoreScripts) args.push('--ignore-scripts')
    return { cmd: 'npm', args }
  }
  if (name === 'pnpm') {
    const args = ['install']
    if (hasLockfile) args.push('--frozen-lockfile')
    if (ignoreScripts) args.push('--ignore-scripts')
    return { cmd: 'pnpm', args }
  }
  if (name === 'yarn') {
    const major = yarnMajor(pm.version)
    if (major !== null && major >= 2) {
      const args = ['install', '--immutable']
      if (ignoreScripts) args.push('--mode=skip-build')
      return { cmd: 'yarn', args }
    }
    const args = ['install', '--frozen-lockfile']
    if (ignoreScripts) args.push('--ignore-scripts')
    return { cmd: 'yarn', args }
  }
  return null
}

const INSTALL_WORDS = new Set(['install', 'i', 'ci', 'add'])

export function withIgnoreScripts(item) {
  if (item === null || item === undefined) return item
  const args = Array.isArray(item.args) ? [...item.args] : []
  const copy = { ...item, args }
  if (copy.cmd !== 'npm' && copy.cmd !== 'pnpm' && copy.cmd !== 'yarn') return copy
  if (args.length === 0 || !INSTALL_WORDS.has(args[0])) return copy
  if (args.includes('--ignore-scripts') || args.includes('--mode=skip-build')) return copy
  copy.args = [...args, '--ignore-scripts']
  return copy
}

export function shimFile(name) {
  if (name !== 'yarn' && name !== 'pnpm') return null
  return { name, content: `#!/bin/sh\nexec corepack ${name} "$@"\n` }
}

export function shimEnv(dir, baseEnv = {}) {
  const copy = { ...baseEnv }
  const old = baseEnv.PATH
  if (typeof old === 'string' && old.length > 0) {
    copy.PATH = `${dir}:${old}`
  } else {
    copy.PATH = dir
  }
  copy.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  return copy
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function splitLines(text) {
  if (Array.isArray(text)) return text.map((v) => String(v))
  return String(text).split(/\r?\n/)
}

export function parseEnvExample(text) {
  const lines = splitLines(text ?? '')
  const out = []
  const seen = new Set()
  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) continue
    let s = trimmed
    const exportMatch = s.match(/^export\s+/)
    if (exportMatch) {
      s = s.slice(exportMatch[0].length).trimStart()
      if (s === '' || s.startsWith('#')) continue
    }
    const eq = s.indexOf('=')
    if (eq < 0) continue
    const key = s.slice(0, eq).trim()
    if (!KEY_RE.test(key)) continue
    if (seen.has(key)) continue
    let value = s.slice(eq + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      } else {
        const idx = value.indexOf(' #')
        if (idx >= 0) value = value.slice(0, idx).trimEnd()
      }
    } else {
      const idx = value.indexOf(' #')
      if (idx >= 0) value = value.slice(0, idx).trimEnd()
    }
    seen.add(key)
    out.push({ key, example: value })
  }
  return out
}

const FLAG_VALUES = new Set(['true', 'false', '0', '1', 'yes', 'no', 'on', 'off'])

const SECRET_MARKERS = [
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'TOKEN',
  'PRIVATE_KEY',
  'API_KEY',
  'APIKEY',
  'ACCESS_KEY',
  'CLIENT_ID',
  'CLIENT_SECRET',
  'WEBHOOK',
  'DSN',
  'CREDENTIAL',
  'SALT',
  'JWT',
]

export function classifyEnvKey(key, example) {
  const upper = String(key).toUpperCase()
  // a password or token is a credential even when it belongs to a database
  for (const marker of SECRET_MARKERS) {
    if (upper.includes(marker)) return 'secret'
  }
  if (upper === 'KEY' || upper.endsWith('_KEY')) return 'secret' // a generic key is a credential until shown otherwise
  const hasSqlite = upper.includes('SQLITE')
  if (!hasSqlite) {
    if (
      upper.includes('DATABASE') ||
      upper.includes('POSTGRES') ||
      upper.includes('MYSQL') ||
      upper.includes('MARIADB') ||
      upper.includes('MONGO') ||
      upper.includes('REDIS') ||
      upper.startsWith('DB_')
    ) {
      return 'database'
    }
  }
  if (upper === 'PORT' || upper.endsWith('_PORT')) return 'port'
  if (
    upper.endsWith('_URL') ||
    upper.endsWith('_URI') ||
    upper.endsWith('_HOST') ||
    upper.endsWith('_ORIGIN') ||
    upper.endsWith('_ENDPOINT') ||
    upper === 'BASE_URL'
  ) {
    return 'url'
  }
  if (typeof example === 'string' && FLAG_VALUES.has(example.trim().toLowerCase())) return 'flag'
  return 'plain'
}

function pointsAtLocalhost(example) {
  const lower = String(example).toLowerCase()
  return lower.includes('localhost') || lower.includes('127.0.0.1')
}

function replacePort(example, port) {
  if (port === undefined || port === null) return String(example)
  return String(example).replace(/:\d+/, `:${String(port)}`)
}

function cleanValue(value) {
  return String(value).replace(/\r/g, '').replace(/\n/g, '')
}

export function safeEnv(entries, { port } = {}) {
  const env = {}
  const blockers = []
  const list = Array.isArray(entries) ? entries : []
  for (const entry of list) {
    const key = entry.key
    const example = entry.example ?? ''
    const kind = classifyEnvKey(key, example)
    if (kind === 'port') {
      if (key === 'PORT' && port !== undefined && port !== null) {
        env[key] = cleanValue(String(port))
      }
      continue
    }
    if (kind === 'flag' || kind === 'plain') {
      const v = String(example)
      if (v.length === 0 || v.length >= 100) continue
      const cleaned = cleanValue(v)
      if (cleaned.length === 0) continue
      env[key] = cleaned
      continue
    }
    if (kind === 'url') {
      const v = String(example)
      if (!pointsAtLocalhost(v)) {
        blockers.push({ key, kind: 'service', needs: 'a service url' })
        continue
      }
      const replaced = port !== undefined && port !== null ? replacePort(v, port) : v
      const cleaned = cleanValue(replaced)
      env[key] = cleaned
      continue
    }
    if (kind === 'database') {
      blockers.push({ key, kind: 'database', needs: 'a database or other service' })
      continue
    }
    if (kind === 'secret') {
      blockers.push({ key, kind: 'secret', needs: 'a secret or credential' })
      continue
    }
  }
  return { env, blockers }
}

export function describeEnv(env) {
  const obj = env ?? {}
  const keys = Object.keys(obj).sort()
  return keys.map((k) => `env: ${k}=${String(obj[k]).slice(0, 80)}`)
}
