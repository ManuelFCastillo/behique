// cache: pure pieces for the per-commit build cache kept as Docker images.
//   node --test src/release/sandbox/cache.test.mjs
// Pure functions only. No process is started, no file is read.
import { createHash } from 'node:crypto'
import { names, isRunId, isImage } from './docker-args.mjs'

export const CACHE_REPO = 'bq-cache'

const APP_RE = /^[a-z0-9-]{1,40}$/
const SHA_RE = /^[0-9a-f]{40}$/
const SHA12_RE = /^[0-9a-f]{12}$/
const FP8_RE = /^[0-9a-f]{8}$/
const KEY_RE = /^[a-z0-9-]{1,40}-[0-9a-f]{12}-[0-9a-f]{8}$/

function fail(error) {
  return { ok: false, error }
}

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkApp(app) {
  return typeof app === 'string' && APP_RE.test(app)
}

function checkSha(sha) {
  return typeof sha === 'string' && SHA_RE.test(sha)
}

function normalizeInstalls(installs) {
  if (!Array.isArray(installs)) return null
  const out = []
  for (const item of installs) {
    if (!isObj(item)) return null
    if (typeof item.cmd !== 'string') return null
    let args
    if (item.args === undefined) {
      args = []
    } else if (Array.isArray(item.args) && item.args.every(a => typeof a === 'string')) {
      args = [...item.args]
    } else {
      return null
    }
    out.push({ cmd: item.cmd, args })
  }
  return out
}

function normalizeKinds(services) {
  if (!Array.isArray(services)) return null
  const kinds = []
  for (const s of services) {
    if (typeof s === 'string') {
      kinds.push(s)
    } else if (isObj(s) && typeof s.kind === 'string') {
      kinds.push(s.kind)
    } else {
      return null
    }
  }
  kinds.sort()
  return kinds
}

export function cacheKey(input) {
  if (!isObj(input)) return fail('app, sha, image, installs, allowScripts, root and services are required.')
  const { app, sha, image, installs, allowScripts, root, services } = input
  if (!checkApp(app)) return fail('invalid app.')
  if (!checkSha(sha)) return fail('invalid sha.')
  if (!isImage(image)) return fail('invalid image.')
  const normInstalls = normalizeInstalls(installs)
  if (normInstalls === null) return fail('invalid installs.')
  let scripts = false
  if (allowScripts === undefined) {
    scripts = false
  } else if (typeof allowScripts === 'boolean') {
    scripts = allowScripts
  } else {
    return fail('invalid allowScripts.')
  }
  let r = null
  if (root === undefined || root === null) {
    if (root === null) return fail('invalid root.')
    r = null
  } else if (typeof root === 'string') {
    r = root
  } else {
    return fail('invalid root.')
  }
  const kinds = normalizeKinds(services)
  if (kinds === null) return fail('invalid services.')
  const payload = {
    image,
    installs: normInstalls,
    allowScripts: scripts,
    root: r,
    services: kinds
  }
  const json = JSON.stringify(payload)
  const fingerprint = createHash('sha256').update(json).digest('hex').slice(0, 8)
  const sha12 = sha.slice(0, 12)
  const key = app + '-' + sha12 + '-' + fingerprint
  return { ok: true, key, fingerprint }
}

export function isCacheKey(s) {
  return typeof s === 'string' && KEY_RE.test(s)
}

export function cacheImage(key) {
  if (!isCacheKey(key)) return null
  return CACHE_REPO + ':' + key
}

export function isCacheImage(s) {
  if (typeof s !== 'string') return false
  const prefix = CACHE_REPO + ':'
  if (!s.startsWith(prefix)) return false
  return isCacheKey(s.slice(prefix.length))
}

export function parseCacheImage(s) {
  if (!isCacheImage(s)) return null
  const key = s.slice(CACHE_REPO.length + 1)
  const parts = key.split('-')
  if (parts.length < 3) return null
  const fingerprint = parts.pop()
  const sha12 = parts.pop()
  const app = parts.join('-')
  if (!checkApp(app)) return null
  if (!SHA12_RE.test(sha12)) return null
  if (!FP8_RE.test(fingerprint)) return null
  if (!isCacheKey(key)) return null
  return { app, sha12, fingerprint }
}

export function committerArgs(input) {
  if (!isObj(input)) return fail('runId, image and volumeShort are required.')
  const { runId, image, volumeShort } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isImage(image)) return fail('invalid image.')
  const vol = names(runId, volumeShort)
  if (vol === null) return fail('invalid volumeShort.')
  const name = names(runId, 'commit')
  const args = [
    'run',
    '--name', name,
    '--label', 'behique=1',
    '--label', `behique.run=${runId}`,
    '--label', 'behique.role=commit',
    '--user', '0:0',
    '--cap-drop=ALL',
    '--cap-add=CHOWN',
    '--cap-add=DAC_OVERRIDE',
    '--cap-add=FOWNER',
    '--security-opt=no-new-privileges',
    '--network', 'none',
    '--volume', `${vol}:/vol:ro`,
    image,
    'sh', '-c', 'mkdir -p /work && cp -a /vol/. /work/'
  ]
  return { ok: true, args }
}

export function commitArgs(input, opts = {}) {
  if (!isObj(input)) return fail('runId, key, app and sha are required.')
  const { runId, key, app, sha } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isCacheKey(key)) return fail('invalid key.')
  if (!checkApp(app)) return fail('invalid app.')
  if (!checkSha(sha)) return fail('invalid sha.')
  let now = Date.now()
  if (isObj(opts) && opts.now !== undefined) {
    if (typeof opts.now !== 'number' || !Number.isFinite(opts.now)) return fail('invalid now.')
    now = opts.now
  }
  const iso = new Date(now).toISOString()
  const cname = names(runId, 'commit')
  const args = [
    'commit',
    '--change', 'USER 1000:1000',
    '--change', 'WORKDIR /work',
    '--change', 'LABEL behique=1',
    '--change', 'LABEL behique.cache=1',
    '--change', `LABEL behique.app=${app}`,
    '--change', `LABEL behique.sha=${sha}`,
    '--change', `LABEL behique.created=${iso}`,
    cname,
    `${CACHE_REPO}:${key}`
  ]
  return { ok: true, args }
}

export function cacheListArgs() {
  return {
    ok: true,
    args: ['image', 'ls', '--filter', 'label=behique.cache=1', '--format', '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}']
  }
}

function parseCreatedAt(text) {
  const t = String(text).trim()
  if (!t) return { text: t, ms: null }
  const tokens = t.split(/\s+/)
  let rest = t
  const last = tokens[tokens.length - 1]
  if (tokens.length > 1 && /^[A-Za-z]+$/.test(last)) {
    rest = tokens.slice(0, -1).join(' ')
  }
  const ms = Date.parse(rest)
  if (Number.isNaN(ms)) return { text: t, ms: null }
  return { text: t, ms }
}

export function parseCacheList(stdout) {
  try {
    if (typeof stdout !== 'string') return []
    const lines = stdout.split('\n')
    const out = []
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      const cols = raw.split('\t')
      if (cols.length < 3) continue
      const image = cols[0].trim()
      const createdText = cols[1].trim()
      const size = cols.slice(2).join('\t').trim()
      if (!isCacheImage(image)) continue
      const parsed = parseCacheImage(image)
      if (!parsed) continue
      const key = image.slice(CACHE_REPO.length + 1)
      const { ms } = parseCreatedAt(createdText)
      out.push({
        image,
        key,
        app: parsed.app,
        sha12: parsed.sha12,
        fingerprint: parsed.fingerprint,
        createdAt: ms,
        size
      })
    }
    return out
  } catch {
    return []
  }
}

export function cacheInspectArgs(image) {
  if (!isCacheImage(image)) return fail('invalid cache image.')
  return { ok: true, args: ['image', 'inspect', '--format', '{{.Id}}', image] }
}

export function cacheRemoveArgs(images) {
  if (!Array.isArray(images)) return fail('images must be an array of 1 to 50 cache images.')
  if (images.length < 1 || images.length > 50) return fail('images must be an array of 1 to 50 cache images.')
  for (const img of images) {
    if (!isCacheImage(img)) return fail(`invalid cache image: ${String(img)}.`)
  }
  return { ok: true, args: ['image', 'rm', ...images] }
}

export function prunePlan(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : []
  let keepPerApp = 4
  let maxAgeDays = 14
  let now = Date.now()
  if (isObj(opts)) {
    if (opts.keepPerApp !== undefined) keepPerApp = opts.keepPerApp
    if (opts.maxAgeDays !== undefined) maxAgeDays = opts.maxAgeDays
    if (opts.now !== undefined) now = opts.now
  }
  if (!Number.isInteger(keepPerApp) || keepPerApp < 1) keepPerApp = 4
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) maxAgeDays = 14
  if (typeof now !== 'number' || !Number.isFinite(now)) now = Date.now()
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
  const byApp = new Map()
  for (const e of list) {
    if (!isObj(e) || typeof e.image !== 'string' || typeof e.app !== 'string') continue
    if (!byApp.has(e.app)) byApp.set(e.app, [])
    byApp.get(e.app).push(e)
  }
  const remove = []
  const keep = []
  const rank = e => (typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : Number.NEGATIVE_INFINITY)
  for (const group of byApp.values()) {
    const sorted = [...group].sort((a, b) => rank(b) - rank(a))
    for (let i = 0; i < sorted.length; i += 1) {
      const e = sorted[i]
      if (i >= keepPerApp) {
        remove.push(e.image)
        continue
      }
      if (i === 0) {
        keep.push(e.image)
        continue
      }
      if (typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) && now - e.createdAt > maxAgeMs) {
        remove.push(e.image)
      } else {
        keep.push(e.image)
      }
    }
  }
  return { remove, keep }
}

export function hitPlan(input) {
  if (!isObj(input)) return fail('runId, key, limits, env, cmd and port are required.')
  const { runId, key, limits, env, cmd, port, networks } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isCacheKey(key)) return fail('invalid key.')
  if (!Array.isArray(cmd) || cmd.length < 1) return fail('cmd must be a non-empty array of strings.')
  for (const part of cmd) {
    if (typeof part !== 'string') return fail('cmd must be a non-empty array of strings.')
  }
  if (typeof cmd[0] !== 'string' || cmd[0].startsWith('-')) return fail('cmd must not start with a flag.')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return fail('invalid port.')
  if (!isObj(limits)) return fail('limits is required with memoryMb, cpus and pids.')
  let nets = networks
  if (nets === undefined) nets = ['int']
  const baseEnv = (env !== undefined && isObj(env)) ? env : {}
  const merged = { ...baseEnv, HOME: '/work/.home', PORT: String(port) }
  const plan = {
    runId,
    short: 'app',
    role: 'app',
    image: `${CACHE_REPO}:${key}`,
    networks: nets,
    volume: null,
    workdir: '/work',
    user: '1000:1000',
    cmd: [...cmd],
    env: merged,
    tmpfs: [],
    caps: [],
    limits,
    interactive: false,
    detach: true,
    rm: false,
    readOnly: false
  }
  return { ok: true, plan }
}
