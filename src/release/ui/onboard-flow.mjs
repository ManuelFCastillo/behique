// Set up an app from the dashboard, with a person approving each step.
// A model proposes, code verifies, a person approves.
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'

const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/
const APP_RE = /^[a-z0-9-]+$/
const STATIC_LINE = 'serve: built-in static file server'

function short(s, n = 30) {
  const t = String(s)
  return t.length > n ? t.slice(0, n) : t
}

function isRefOk(v) {
  if (typeof v !== 'string') return false
  if (v.length === 0 || v.length > 60) return false
  if (v.startsWith('-')) return false
  if (/\s/.test(v)) return false
  return true
}

export async function listCandidates({ appsRoot, readdir, isGitRepo, listProfiles }) {
  const entries = await readdir(appsRoot)
  const saved = await listProfiles()
  const have = new Set(Array.isArray(saved) ? saved : [])
  const out = []
  for (const name of entries) {
    if (typeof name !== 'string') continue
    if (name.startsWith('.')) continue
    if (name.startsWith('w-')) continue
    if (name === 'work') continue
    if (!ENTRY_RE.test(name)) continue
    const p = join(appsRoot, name)
    let git = false
    try {
      git = await isGitRepo(p)
    } catch {
      git = false
    }
    if (!git) continue
    out.push({ name, path: p, hasProfile: have.has(name) })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

export async function resolveRepo(appsRoot, name, { isGitRepo }) {
  if (typeof name !== 'string' || !ENTRY_RE.test(name)) {
    throw new Error(`invalid repository name "${short(name)}"`)
  }
  const root = resolve(String(appsRoot))
  const p = resolve(root, name)
  if (p !== join(root, name) && !(p.startsWith(root + sep))) {
    throw new Error(`invalid repository name "${short(name)}"`)
  }
  if (!p.startsWith(root + sep) && p !== root) {
    throw new Error(`invalid repository name "${short(name)}"`)
  }
  // name matched ENTRY_RE so no separators or .. can reach here, but double check containment
  const rel = p.slice(root.length)
  if (rel.includes('..')) throw new Error(`invalid repository name "${short(name)}"`)
  let git = false
  try {
    git = await isGitRepo(p)
  } catch {
    git = false
  }
  if (!git) throw new Error(`"${short(name)}" is not a repository`)
  return p
}

/**
 * The versions a cloned repository offers: its tags, its branch and its newest commits, plus a suggested pair.
 * Plain git reads, no model. A tag, a branch or a commit all work as a version: a build is identified by its
 * commit sha whatever name was given.
 */
export async function listRefs(input, deps) {
  const { repo } = input ?? {}
  const { appsRoot, isGitRepo, inspectRepo } = deps ?? {}
  let path, facts
  try { path = await resolveRepo(appsRoot, repo, { isGitRepo }) } catch (e) { return fail(404, e) }
  try { facts = await inspectRepo(path) } catch (e) { return fail(500, e) }
  const tags = Array.isArray(facts && facts.tags) ? facts.tags.slice(0, 10).map(String) : []
  const branch = facts && typeof facts.branch === 'string' ? facts.branch : null
  const recent = Array.isArray(facts && facts.recent)
    ? facts.recent.filter((c) => c && typeof c.sha === 'string').slice(0, 8).map((c) => ({ sha: c.sha, subject: String(c.subject ?? '') }))
    : []
  return { ok: true, repo, tags, branch, recent, suggest: suggestPair({ tags, branch, recent }) }
}

/** Old = the release before the newest tag; new = the newest tag. Without tags: old = the commit before HEAD, new = the branch. */
export function suggestPair({ tags = [], branch = null, recent = [] }) {
  if (tags.length >= 2) return { good: tags[1], cand: tags[0] }
  if (tags.length === 1) return { good: tags[0], cand: branch || (recent[0] && recent[0].sha) || null }
  if (recent.length >= 2) return { good: recent[1].sha, cand: branch || recent[0].sha }
  return { good: null, cand: null }
}

function fingerprintOf(messages, provider) {
  return createHash('sha256').update(String(provider) + '\n' + JSON.stringify(messages)).digest('hex').slice(0, 16)
}

const fail = (status, e) => ({ ok: false, status, error: String((e && e.message) || e) })

/** Everything both steps need: the validated request, the repository facts and the exact text that would be sent. */
async function prepare(input, deps) {
  const { repo, name, good, cand } = input ?? {}
  const { appsRoot, isGitRepo, listProfiles, inspectRepo, skillText, buildMessages, projectCost, provider = 'meta', keyPresent } = deps ?? {}
  if (typeof name !== 'string' || !APP_RE.test(name) || name.length > 40) return { ok: false, status: 400, error: `invalid app name "${short(name)}"` }
  if (!isRefOk(good)) return { ok: false, status: 400, error: 'invalid good ref' }
  if (!isRefOk(cand)) return { ok: false, status: 400, error: 'invalid cand ref' }
  let saved = []
  try { saved = await listProfiles() } catch (e) { return fail(500, e) }
  if (Array.isArray(saved) && saved.includes(name)) return { ok: false, status: 400, error: `profile "${short(name)}" already exists` }
  let path, facts, messages, usdExpected
  try { path = await resolveRepo(appsRoot, repo, { isGitRepo }) } catch (e) { return fail(404, e) }
  try { facts = await inspectRepo(path) } catch (e) { return fail(500, e) }
  try { messages = buildMessages(facts, skillText, { good, cand }) } catch (e) { return fail(500, e) }
  try { usdExpected = projectCost(messages) } catch (e) { return fail(500, e) }
  const tags = Array.isArray(facts && facts.tags) ? facts.tags.slice(0, 5) : []
  const sc = facts && facts.packageJson && facts.packageJson.scripts
  const scripts = sc && typeof sc === 'object' && !Array.isArray(sc) ? Object.keys(sc) : Array.isArray(sc) ? sc.map(String) : []
  const canSend = Boolean(keyPresent)
  return {
    ok: true, canSend, reason: canSend ? null : `No API key is set for ${provider}, so nothing can be sent.`, provider, model: 'muse-spark-1.3',
    sent: messages, usdExpected, confirm: fingerprintOf(messages, provider),
    facts: { path: (facts && facts.path) || path, isGit: Boolean(facts && facts.isGit), hasIndexHtml: Boolean(facts && facts.hasIndexHtml), tags, scripts },
    raw: facts, // the full facts, for the propose step; never returned to a caller
  }
}

export async function onboardPreview(input, deps) {
  try {
    const { raw, ...preview } = await prepare(input, deps)
    return preview
  } catch (e) {
    return fail(500, e)
  }
}

export async function onboardPropose(input, deps) {
  try {
    const { confirm, name, good, cand } = input ?? {}
    const { ask, proposeProfile, describeCommands, writeFile, maxCost = 0.3 } = deps ?? {}
    const prev = await prepare(input, deps)
    if (!prev.ok) return { ok: false, status: prev.status, error: prev.error }
    if (!prev.canSend) return { ok: false, status: 400, error: prev.reason || 'cannot send' }
    if (typeof confirm !== 'string' || confirm !== prev.confirm) {
      return { ok: false, status: 409, stale: true, error: 'What would be sent has changed, or was not reviewed. Review it again before sending.' }
    }
    if (typeof prev.usdExpected === 'number' && prev.usdExpected > maxCost) {
      return { ok: false, status: 400, error: `projected cost $${prev.usdExpected.toFixed(4)} is above the limit $${Number(maxCost).toFixed(4)}` }
    }
    // The text the person confirmed is the only text that may leave: checked at the moment of sending, not assumed.
    const checkedAsk = async messages => {
      if (fingerprintOf(messages, prev.provider) !== prev.confirm) throw new Error('What would be sent differs from what was reviewed, so nothing was sent.')
      return ask(messages)
    }
    let out
    try { out = await proposeProfile({ facts: prev.raw, skillText: deps.skillText, ask: checkedAsk, good, cand }) } catch (e) { return fail(502, e) }
    const problems = (out && out.problems) || []
    const usage = (out && out.usage) || { pt: 0, ct: 0 }
    if (!out || out.profile === null || out.profile === undefined) {
      return { ok: false, status: 502, error: problems.length > 0 ? problems.join('; ') : 'the model returned no profile', problems }
    }
    const profile = { ...out.profile, name } // the name is the person's, never the model's
    let commands
    try { commands = describeCommands(profile) } catch (e) { return fail(500, e) }
    const needsApproval = Array.isArray(commands) && commands.some(c => c !== STATIC_LINE)
    const usd = Number(usage.pt ?? 0) * 1.25e-6 + Number(usage.ct ?? 0) * 4.25e-6
    const proposed = join('out', 'onboard', name + '.proposed.json')
    try { await writeFile(proposed, JSON.stringify(profile, null, 2) + '\n') } catch (e) { return fail(500, e) }
    return { ok: true, profile, problems, usage, usd, commands, needsApproval, proposed }
  } catch (e) {
    return fail(500, e)
  }
}

export async function onboardVerify(input, deps) {
  try {
    const { name, good, cand, approveCommands } = input ?? {}
    const { readFile, describeCommands, validateProfile, verifyProfile, saveProfile, listProfiles, ports = [8301, 8302], log } = deps ?? {}
    if (typeof name !== 'string' || !APP_RE.test(name) || name.length > 40) {
      return { ok: false, status: 400, error: `invalid app name "${short(name)}"` }
    }
    const file = join('out', 'onboard', name + '.proposed.json')
    let raw
    try {
      raw = await readFile(file)
    } catch (e) {
      return { ok: false, status: 404, error: String((e && e.message) || e) }
    }
    let profile
    try {
      profile = JSON.parse(String(raw))
    } catch (e) {
      return { ok: false, status: 400, error: String((e && e.message) || e) }
    }
    if (!profile || profile.name !== name) { // an edited file must not save itself over another app's profile
      return { ok: false, status: 400, error: 'The proposal is named for a different app than the one being set up.' }
    }
    if (typeof listProfiles === 'function') {
      let saved = []
      try { saved = await listProfiles() } catch (e) { return { ok: false, status: 500, error: String((e && e.message) || e) } }
      if (Array.isArray(saved) && saved.includes(name)) return { ok: false, status: 400, error: `profile "${short(name)}" already exists` }
    }
    let problems
    try {
      problems = await validateProfile(profile)
    } catch (e) {
      return { ok: false, status: 500, error: String((e && e.message) || e) }
    }
    if (Array.isArray(problems) && problems.length > 0) {
      return { ok: false, status: 400, error: problems.join('; '), problems }
    }
    let commands
    try {
      commands = await describeCommands(profile)
    } catch (e) {
      return { ok: false, status: 500, error: String((e && e.message) || e) }
    }
    const needs = Array.isArray(commands) && commands.some((c) => c !== STATIC_LINE)
    if (needs && approveCommands !== true) {
      return { ok: false, status: 400, needsApproval: true, commands, error: 'These commands run on this machine. Approve them first.' }
    }
    let report
    try {
      report = await verifyProfile(profile, { good, cand, ports, log })
    } catch (e) {
      return { ok: false, status: 500, error: String((e && e.message) || e) }
    }
    const checks = (report && report.checks) || []
    if (report && report.ok === true) {
      let saved
      try {
        saved = await saveProfile(profile)
      } catch (e) {
        return { ok: false, status: 500, error: String((e && e.message) || e) }
      }
      return { ok: true, checks, saved: true, path: saved }
    }
    return { ok: false, status: 422, checks, saved: false }
  } catch (e) {
    return { ok: false, status: 500, error: String((e && e.message) || e) }
  }
}
