// services: catalog, validation, resolution and proposal of sidecar services.
// Pure data helpers only: no processes, no files, no network.
// Run: node --test src/release/sandbox/services.test.mjs

const CAPS_ALL = ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER']

export const CATALOG = {
  postgres: {
    image: 'postgres:16-alpine',
    port: 5432,
    env: { POSTGRES_USER: 'behique', POSTGRES_PASSWORD: 'behique', POSTGRES_DB: 'app' },
    tmpfs: ['/var/lib/postgresql/data'],
    caps: [...CAPS_ALL],
    health: ['pg_isready', '-U', 'behique', '-d', 'app'],
    cmd: ['postgres'],
    defaultVar: 'DATABASE_URL',
    url(host) {
      return `postgresql://behique:behique@${host}:5432/app`
    },
    memoryMb: 512
  },
  mysql: {
    image: 'mysql:8.4',
    port: 3306,
    env: { MYSQL_ROOT_PASSWORD: 'behique', MYSQL_DATABASE: 'app' },
    tmpfs: ['/var/lib/mysql'],
    caps: [...CAPS_ALL],
    health: ['mysqladmin', 'ping', '-h', '127.0.0.1', '-uroot', '-pbehique'],
    cmd: ['mysqld'],
    defaultVar: 'DATABASE_URL',
    url(host) {
      return `mysql://root:behique@${host}:3306/app`
    },
    memoryMb: 768
  },
  mariadb: {
    image: 'mariadb:11.4',
    port: 3306,
    env: { MARIADB_ROOT_PASSWORD: 'behique', MARIADB_DATABASE: 'app' },
    tmpfs: ['/var/lib/mysql'],
    caps: [...CAPS_ALL],
    health: ['healthcheck.sh', '--connect', '--innodb_initialized'],
    cmd: ['mariadbd'],
    defaultVar: 'DATABASE_URL',
    url(host) {
      return `mysql://root:behique@${host}:3306/app`
    },
    memoryMb: 768
  },
  redis: {
    image: 'redis:7-alpine',
    port: 6379,
    env: {},
    tmpfs: ['/data'],
    caps: [...CAPS_ALL], // the official image starts as root, fixes the data folder owner, then drops to its own user
    health: ['redis-cli', 'ping'],
    cmd: ['redis-server'],
    defaultVar: 'REDIS_URL',
    url(host) {
      return `redis://${host}:6379`
    },
    memoryMb: 256
  },
  mongo: {
    image: 'mongo:7',
    port: 27017,
    env: {},
    tmpfs: ['/data/db'],
    caps: [...CAPS_ALL], // same as redis
    health: ['mongosh', '--quiet', '--eval', 'db.runCommand({ping:1}).ok'],
    cmd: ['mongod', '--bind_ip_all'],
    defaultVar: 'MONGODB_URI',
    url(host) {
      return `mongodb://${host}:27017/app`
    },
    memoryMb: 768
  }
}

const NAME_RE = /^[a-z][a-z0-9-]{0,20}$/
const INJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const INJECT_VALUES = new Set(['url', 'host', 'port', 'user', 'password', 'database'])
const ALLOWED_KEYS = new Set(['kind', 'name', 'inject'])

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function validateServices(list) {
  if (!Array.isArray(list)) return ['services must be an array']
  const problems = []
  if (list.length > 4) problems.push('services has too many entries (maximum 4)')
  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i]
    if (!isRecord(entry)) {
      problems.push(`services[${i}] must be an object`)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_KEYS.has(key)) problems.push(`services[${i}] has unknown property ${key}`)
    }
    const { kind, name, inject } = entry
    if (typeof kind !== 'string' || !(kind in CATALOG)) {
      problems.push(`services[${i}] has unknown kind ${String(kind)}`)
    }
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      problems.push(`services[${i}] has invalid name ${String(name)}`)
    } else {
      if (name === 'app') problems.push('services[${i}] name must not be app'.replace('[${i}]', `[${i}]`))
      if (seen.has(name)) problems.push(`services[${i}] has duplicate name ${name}`)
      else seen.add(name)
    }
    if (inject !== undefined) {
      if (!isRecord(inject)) {
        problems.push(`services[${i}] inject must be an object`)
      } else {
        const keys = Object.keys(inject)
        if (keys.length > 8) problems.push(`services[${i}] inject has too many keys (maximum 8)`)
        for (const k of keys) {
          if (!INJECT_KEY_RE.test(k) || k.startsWith('LD_') || k.startsWith('DOCKER_')) {
            problems.push(`services[${i}] has invalid inject key ${k}`)
          }
          if (!INJECT_VALUES.has(inject[k])) {
            problems.push(`services[${i}] has invalid inject value for ${k}`)
          }
        }
      }
    }
  }
  return problems
}

function userFor(kind) {
  if (kind === 'mysql' || kind === 'mariadb') return 'root'
  if (kind === 'redis' || kind === 'mongo') return ''
  return 'behique'
}

function passwordFor(kind) {
  if (kind === 'redis' || kind === 'mongo') return ''
  return 'behique'
}

export function resolveServices(list, { runId } = {}) {
  if (typeof runId !== 'string' || runId.length === 0) return []
  if (!Array.isArray(list)) return []
  if (validateServices(list).length > 0) return []
  return list.map((entry) => {
    const { kind, name } = entry
    const cat = CATALOG[kind]
    const alias = name
    let injected
    if (entry.inject !== undefined) {
      injected = {}
      for (const key of Object.keys(entry.inject)) {
        const want = entry.inject[key]
        if (want === 'url') injected[key] = cat.url(alias)
        else if (want === 'host') injected[key] = alias
        else if (want === 'port') injected[key] = String(cat.port)
        else if (want === 'user') injected[key] = userFor(kind)
        else if (want === 'password') injected[key] = passwordFor(kind)
        else if (want === 'database') injected[key] = 'app'
      }
    } else {
      injected = { [cat.defaultVar]: cat.url(alias) }
    }
    return {
      name,
      kind,
      image: cat.image,
      port: cat.port,
      env: { ...cat.env },
      tmpfs: [...cat.tmpfs],
      caps: [...cat.caps],
      cmd: [...cat.cmd],
      health: [...cat.health],
      memoryMb: cat.memoryMb,
      alias,
      injected
    }
  })
}

export function injectedEnv(resolved) {
  if (!Array.isArray(resolved)) return {}
  const out = {}
  for (const item of resolved) {
    if (!isRecord(item) || !isRecord(item.injected)) continue
    for (const key of Object.keys(item.injected)) {
      out[key] = item.injected[key]
    }
  }
  return out
}

export function describeServices(list) {
  if (!Array.isArray(list)) return []
  const lines = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const { kind, name, inject } = entry
    if (typeof kind !== 'string' || !(kind in CATALOG)) continue
    if (typeof name !== 'string' || !NAME_RE.test(name)) continue
    const cat = CATALOG[kind]
    let vars
    if (isRecord(inject)) vars = Object.keys(inject).sort()
    else vars = [cat.defaultVar]
    lines.push(`service: ${kind} (${cat.image}) as ${name}, injects ${vars.join(', ')}`)
  }
  return lines
}

function parseEnvLine(raw) {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (s === '' || s.startsWith('#')) return null
  if (s.startsWith('export ')) {
    s = s.slice('export '.length).trimStart()
    if (s === '' || s.startsWith('#')) return null
  } else if (s.startsWith('export\t')) {
    s = s.slice('export'.length).trimStart()
    if (s === '' || s.startsWith('#')) return null
  }
  const eq = s.indexOf('=')
  if (eq < 0) return null
  const key = s.slice(0, eq).trim()
  if (key === '') return null
  let value = s.slice(eq + 1).trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1)
    }
  }
  return { key, value }
}

function kindForUrl(value) {
  const lower = String(value).trim().toLowerCase()
  if (lower.startsWith('postgresql://') || lower.startsWith('postgres://')) return 'postgres'
  if (lower.startsWith('mysql://')) return 'mysql'
  if (lower.startsWith('mongodb+srv://') || lower.startsWith('mongodb://')) return 'mongo'
  if (lower.startsWith('redis://') || lower.startsWith('rediss://')) return 'redis'
  return null
}

function kindForComposeName(name) {
  if (typeof name !== 'string') return null
  const lower = name.toLowerCase()
  if (lower.includes('postgres') || lower === 'pg') return 'postgres'
  if (lower.includes('mariadb')) return 'mariadb'
  if (lower.includes('mysql')) return 'mysql'
  if (lower.includes('redis') || lower.includes('valkey')) return 'redis'
  if (lower.includes('mongo')) return 'mongo'
  return null
}

function validInjectKey(key) {
  return typeof key === 'string' && INJECT_KEY_RE.test(key) && !key.startsWith('LD_') && !key.startsWith('DOCKER_')
}

export function proposeServices(facts) {
  const empty = { services: [], evidence: [] }
  try {
    if (!isRecord(facts)) return { services: [], evidence: [] }
    const found = new Map()
    const evByKind = new Map()

    const envExample = facts.envExample
    if (isRecord(envExample) && Array.isArray(envExample.lines)) {
      for (const raw of envExample.lines) {
        const parsed = parseEnvLine(raw)
        if (!parsed) continue
        if (!validInjectKey(parsed.key)) continue
        const kind = kindForUrl(parsed.value)
        if (!kind) continue
        if (!found.has(kind)) {
          found.set(kind, { kind, name: kind, keys: [] })
          evByKind.set(kind, { source: 'env', keys: [] })
        }
        const rec = found.get(kind)
        if (rec.keys.length >= 8) continue
        if (rec.keys.includes(parsed.key)) continue
        rec.keys.push(parsed.key)
        evByKind.get(kind).keys.push(parsed.key)
      }
      for (const [kind, ev] of evByKind.entries()) {
        if (ev.source !== 'env') continue
        const keys = ev.keys
        if (keys.length === 0) continue
        ev.text = `.env.example sets ${keys.join(', ')} to a ${kind} address (high confidence)`
      }
    }

    const compose = facts.compose
    if (isRecord(compose) && Array.isArray(compose.services)) {
      for (const rawName of compose.services) {
        if (typeof rawName !== 'string') continue
        const trimmed = rawName.trim()
        if (trimmed === '') continue
        const lower = trimmed.toLowerCase()
        if (lower === 'db' || lower === 'database') continue
        const kind = kindForComposeName(trimmed)
        if (!kind) continue
        if (found.has(kind)) continue
        found.set(kind, { kind, name: kind, keys: null })
        evByKind.set(kind, { source: 'compose', name: trimmed, text: `compose.yml has a service named ${trimmed} (high confidence)` })
      }
    }

    const packageJson = facts.packageJson
    const depMap = [
      { deps: ['pg', 'postgres', 'pg-promise'], kind: 'postgres' },
      { deps: ['mysql2', 'mysql'], kind: 'mysql' },
      { deps: ['ioredis', 'redis'], kind: 'redis' },
      { deps: ['mongodb', 'mongoose'], kind: 'mongo' }
    ]
    let depNames = null
    if (isRecord(packageJson)) {
      const collected = []
      for (const field of ['dependencies', 'devDependencies']) {
        const obj = packageJson[field]
        if (!isRecord(obj)) continue
        for (const k of Object.keys(obj)) collected.push(k)
      }
      depNames = new Set(collected)
    }
    if (depNames !== null) {
      for (const { deps, kind } of depMap) {
        if (found.has(kind)) continue
        let hit = null
        for (const d of deps) {
          if (depNames.has(d)) {
            hit = d
            break
          }
        }
        if (!hit) continue
        found.set(kind, { kind, name: kind, keys: null })
        evByKind.set(kind, { source: 'deps', name: hit, text: `package.json depends on ${hit} (low confidence)` })
      }
    }

    const kinds = [...found.keys()].sort()
    const services = []
    const evidence = []
    for (const kind of kinds) {
      const rec = found.get(kind)
      const entry = { kind, name: kind }
      if (Array.isArray(rec.keys) && rec.keys.length > 0) {
        const inject = {}
        for (const k of rec.keys) inject[k] = 'url'
        entry.inject = inject
      }
      services.push(entry)
      const ev = evByKind.get(kind)
      if (ev && typeof ev.text === 'string') evidence.push(ev.text)
    }
    const check = validateServices(services)
    if (check.length > 0) return { services: [], evidence: [] }
    return { services, evidence }
  } catch {
    return empty
  }
}
