// What the dashboard shows about the AI stages of one saved case: read only, from the `ai.stage` events and the
// `ai-<stage>.json` artifacts that src/release/cli/ai-stages.mjs files. Nothing here calls a model or changes a case.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCase } from '../evidence.mjs'
import { normalizeItem, STAGES } from '../cli/ai-stages.mjs'

const round = n => Math.round(n * 1e6) / 1e6

/** The stages a person can ask for, in order, with a one-line plain description each. */
export const STAGE_INFO = [
  { id: 'tests', title: 'AI-written regression tests', what: 'Spark writes a readable test for each proven difference. Code keeps it only if it passes on the good version and fails on the candidate, every run.', needsApp: true },
  { id: 'flows', title: 'AI-proposed click paths', what: 'Spark proposes multi-step flows the crawler cannot find. Code replays each three times on the good version and keeps the steady ones.', needsApp: true },
  { id: 'describe', title: 'AI description of the pictures', what: 'Spark says what changed between the good and candidate pictures. Code checks every claim against the changed pixels.', needsApp: false },
  { id: 'triage', title: 'AI ranking of unproven differences', what: 'Spark ranks the differences no test could reproduce by how likely a person is to care. It never changes the verdict.', needsApp: false },
  { id: 'canvas', title: 'AI-listed canvas controls, clicked by code', what: 'Spark lists the controls in a screenshot of a canvas app. Code clicks them on both versions and reports steady differences. Public repositories only.', needsApp: true, alone: true },
].map(s => ({ ...s, title: STAGES.find(x => x.id === s.id)?.title ?? s.title }))

/**
 * Every AI stage filed in a case, newest run of each stage. Resolves
 * { label, stages: [{ id, title, status, reason, verified, total, calls, estUsd, items: [{ text, status, detail }], notes }], totalUsd }.
 */
export function aiView(dir) {
  const events = openCase(dir).read()
  const latest = new Map()
  for (const e of events) if (e.type === 'ai.stage' && e.data?.stage) latest.set(e.data.stage, e.data)
  const stages = []
  for (const info of STAGE_INFO) {
    const d = latest.get(info.id)
    if (!d) continue
    const art = readArtifact(dir, d.evidence?.[0])
    const raw = Array.isArray(art?.items) ? art.items : []
    // an AI-written test keeps its source and id so the dashboard can show, copy and download it
    const items = raw.map(it => ({ ...normalizeItem(info.id, it), ...(typeof it?.testSource === 'string' ? { id: String(it.id ?? it.findingId ?? ''), source: it.testSource.slice(0, 40000) } : {}) }))
    stages.push({
      id: info.id, title: info.title, status: d.status ?? 'ran', reason: d.reason ?? null,
      verified: Number(d.verified ?? items.filter(i => i.status === 'verified').length), total: Number(d.items ?? items.length),
      calls: Number(d.calls ?? 0), estUsd: round(Number(d.estUsd ?? 0)),
      items, notes: Array.isArray(art?.notes) ? art.notes.map(String).slice(0, 8) : [],
    })
  }
  return { label: 'ai_hypothesis', stages, totalUsd: round(stages.reduce((s, r) => s + r.estUsd, 0)) }
}

function readArtifact(dir, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) return null
  const p = join(dir, 'artifacts', hash)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * The command line for one run of the stages on a saved case, or an error. Only known stage ids become flags, the budget is a
 * number in a fixed range, and the case id is a plain name, so nothing a page sends can become another argument.
 */
export function aiRunArgv({ id, stages, explain = false, budget } = {}) {
  if (!/^[0-9TZ]{16}_[A-Za-z0-9._-]+$/.test(String(id ?? '')) || String(id).includes('..')) return { error: 'Choose a report first.' }
  const ids = [...new Set(Array.isArray(stages) ? stages : [])]
  if (ids.some(s => !STAGE_INFO.some(i => i.id === s))) return { error: 'Unknown AI stage.' }
  if (!ids.length && !explain) return { error: 'Pick at least one thing to ask for.' }
  const b = budget === undefined || budget === null || budget === '' ? 0.25 : Number(budget)
  if (!Number.isFinite(b) || b < 0.01 || b > 2) return { error: 'The spending cap must be between $0.01 and $2.00.' }
  const flags = ids.map(s => `--ai-${s}`)
  return { argv: ['bin/behique.mjs', 'ai', id, ...(explain ? ['--explain'] : []), ...flags, '--ai-budget', String(b)], budget: b, stages: ids }
}
