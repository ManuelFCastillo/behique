// Start a VISUAL check from the dashboard: pure validation, argv and progress helpers.
// No spawning, no file access, no network. Everything in the request is untrusted.
import { REF } from '../runparams.mjs'

const APP_RE = /^[a-z0-9-]+$/
const CASE_RE = /^[\w.-]+$/
const RANGE_RE = /bisect range:\s*good through #(\d+),\s*bad from #(\d+),\s*of (\d+)/
const MARKERS = [
  ['progress: building both versions', 'building'],
  ['progress: taking pictures', 'pictures'],
  ['progress: measuring noise', 'noise'],
  ['progress: comparing regions', 'comparing'],
  ['progress: searching', 'searching'],
  ['progress: recording', 'recording'],
]

function shortRef(ref) {
  return String(ref ?? '').slice(0, 30)
}

function badRef(label, ref) {
  return `The ${label} version "${shortRef(ref)}" is not a valid version name.`
}

function missingRef(label, ref) {
  return `There is no ${label} version "${ref}" in the repository.`
}

function pickRaw(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  return value
}

/** Returns { ok: true, params, note } or { ok: false, error }. Never throws. */
export async function validateVisualRun(input, { listProfiles, loadProfile, git }) {
  const bad = error => ({ ok: false, error })
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return bad('Choose one of the apps that has been set up.')
    }
    let names
    try {
      names = await listProfiles()
    } catch {
      return bad('Choose one of the apps that has been set up.')
    }
    const app = input.app
    if (typeof app !== 'string' || !Array.isArray(names) || !names.includes(app)) {
      return bad('Choose one of the apps that has been set up.')
    }
    let profile
    try {
      profile = await loadProfile(app)
    } catch {
      return bad(`Could not load the profile for "${app}".`)
    }
    if (typeof profile !== 'object' || profile === null) {
      return bad(`Could not load the profile for "${app}".`)
    }
    const repo = profile.repo
    const defaults = (profile.defaults !== null && typeof profile.defaults === 'object' && !Array.isArray(profile.defaults)) ? profile.defaults : {}
    const goodRaw = pickRaw(input.goodRef, defaults.good)
    const candRaw = pickRaw(input.candRef, defaults.cand)
    const sha = {}
    const refs = {}
    for (const [key, label] of [['goodRef', 'old'], ['candRef', 'new']]) {
      const raw = key === 'goodRef' ? goodRaw : candRaw
      if (typeof raw !== 'string') {
        return bad(badRef(label, String(raw ?? '')))
      }
      const ref = raw.trim()
      if (!REF.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) {
        return bad(badRef(label, ref))
      }
      let run
      try {
        run = git(repo)
      } catch {
        return bad(missingRef(label, ref))
      }
      const r = await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      if (!r || r.code !== 0 || !r.out) {
        return bad(missingRef(label, ref))
      }
      sha[key] = String(r.out).trim()
      refs[key] = ref
    }
    let bisect = input.bisect !== false
    let note = null
    if (sha.goodRef === sha.candRef) {
      bisect = false
      note = 'The two versions are the same, so there is nothing to search; this is a clean-run check.'
    } else if (bisect) {
      let run
      try {
        run = git(repo)
      } catch {
        return bad('For the search, the old version must come before the new one in the history. Switch them, or untick the search to compare anyway.')
      }
      const a = await run(['merge-base', '--is-ancestor', sha.goodRef, sha.candRef])
      if (!a || a.code !== 0) {
        return bad('For the search, the old version must come before the new one in the history. Switch them, or untick the search to compare anyway.')
      }
    }
    let region = null
    if (input.region !== undefined && input.region !== null && !(typeof input.region === 'string' && input.region === '')) {
      if (typeof input.region !== 'string') {
        return bad('That region is not in this app\'s profile.')
      }
      const regions = (profile.regions !== null && typeof profile.regions === 'object' && !Array.isArray(profile.regions)) ? profile.regions : {}
      if (!Object.prototype.hasOwnProperty.call(regions, input.region)) {
        return bad('That region is not in this app\'s profile.')
      }
      region = input.region
    }
    return {
      ok: true,
      note,
      params: {
        app,
        goodRef: refs.goodRef,
        candRef: refs.candRef,
        goodSha: sha.goodRef,
        candSha: sha.candRef,
        bisect,
        region,
      },
    }
  } catch {
    return { ok: false, error: 'Choose one of the apps that has been set up.' }
  }
}

function assertRef(label, ref) {
  if (typeof ref !== 'string' || !REF.test(ref) || ref.includes('..')) {
    throw new Error(`unsafe ${label} "${String(ref ?? '').slice(0, 30)}"`)
  }
}

/** Argument list (NOT including `node`) for node src/release/visual/check.mjs ... */
export function visualArgv(params, { ports = [8301, 8302] } = {}) {
  if (typeof params !== 'object' || params === null) throw new Error('params must be an object')
  const { app, goodRef, candRef, bisect, region } = params
  if (typeof app !== 'string' || !APP_RE.test(app)) {
    throw new Error(`unsafe app "${String(app ?? '').slice(0, 30)}"`)
  }
  assertRef('goodRef', goodRef)
  assertRef('candRef', candRef)
  if (!Array.isArray(ports) || ports.length !== 2) throw new Error('ports must be two integers from 1024 to 65535')
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      throw new Error(`unsafe ports "${String(ports)}"`)
    }
  }
  const argv = ['src/release/visual/check.mjs', app, goodRef, candRef]
  if (bisect === true) argv.push('--bisect')
  if (region !== undefined && region !== null) {
    if (typeof region !== 'string' || region.length === 0 || /\s/.test(region) || region.startsWith('-')) {
      throw new Error(`unsafe region "${String(region ?? '').slice(0, 30)}"`)
    }
    argv.push('--region', region)
  }
  argv.push('--ports', `${ports[0]},${ports[1]}`)
  return argv
}

function baseProgress(lines) {
  let phase = 'starting'
  let lastMarker = null
  for (const raw of lines) {
    const line = String(raw ?? '').trim()
    for (const [marker, name] of MARKERS) {
      if (line === marker) {
        lastMarker = name
      }
    }
  }
  if (lastMarker === null) return { phase: 'starting', fraction: 0, text: 'Starting' }
  if (lastMarker === 'building') return { phase: 'building', fraction: 0.05, text: 'Building both versions' }
  if (lastMarker === 'pictures') return { phase: 'pictures', fraction: 0.2, text: 'Taking settled pictures of both versions' }
  if (lastMarker === 'noise') return { phase: 'noise', fraction: 0.35, text: 'Measuring how much the old version differs from itself' }
  if (lastMarker === 'comparing') return { phase: 'comparing', fraction: 0.5, text: 'Comparing the regions' }
  if (lastMarker === 'recording') return { phase: 'recording', fraction: 0.95, text: 'Writing the report' }
  // searching needs range and step lines
  let n = null
  let left = null
  for (const raw of lines) {
    const m = RANGE_RE.exec(String(raw ?? ''))
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      n = Number(m[3])
      left = b - a
    }
  }
  let steps = 0
  for (const raw of lines) {
    if (String(raw ?? '').startsWith('bisect step ')) steps += 1
  }
  if (n === null) {
    return { phase: 'searching', fraction: 0.55, text: 'Searching for the first change' }
  }
  const nn = Math.max(2, n)
  const lleft = Math.max(1, left)
  const progress = 1 - Math.log2(lleft) / Math.log2(nn)
  const fraction = 0.55 + 0.35 * progress
  return { phase: 'searching', fraction, text: `Searching ${n} code changes: step ${steps + 1}, ${left} still possible` }
}

/** Summarise a running check from its output lines (oldest first). */
export function visualProgress(lines) {
  const list = Array.isArray(lines) ? lines.map(v => String(v ?? '')) : []
  // find the last override line (case or failure)
  let lastKind = null
  let lastText = null
  for (const line of list) {
    if (line.startsWith('case ')) {
      lastKind = 'done'
      lastText = line
    } else if (line.startsWith('bisect failed:') || line.startsWith('could not') || line.startsWith('usage:')) {
      lastKind = 'failed'
      lastText = line
    }
  }
  const base = baseProgress(list)
  if (lastKind === 'done') {
    return { phase: 'done', fraction: 1, text: 'Finished' }
  }
  if (lastKind === 'failed') {
    return { phase: 'failed', fraction: base.fraction, text: String(lastText).slice(0, 160) }
  }
  return base
}

/** The id from the last line of the form `case <id>`, otherwise null. */
export function caseIdOf(lines) {
  if (!Array.isArray(lines)) return null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] ?? '').trim()
    const m = /^case ([\w.-]+)$/.exec(line)
    if (m) return m[1]
  }
  return null
}
