// inspect-more: read extra repo facts without running anything.
// Run: node --test src/release/onboard/inspect-more.test.mjs
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

const MAX_FILES = 200
const MAX_BYTES = 200000
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.cache', 'vendor', 'target'])
const PM_NAMES = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const LOCK_ORDER = [
  { file: 'pnpm-lock.yaml', name: 'pnpm' },
  { file: 'yarn.lock', name: 'yarn' },
  { file: 'package-lock.json', name: 'npm' },
  { file: 'bun.lockb', name: 'bun' },
  { file: 'bun.lock', name: 'bun' }
]
const ENV_CANDIDATES = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env', 'env.example']
const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

function emptyResult() {
  return {
    packageManager: { name: null, version: null, source: null },
    engines: { node: null },
    nodeVersionFile: null,
    workspaces: [],
    frameworks: [],
    envExample: null,
    compose: null,
    staticRoots: []
  }
}

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

async function lstatNoFollow(path) {
  try {
    const st = await fs.lstat(path)
    if (st.isSymbolicLink()) return null
    return st
  } catch {
    return null
  }
}

async function readDirNames(dir) {
  try {
    const st = await lstatNoFollow(dir)
    if (!st || !st.isDirectory()) return null
    return await fs.readdir(dir)
  } catch {
    return null
  }
}

function makeReader() {
  let count = 0
  async function readFile(path) {
    if (count >= MAX_FILES) return null
    const st = await lstatNoFollow(path)
    if (!st || !st.isFile()) return null
    if (st.size > MAX_BYTES) return null
    count += 1
    try {
      return await fs.readFile(path, 'utf8')
    } catch {
      return null
    }
  }
  async function existsFile(path) {
    const st = await lstatNoFollow(path)
    return Boolean(st && st.isFile())
  }
  async function existsDir(path) {
    const st = await lstatNoFollow(path)
    return Boolean(st && st.isDirectory())
  }
  return { readFile, existsFile, existsDir }
}

function parsePackageManagerField(value) {
  if (typeof value !== 'string') return null
  const at = value.indexOf('@')
  if (at <= 0) return null
  const name = value.slice(0, at).trim()
  if (!PM_NAMES.has(name)) return null
  let rest = value.slice(at + 1)
  const plus = rest.indexOf('+')
  if (plus >= 0) rest = rest.slice(0, plus)
  rest = rest.trim()
  if (rest.length === 0) return null
  return { name, version: rest, source: 'packageManager field' }
}

function collectWorkspacePatterns(rootPkg, pnpmText) {
  const out = []
  const ws = rootPkg ? rootPkg.workspaces : null
  if (Array.isArray(ws)) {
    for (const p of ws) if (typeof p === 'string') out.push(p)
  } else if (isRecord(ws) && Array.isArray(ws.packages)) {
    for (const p of ws.packages) if (typeof p === 'string') out.push(p)
  }
  if (typeof pnpmText === 'string') {
    for (const line of pnpmText.split('\n')) {
      const m = line.match(/^\s*-\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/)
      if (m) out.push(m[1])
    }
  }
  return out
}

function patternToDirs(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return null
  if (pattern.includes('!') || pattern.includes('**') || pattern.includes('..')) return null
  if (pattern.startsWith('/')) return null
  let norm = pattern.replace(/\/+$/, '')
  if (norm.startsWith('./')) norm = norm.slice(2)
  if (norm === '' || norm === '.') return null
  if (norm.includes('..')) return null
  if (norm.includes('*') || norm.includes('?') || norm.includes('[')) {
    if (!norm.endsWith('/*')) return null
    const base = norm.slice(0, -2)
    if (base === '' || base.includes('*') || base.includes('?') || base.includes('[') || base.includes('!')) return null
    if (base.includes('..') || base.includes('/')) return null
    if (base === '.' || base.startsWith('./')) return null
    return { kind: 'star', base }
  }
  if (norm.includes('/')) return null
  return { kind: 'plain', base: norm }
}

function parseComposeServices(raw) {
  const services = []
  const lines = String(raw).split('\n')
  let inServices = false
  for (const line of lines) {
    if (!inServices) {
      if (/^services:\s*(#.*)?$/.test(line)) inServices = true
      continue
    }
    if (/^[^\s#]/.test(line)) break
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const m = line.match(/^ {2,4}([A-Za-z0-9_.\-]+):\s*(#.*)?$/)
    if (m) {
      if (services.length < 12 && !services.includes(m[1])) services.push(m[1])
    }
  }
  return services
}

export async function inspectMore(repoPath) {
  const result = emptyResult()
  try {
    const baseStat = await lstatNoFollow(repoPath)
    if (!baseStat || !baseStat.isDirectory()) return result

    const reader = makeReader()
    let rootPkg = null
    let rootEntries = null
    try {
      const raw = await reader.readFile(join(repoPath, 'package.json'))
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        if (isRecord(parsed)) rootPkg = parsed
      }
    } catch {
      rootPkg = null
    }
    rootEntries = await readDirNames(repoPath)
    const rootEntrySet = new Set(Array.isArray(rootEntries) ? rootEntries : [])

    try {
      let found = null
      if (rootPkg && typeof rootPkg.packageManager === 'string') {
        found = parsePackageManagerField(rootPkg.packageManager)
      }
      if (found) {
        result.packageManager = found
      } else {
        for (const { file, name } of LOCK_ORDER) {
          if (await reader.existsFile(join(repoPath, file))) {
            result.packageManager = { name, version: null, source: 'lockfile' }
            break
          }
        }
      }
    } catch {
      result.packageManager = { name: null, version: null, source: null }
    }

    try {
      const node = rootPkg && isRecord(rootPkg.engines) && typeof rootPkg.engines.node === 'string'
        ? rootPkg.engines.node
        : null
      result.engines = { node: node && node.length > 0 ? node : null }
    } catch {
      result.engines = { node: null }
    }

    try {
      let nv = null
      for (const cand of ['.nvmrc', '.node-version']) {
        const raw = await reader.readFile(join(repoPath, cand))
        if (raw === null) continue
        const first = String(raw).split('\n')[0].trim().slice(0, 20).trim()
        if (first.length > 0) {
          nv = first
          break
        }
      }
      result.nodeVersionFile = nv
    } catch {
      result.nodeVersionFile = null
    }

    let workspaceDirs = []
    try {
      const pnpmRaw = await reader.readFile(join(repoPath, 'pnpm-workspace.yaml'))
      const patterns = collectWorkspacePatterns(rootPkg, pnpmRaw)
      const seen = new Set()
      const expanded = []
      for (const pattern of patterns) {
        const parsed = patternToDirs(pattern)
        if (!parsed) continue
        if (parsed.kind === 'plain') {
          if (SKIP_DIRS.has(parsed.base)) continue
          if (seen.has(parsed.base)) continue
          seen.add(parsed.base)
          expanded.push(parsed.base)
        } else {
          if (SKIP_DIRS.has(parsed.base)) continue
          const names = await readDirNames(join(repoPath, parsed.base))
          if (!names) continue
          for (const name of names) {
            if (name === '.' || name === '..') continue
            if (SKIP_DIRS.has(name)) continue
            const rel = parsed.base + '/' + name
            if (seen.has(rel)) continue
            seen.add(rel)
            expanded.push(rel)
          }
        }
      }
      const collected = []
      for (const dir of expanded) {
        const abs = join(repoPath, dir)
        const st = await lstatNoFollow(abs)
        if (!st || !st.isDirectory()) continue
        const pkgRaw = await reader.readFile(join(abs, 'package.json'))
        if (pkgRaw === null) continue
        let name = null
        let scripts = {}
        try {
          const parsed = JSON.parse(pkgRaw)
          if (!isRecord(parsed)) continue
          if (typeof parsed.name === 'string' && parsed.name.length > 0) name = parsed.name
          if (isRecord(parsed.scripts)) {
            const keys = Object.keys(parsed.scripts).sort().slice(0, 12)
            for (const k of keys) {
              const v = parsed.scripts[k]
              if (typeof v === 'string') scripts[k] = v.slice(0, 120)
            }
          }
        } catch {
          continue
        }
        collected.push({ dir, name, scripts })
      }
      collected.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
      result.workspaces = collected.slice(0, 8)
      workspaceDirs = result.workspaces.map((w) => w.dir)
    } catch {
      result.workspaces = []
      workspaceDirs = []
    }

    try {
      const searchDirs = ['.', ...workspaceDirs]
      const dirEntries = new Map()
      dirEntries.set('.', rootEntrySet)
      for (const dir of workspaceDirs) {
        if (dirEntries.has(dir)) continue
        const names = await readDirNames(join(repoPath, dir))
        dirEntries.set(dir, new Set(Array.isArray(names) ? names : []))
      }
      const hasPrefix = (set, prefix) => {
        if (!set) return false
        for (const n of set) if (n.startsWith(prefix)) return true
        return false
      }
      const hasExact = (set, name) => Boolean(set && set.has(name))
      const anyDir = (fn) => {
        for (const dir of searchDirs) {
          if (fn(dirEntries.get(dir))) return true
        }
        return false
      }
      const checks = [
        ['vite', (s) => hasPrefix(s, 'vite.config.')],
        ['next', (s) => hasPrefix(s, 'next.config.')],
        ['nuxt', (s) => hasPrefix(s, 'nuxt.config.')],
        ['astro', (s) => hasPrefix(s, 'astro.config.')],
        ['svelte', (s) => hasPrefix(s, 'svelte.config.')],
        ['angular', (s) => hasExact(s, 'angular.json')],
        ['webpack', (s) => hasPrefix(s, 'webpack.config.')],
        ['gatsby', (s) => hasPrefix(s, 'gatsby-config.')],
        ['remix', (s) => hasPrefix(s, 'remix.config.')],
        ['docusaurus', (s) => hasPrefix(s, 'docusaurus.config.')],
        ['eleventy', (s) => hasExact(s, '.eleventy.js') || hasPrefix(s, 'eleventy.config.')],
        ['jekyll', (s) => hasExact(s, '_config.yml')],
        ['hugo', (s) => hasExact(s, 'hugo.toml') || hasExact(s, 'hugo.yaml') || hasExact(s, 'config.toml')],
        ['mkdocs', (s) => hasExact(s, 'mkdocs.yml')]
      ]
      const found = []
      for (const [fname, fn] of checks) {
        if (anyDir(fn)) found.push(fname)
      }
      let vitepress = false
      try {
        if (await reader.existsDir(join(repoPath, '.vitepress'))) vitepress = true
        else if (await reader.existsDir(join(repoPath, 'docs', '.vitepress'))) vitepress = true
      } catch {
        vitepress = false
      }
      if (vitepress) found.push('vitepress')
      result.frameworks = [...new Set(found)].slice(0, 8)
    } catch {
      result.frameworks = []
    }

    try {
      const roots = ['.', ...workspaceDirs]
      let done = null
      for (const dir of roots) {
        for (const cand of ENV_CANDIDATES) {
          const rel = dir === '.' ? cand : dir + '/' + cand
          const raw = await reader.readFile(join(repoPath, rel))
          if (raw === null) continue
          const lines = String(raw).split('\n').slice(0, 40).map((l) => l.slice(0, 160).replace(/[ \t]+$/, ''))
          done = { file: rel, lines }
          break
        }
        if (done) break
      }
      result.envExample = done
    } catch {
      result.envExample = null
    }

    try {
      let done = null
      for (const cand of COMPOSE_CANDIDATES) {
        const raw = await reader.readFile(join(repoPath, cand))
        if (raw === null) continue
        done = { file: cand, services: parseComposeServices(raw) }
        break
      }
      result.compose = done
    } catch {
      result.compose = null
    }

    try {
      const found = []
      const checkRoot = async (rel) => {
        const abs = rel === '.' ? join(repoPath, 'index.html') : join(repoPath, rel, 'index.html')
        if (await reader.existsFile(abs)) found.push({ dir: rel, hasIndexHtml: true })
      }
      await checkRoot('.')
      const depth1 = []
      if (rootEntries) {
        for (const name of rootEntries) {
          if (name === '.' || name === '..') continue
          if (SKIP_DIRS.has(name)) continue
          const st = await lstatNoFollow(join(repoPath, name))
          if (!st || !st.isDirectory()) continue
          depth1.push(name)
        }
      }
      for (const d1 of depth1) {
        await checkRoot(d1)
      }
      for (const d1 of depth1) {
        const sub = await readDirNames(join(repoPath, d1))
        if (!sub) continue
        for (const name of sub) {
          if (name === '.' || name === '..') continue
          if (SKIP_DIRS.has(name)) continue
          const rel = d1 + '/' + name
          const st = await lstatNoFollow(join(repoPath, rel))
          if (!st || !st.isDirectory()) continue
          await checkRoot(rel)
        }
      }
      const nonRoot = found.filter((f) => f.dir !== '.').sort((a, b) => (a.dir < b.dir ? -1 : 1))
      const ordered = []
      if (found.some((f) => f.dir === '.')) ordered.push({ dir: '.', hasIndexHtml: true })
      for (const f of nonRoot) ordered.push(f)
      result.staticRoots = ordered.slice(0, 8)
    } catch {
      result.staticRoots = []
    }

    return result
  } catch {
    return result
  }
}

export default inspectMore
