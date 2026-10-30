// App profile: validate DATA describing how to run one app, turn it into an adapter for startBuild.
//   node --test src/release/onboard/profile.test.mjs
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export const ALLOWED_COMMANDS = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'python3', 'php']

const HERE = dirname(fileURLToPath(import.meta.url))
export const PROFILE_DIR = join(HERE, 'profiles')
const DEFAULT_SERVER = join(HERE, 'static-server.mjs')

const TOP_FIELDS = new Set(['name', 'repo', 'workRoot', 'defaults', 'serve', 'ready', 'viewport', 'setup', 'regions', 'anchors', 'notes'])
const NAME_RE = /^[a-z0-9-]+$/
const EVAL_ARGS = new Set(['-e', '--eval', '-p', '--print', '-c', '-r', '--require', '--import', '--loader', '--experimental-loader'])

function isEvalArg(a) {
  if (EVAL_ARGS.has(a)) return true
  if (a.startsWith('--eval=')) return true
  if (a.startsWith('--print=')) return true
  return false
}

function checkCmd(cmd, where, problems) {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    problems.push(`${where}.cmd must be a non-empty string`)
    return
  }
  if (cmd.includes('/')) problems.push(`${where}.cmd must be a bare name without '/'`)
  if (!ALLOWED_COMMANDS.includes(cmd)) problems.push(`${where}.cmd "${cmd}" is not in ALLOWED_COMMANDS`)
}

function checkArgs(args, where, problems) {
  if (args === undefined) return
  if (!Array.isArray(args)) {
    problems.push(`${where}.args must be an array of strings`)
    return
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (typeof a !== 'string') {
      problems.push(`${where}.args[${i}] must be a string`)
      continue
    }
    if (/[;&|`$<>]/.test(a) || a.includes('\n') || a.includes('\r')) {
      problems.push(`${where}.args[${i}] contains a shell operator character`)
    }
    if (isEvalArg(a)) {
      problems.push(`${where}.args[${i}] "${a}" would run inline code`)
    }
  }
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function checkBox(box, where, problems) {
  if (typeof box !== 'object' || box === null || Array.isArray(box)) {
    problems.push(`${where} must be { x, y, w, h }`)
    return
  }
  for (const k of ['x', 'y', 'w', 'h']) {
    if (!isNum(box[k])) {
      problems.push(`${where}.${k} must be a number`)
    }
  }
  if (isNum(box.x) && box.x < 0) problems.push(`${where}.x must be non-negative`)
  if (isNum(box.y) && box.y < 0) problems.push(`${where}.y must be non-negative`)
  if (isNum(box.w) && !(box.w > 0)) problems.push(`${where}.w must be above 0`)
  if (isNum(box.h) && !(box.h > 0)) problems.push(`${where}.h must be above 0`)
}

export function validateProfile(profile) {
  const problems = []
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return ['profile must be an object']
  for (const k of Object.keys(profile)) {
    if (!TOP_FIELDS.has(k)) problems.push(`unknown field "${k}"`)
  }
  if (typeof profile.name !== 'string' || !NAME_RE.test(profile.name)) {
    problems.push('name must match /^[a-z0-9-]+$/')
  }
  for (const k of ['repo', 'workRoot']) {
    const v = profile[k]
    if (typeof v !== 'string' || v.length === 0) {
      problems.push(`${k} must be a non-empty string`)
    } else if (!v.startsWith('/') && !v.startsWith('~/')) {
      problems.push(`${k} must start with / or ~/`)
    }
  }
  if (profile.defaults !== undefined) {
    if (typeof profile.defaults !== 'object' || profile.defaults === null || Array.isArray(profile.defaults)) {
      problems.push('defaults must be an object')
    } else {
      for (const k of ['good', 'cand']) {
        const v = profile.defaults[k]
        if (typeof v !== 'string' || v.length === 0) problems.push(`defaults.${k} must be a non-empty string`)
      }
    }
  }
  const serve = profile.serve
  if (typeof serve !== 'object' || serve === null || Array.isArray(serve)) {
    problems.push('serve must be an object')
  } else {
    if (serve.kind !== 'static' && serve.kind !== 'command') {
      problems.push('serve.kind must be "static" or "command"')
    }
    if (serve.kind === 'static' || serve.kind === undefined) {
      if (serve.overrides !== undefined) {
        if (typeof serve.overrides !== 'object' || serve.overrides === null || Array.isArray(serve.overrides)) {
          problems.push('serve.overrides must be an object')
        } else {
          for (const [k, v] of Object.entries(serve.overrides)) {
            if (!k.startsWith('/')) problems.push(`serve.overrides key "${k}" must start with /`)
            if (typeof v !== 'string') problems.push(`serve.overrides["${k}"] must be a string`)
          }
        }
      }
    }
    if (serve.kind === 'command') {
      checkCmd(serve.cmd, 'serve', problems)
      checkArgs(serve.args ?? [], 'serve', problems)
      if (serve.args !== undefined && !Array.isArray(serve.args)) {
        // already reported
      }
      if (serve.install !== undefined) {
        if (!Array.isArray(serve.install)) {
          problems.push('serve.install must be an array')
        } else {
          serve.install.forEach((item, i) => {
            if (typeof item !== 'object' || item === null) {
              problems.push(`serve.install[${i}] must be an object`)
              return
            }
            checkCmd(item.cmd, `serve.install[${i}]`, problems)
            checkArgs(item.args ?? [], `serve.install[${i}]`, problems)
          })
        }
      }
      if (serve.basePath !== undefined && typeof serve.basePath !== 'string') {
        problems.push('serve.basePath must be a string')
      }
    } else if (serve.kind === 'static') {
      // still validate command-ish fields if present so mistakes surface
      if (serve.cmd !== undefined) checkCmd(serve.cmd, 'serve', problems)
    }
  }
  if (profile.viewport !== undefined) {
    const v = profile.viewport
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      problems.push('viewport must be an object')
    } else {
      for (const k of ['width', 'height']) {
        if (!Number.isInteger(v[k]) || v[k] <= 0) problems.push(`viewport.${k} must be a positive integer`)
      }
      if (v.deviceScaleFactor !== 1 && v.deviceScaleFactor !== 2) {
        problems.push('viewport.deviceScaleFactor must be 1 or 2')
      }
    }
  }
  if (profile.ready !== undefined) {
    const r = profile.ready
    if (typeof r !== 'object' || r === null || Array.isArray(r)) {
      problems.push('ready must be an object')
    } else {
      if (r.path !== undefined && typeof r.path !== 'string') problems.push('ready.path must be a string')
      if (r.timeoutMs !== undefined && (!isNum(r.timeoutMs) || r.timeoutMs <= 0)) {
        problems.push('ready.timeoutMs must be a positive number')
      }
    }
  }
  if (profile.setup !== undefined) {
    if (!Array.isArray(profile.setup)) {
      problems.push('setup must be an array')
    } else {
      profile.setup.forEach((item, i) => {
        const where = `setup[${i}]`
        if (typeof item !== 'object' || item === null) {
          problems.push(`${where} must be an object`)
          return
        }
        if (item.type !== 'click_at' && item.type !== 'wait' && item.type !== 'press') {
          problems.push(`${where}.type must be click_at, wait or press`)
          return
        }
        if (item.type === 'click_at') {
          if (!isNum(item.x) || !isNum(item.y)) problems.push(`${where} needs numeric x and y`)
        } else if (item.type === 'wait') {
          if (!isNum(item.ms)) {
            problems.push(`${where} needs numeric ms`)
          } else if (item.ms > 5000) {
            problems.push(`${where}.ms must be up to 5000`)
          } else if (item.ms < 0) {
            problems.push(`${where}.ms must be non-negative`)
          }
        } else if (item.type === 'press') {
          if (typeof item.key !== 'string' || item.key.length === 0) problems.push(`${where} needs a key string`)
        }
      })
    }
  }
  for (const k of ['regions', 'anchors']) {
    if (profile[k] !== undefined) {
      const v = profile[k]
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        problems.push(`${k} must be an object`)
      } else {
        for (const [name, box] of Object.entries(v)) checkBox(box, `${k}.${name}`, problems)
      }
    }
  }
  if (profile.notes !== undefined && typeof profile.notes !== 'string') {
    problems.push('notes must be a string')
  }
  return problems
}

export function normalizeProfile(profile) {
  const problems = validateProfile(profile)
  if (problems.length > 0) throw new Error(`invalid profile: ${problems.join('; ')}`)
  const copy = JSON.parse(JSON.stringify(profile))
  if (copy.viewport === undefined) copy.viewport = { width: 1280, height: 800, deviceScaleFactor: 2 }
  if (copy.ready === undefined) copy.ready = { path: '/', timeoutMs: 30000 }
  if (copy.setup === undefined) copy.setup = []
  if (copy.regions === undefined) copy.regions = {}
  if (copy.anchors === undefined) copy.anchors = {}
  if (copy.serve.kind === 'static') {
    if (copy.serve.overrides === undefined) copy.serve.overrides = {}
  }
  if (copy.serve.kind === 'command') {
    if (copy.serve.install === undefined) copy.serve.install = []
    if (copy.serve.basePath === undefined) copy.serve.basePath = ''
  }
  return copy
}

function warnSuffix(cmd, args) {
  const a = args ?? []
  if (cmd === 'npx') return true
  if (cmd === 'npm' && a[0] === 'exec') return true
  if (cmd === 'pnpm' && a[0] === 'dlx') return true
  if (cmd === 'yarn' && a[0] === 'dlx') return true
  return false
}

function warn(text) {
  return text + ' (downloads and runs packages from the internet)'
}

export function describeCommands(profile) {
  const p = normalizeProfile(profile)
  const lines = []
  if (p.serve.kind === 'static') {
    lines.push('serve: built-in static file server')
    return lines
  }
  for (const item of p.serve.install ?? []) {
    const text = `install: ${item.cmd}${(item.args ?? []).length > 0 ? ' ' + item.args.join(' ') : ''}`
    lines.push(warnSuffix(item.cmd, item.args ?? []) ? warn(text) : text)
  }
  const args = p.serve.args ?? []
  const text = `serve: ${p.serve.cmd}${args.length > 0 ? ' ' + args.join(' ') : ''}`
  lines.push(warnSuffix(p.serve.cmd, args) ? warn(text) : text)
  return lines
}

function expandHome(p, home) {
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

export function profileToAdapter(profile, { home = homedir(), serverPath = DEFAULT_SERVER } = {}) {
  const p = normalizeProfile(profile)
  const repo = expandHome(p.repo, home)
  const workRoot = expandHome(p.workRoot, home)
  const basePath = p.serve.kind === 'command' ? (p.serve.basePath ?? '') : ''
  const installs = p.serve.kind === 'command' ? (p.serve.install ?? []) : []
  async function prepare(dir) {
    for (const item of installs) {
      await runFile(item.cmd, item.args ?? [], { cwd: dir, timeout: 600000 })
    }
    return { entries: 0 }
  }
  function serve(dir, port) {
    if (p.serve.kind === 'static') {
      return { cmd: 'node', args: [serverPath, dir, String(port), JSON.stringify(p.serve.overrides ?? {})] }
    }
    const args = (p.serve.args ?? []).map(a => a.split('{port}').join(String(port)))
    return { cmd: p.serve.cmd, args }
  }
  return { name: p.name, repo, workRoot, cleanPaths: ['.behique-never-exists'], feed: null, basePath, prepare, serve }
}

function effectiveDir(explicit) {
  if (explicit) return explicit
  const env = process.env.BEHIQUE_PROFILE_DIR ?? process.env.BEHIQUE_PROFILES_DIR
  if (env) return env
  return PROFILE_DIR
}

export function profilePath(name, dir) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid profile name "${name}"`)
  return join(effectiveDir(dir), name + '.json')
}

export function saveProfile(profile, dir) {
  const problems = validateProfile(profile)
  if (problems.length > 0) throw new Error(`invalid profile: ${problems.join('; ')}`)
  const path = profilePath(profile.name, dir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  return path
}

export function loadProfile(name, dir) {
  const path = profilePath(name, dir)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`profile "${name}" not found at ${path}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`profile "${name}" at ${path} is not valid JSON`)
  }
  return normalizeProfile(parsed)
}
