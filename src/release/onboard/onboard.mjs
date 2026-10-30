// node src/release/onboard/onboard.mjs <repoPath> --name <app> --good <ref> --cand <ref> [--profile file.json] [--propose] [--dry-run] [--approve] [--max-cost 0.3] [--ports 8301,8302]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { inspectRepo as realInspect } from './inspect.mjs'
import { proposeProfile as realPropose, buildMessages, projectCost } from './propose.mjs'
import { verifyProfile as realVerify } from './verify.mjs'
import { validateProfile, describeCommands as realDescribe, saveProfile as realSave } from './profile.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_PATH = join(HERE, '..', '..', '..', 'docs', 'skills', 'onboard-app.md')

function defaultSkillText() {
  try {
    return readFileSync(join(HERE, '../../../docs/skills/onboard-app.md'), 'utf8')
  } catch {
    try {
      return readFileSync(SKILL_PATH, 'utf8')
    } catch {
      return ''
    }
  }
}

function defaultWriteFile(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

async function defaultAsk(messages) {
  const { chat } = await import('../../llm.mjs')
  const res = await chat('meta', messages, { maxTokens: 4000, reasoning: 'low' })
  return {
    text: String(res.text ?? res.content ?? res.message ?? ''),
    pt: Number(res.pt ?? res.promptTokens ?? res.usage?.pt ?? 0),
    ct: Number(res.ct ?? res.completionTokens ?? res.usage?.ct ?? 0),
  }
}

const USAGE = 'usage: node src/release/onboard/onboard.mjs <repoPath> --name <app> --good <ref> --cand <ref> [--profile file.json] [--propose] [--dry-run] [--approve] [--max-cost 0.3] [--ports 8301,8302]'

function normPorts(v) {
  if (Array.isArray(v)) return v.map(Number)
  if (typeof v === 'string') return v.split(',').map((s) => Number(s.trim()))
  return [8301, 8302]
}

function normOptions(options = {}) {
  const o = { ...options }
  const repoPath = o.repoPath ?? o.repo ?? o.path ?? (Array.isArray(o._) ? o._[0] : undefined)
  const name = o.name
  const good = o.good
  const cand = o.cand ?? o.candidate
  const profileFile = o.profile ?? o.profileFile ?? o.profilePath ?? null
  const propose = Boolean(o.propose)
  const dryRun = Boolean(o.dryRun ?? o['dry-run'] ?? o.dryrun)
  const approve = Boolean(o.approve)
  const maxCost = Number(o.maxCost ?? o['max-cost'] ?? o.max_cost ?? 0.3)
  const ports = normPorts(o.ports ?? [8301, 8302])
  return { repoPath, name, good, cand, profileFile, propose, dryRun, approve, maxCost, ports, raw: o }
}

function costOfUsage(pt, ct, priceIn = 1.25e-6, priceOut = 4.25e-6) {
  return Number(pt) * priceIn + Number(ct) * priceOut
}

export async function runOnboard(options, deps = {}) {
  const {
    inspectRepo = realInspect,
    proposeProfile = realPropose,
    verifyProfile = realVerify,
    saveProfile = realSave,
    describeCommands = realDescribe,
    ask = defaultAsk,
    skillText = defaultSkillText(),
    writeFile = defaultWriteFile,
    now = Date.now,
  } = deps
  const o = normOptions(options)
  const lines = []
  let profile = null
  let report = null

  if (!o.repoPath || !o.name || !o.good || !o.cand) {
    return { code: 2, lines: [USAGE], profile: null, report: null }
  }

  const facts = await inspectRepo(o.repoPath)
  {
    const tags = Array.isArray(facts.tags) ? facts.tags.slice(0, 5).join(', ') : ''
    lines.push(`repo: ${facts.path ?? o.repoPath} (git: ${facts.isGit ? 'yes' : 'no'})`)
    lines.push(`tags: ${tags || 'none'}`)
    lines.push(`index.html: ${facts.hasIndexHtml ? 'yes' : 'no'}`)
    const scripts = facts.packageJson && facts.packageJson.scripts ? Object.keys(facts.packageJson.scripts) : []
    lines.push(`scripts: ${scripts.length > 0 ? scripts.join(', ') : 'none'}`)
  }

  if (o.profileFile) {
    let raw
    try {
      raw = readFileSync(String(o.profileFile), 'utf8')
    } catch (err) {
      return { code: 2, lines: [...lines, `cannot read profile file: ${String((err && err.message) || err)}`], profile: null, report: null }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return { code: 2, lines: [...lines, `profile file is not valid JSON: ${String((err && err.message) || err)}`], profile: null, report: null }
    }
    const problems = validateProfile(parsed)
    if (problems.length > 0) {
      return { code: 2, lines: [...lines, ...problems.map((p) => `invalid profile: ${p}`)], profile: null, report: null }
    }
    profile = parsed
  } else if (o.propose) {
    const messages = buildMessages(facts, String(skillText), { good: o.good, cand: o.cand })
    const chars = messages.reduce((n, m) => n + String(m && m.content ? m.content : '').length, 0)
    const projected = projectCost(messages)
    if (o.dryRun) {
      lines.push(`projected cost $${projected.toFixed(4)} for ${chars} prompt characters`)
      void now
      return { code: 0, lines, profile: null, report: null }
    }
    if (projected > o.maxCost) {
      lines.push(`refused: projected cost $${projected.toFixed(4)} is above --max-cost $${Number(o.maxCost).toFixed(4)}`)
      return { code: 2, lines, profile: null, report: null }
    }
    const res = await proposeProfile({ facts, skillText: String(skillText), ask, good: o.good, cand: o.cand })
    const pt = Number(res.usage?.pt ?? 0)
    const ct = Number(res.usage?.ct ?? 0)
    const cost = costOfUsage(pt, ct)
    lines.push(`proposal cost $${cost.toFixed(4)} (prompt ${pt}, completion ${ct})`)
    if (res.problems && res.problems.length > 0) {
      for (const p of res.problems) lines.push(`proposal problem: ${p}`)
      if (res.profile) {
        const forced = { ...res.profile, name: o.name }
        try { writeFile(join('out', 'onboard', `${o.name}.proposed.json`), JSON.stringify(forced, null, 2) + '\n') } catch {}
      }
      return { code: 1, lines, profile: null, report: null }
    }
    profile = res.profile
  } else {
    return { code: 2, lines: [...lines, USAGE], profile: null, report: null }
  }

  profile = { ...profile, name: o.name }
  try {
    writeFile(join('out', 'onboard', `${o.name}.proposed.json`), JSON.stringify(profile, null, 2) + '\n')
  } catch (err) {
    lines.push(`note: could not write proposal file: ${String((err && err.message) || err)}`)
  }

  lines.push('Commands this profile would run:')
  for (const c of describeCommands(profile)) lines.push(`  ${c}`)

  if (!o.approve) {
    lines.push('Review the profile above, then run again with --approve to build and verify it.')
    return { code: 0, lines, profile, report: null }
  }

  report = await verifyProfile(profile, { good: o.good, cand: o.cand, ports: o.ports })
  for (const c of report.checks) lines.push(`${c.ok ? 'ok' : 'FAILED'} ${c.name}: ${c.detail}`)
  if (report.floor) lines.push(`floor: ${JSON.stringify(report.floor)}`)
  if (report.ok) {
    const saved = saveProfile(profile)
    lines.push(`saved profile to ${saved}`)
    return { code: 0, lines, profile, report }
  }
  lines.push('profile was not saved (verification failed)')
  return { code: 1, lines, profile, report }
}

function parseArgv(argv) {
  const options = { _ : [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') options.name = argv[++i]
    else if (a.startsWith('--name=')) options.name = a.slice(7)
    else if (a === '--good') options.good = argv[++i]
    else if (a.startsWith('--good=')) options.good = a.slice(7)
    else if (a === '--cand') options.cand = argv[++i]
    else if (a.startsWith('--cand=')) options.cand = a.slice(7)
    else if (a === '--profile') options.profile = argv[++i]
    else if (a.startsWith('--profile=')) options.profile = a.slice(10)
    else if (a === '--propose') options.propose = true
    else if (a === '--dry-run') options.dryRun = true
    else if (a === '--approve') options.approve = true
    else if (a === '--max-cost') options.maxCost = Number(argv[++i])
    else if (a.startsWith('--max-cost=')) options.maxCost = Number(a.slice(11))
    else if (a === '--ports') options.ports = argv[++i]
    else if (a.startsWith('--ports=')) options.ports = a.slice(8)
    else if (a.startsWith('--')) {}
    else options._.push(a)
  }
  if (options._.length > 0) options.repoPath = options._[0]
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgv(process.argv.slice(2))
  const res = await runOnboard(options)
  for (const line of res.lines) console.log(line)
  process.exitCode = res.code
}
