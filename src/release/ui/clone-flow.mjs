// Clone a GitHub repository into the apps folder, only after a person confirms.
// Preview shows the exact command, clone runs only with the fingerprint of that preview.
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/
const PREFIX = 'https://github.com/'
const BAD_REPO = 'That is not a GitHub repository name.'
const BAD_FOLDER = 'That name cannot be used as a folder in the apps folder.'

export function parseRepoRef(text) {
  if (typeof text !== 'string') return null
  if (text.length === 0) return null
  if (/\s/.test(text)) return null
  if (text.includes('?') || text.includes('#')) return null
  let rest = text
  if (rest.startsWith(PREFIX)) {
    rest = rest.slice(PREFIX.length)
  } else if (rest.includes('://')) {
    return null
  }
  if (rest.length === 0) return null
  // Optional single trailing slash.
  if (rest.endsWith('/')) rest = rest.slice(0, -1)
  if (rest.length === 0) return null
  // Optional trailing .git (only the suffix, not part of the name check beyond this).
  if (rest.endsWith('.git')) rest = rest.slice(0, -4)
  if (rest.length === 0) return null
  if (rest.includes('?') || rest.includes('#')) return null
  const parts = rest.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!OWNER_RE.test(owner)) return null
  if (!NAME_RE.test(name)) return null
  if (name === '.' || name === '..') return null
  if (name.startsWith('-')) return null
  if (name.includes('..')) return null
  return { owner, name }
}

function toSizeMb(sizeKb) {
  if (typeof sizeKb !== 'number' || !Number.isFinite(sizeKb) || sizeKb < 0) return null
  return Math.round((sizeKb / 1024) * 10) / 10
}

export function clonePlan({ fullName, appsRoot, exists, info }) {
  const parsed = parseRepoRef(fullName)
  if (!parsed) return { ok: false, error: BAD_REPO }
  const { owner, name } = parsed
  if (!FOLDER_RE.test(name) || name.startsWith('w-') || name === 'work') {
    return { ok: false, error: BAD_FOLDER }
  }
  const root = resolve(String(appsRoot))
  const target = resolve(root, name)
  const expected = join(root, name)
  if (target !== expected && !target.startsWith(root + sep)) {
    return { ok: false, error: BAD_FOLDER }
  }
  if (!target.startsWith(root + sep) && target !== root) {
    return { ok: false, error: BAD_FOLDER }
  }
  const rel = target.slice(root.length)
  if (rel.includes('..')) return { ok: false, error: BAD_FOLDER }
  let already = false
  try {
    already = Boolean(exists(target))
  } catch (e) {
    throw e
  }
  if (already) return { ok: false, error: `Already cloned: ${name} is in the apps folder.` }
  const src = info && typeof info === 'object' ? info : {}
  const sizeMb = toSizeMb(src.sizeKb)
  const isPrivate = Boolean(src.isPrivate)
  const isFork = Boolean(src.isFork)
  const isArchived = Boolean(src.isArchived)
  const defaultBranch = typeof src.defaultBranch === 'string' ? src.defaultBranch : null
  const url = `https://github.com/${owner}/${name}.git`
  const command = ['git', 'clone', '--filter=blob:none', '--', url, target]
  const warnings = []
  if (isPrivate) warnings.push('This is a private repository.')
  if (isArchived) warnings.push('This repository is archived.')
  if (typeof sizeMb === 'number' && sizeMb > 500) warnings.push(`This repository is large (about ${sizeMb} MB).`)
  if (isFork) warnings.push('This is a fork.')
  const plan = { owner, name, url, path: target, command, sizeMb, isPrivate, isFork, isArchived, defaultBranch, warnings }
  return { ok: true, plan }
}

function fingerprint(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16)
}

export async function clonePreview(input, deps) {
  try {
    const repo = input ? input.repo : undefined
    const parsed = parseRepoRef(repo)
    if (!parsed) return { ok: false, status: 400, error: BAD_REPO }
    const { appsRoot, exists, repoInfo } = deps ?? {}
    let info
    try {
      info = await repoInfo(parsed.owner, parsed.name)
    } catch {
      return { ok: false, status: 404, error: 'Could not read that repository from GitHub.' }
    }
    let planned
    try {
      planned = clonePlan({ fullName: `${parsed.owner}/${parsed.name}`, appsRoot, exists, info })
    } catch (e) {
      return { ok: false, status: 500, error: String((e && e.message) || e) }
    }
    if (!planned.ok) return { ok: false, status: 400, error: planned.error }
    const plan = planned.plan
    const commandLine = plan.command.join(' ')
    const confirm = fingerprint(plan)
    return { ok: true, plan, commandLine, confirm }
  } catch (e) {
    return { ok: false, status: 500, error: String((e && e.message) || e) }
  }
}

function firstLine(s) {
  const text = typeof s === 'string' ? s : String(s ?? '')
  return text.split(/\r?\n/)[0].slice(0, 200)
}

export async function cloneRun(input, deps) {
  try {
    const { appsRoot, exists, repoInfo, exec, timeoutMs = 600000 } = deps ?? {}
    const preview = await clonePreview({ repo: input ? input.repo : undefined }, { appsRoot, exists, repoInfo })
    if (!preview.ok) return { ok: false, status: preview.status, error: preview.error }
    const confirm = input ? input.confirm : undefined
    if (typeof confirm !== 'string' || confirm !== preview.confirm) {
      return { ok: false, status: 409, stale: true, error: 'What would be run has changed, or was not reviewed. Review it again before cloning.' }
    }
    let result
    try {
      result = await exec(preview.plan.command, { timeoutMs })
    } catch (e) {
      const detail = e && typeof e.stderr === 'string' ? e.stderr : (e && e.message) || e
      return { ok: false, status: 502, error: `The clone failed: ${firstLine(detail)}` }
    }
    const code = result ? result.code : undefined
    if (code === 0) return { ok: true, path: preview.plan.path, name: preview.plan.name }
    const stderr = result ? result.stderr : ''
    return { ok: false, status: 502, error: `The clone failed: ${firstLine(stderr)}` }
  } catch (e) {
    return { ok: false, status: 500, error: String((e && e.message) || e) }
  }
}
