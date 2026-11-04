// The AI stages of `behique check`: up to four optional modules that ask a model for help AFTER the verdict has been computed.
// A model proposes, code verifies, a person approves. Nothing here can change the verdict or the exit code: the stages run
// against the finished evidence case, their output is a separate list labelled an AI guess, and the result's recommendation and
// exit code are taken before they run (see bin/behique.mjs and ai-stages.test.mjs).
//
//   tests     src/release/aitest.mjs               a model writes extra tests; code runs them on both versions
//   flows     src/release/crawl/propose-flows.mjs  a model proposes click paths the crawl did not find
//   describe  src/release/visual/describe.mjs      a model describes what changed in the pictures; code checks the place
//   triage    src/release/triage.mjs               a model ranks the differences no test could prove
//
// Each module exports `async run({ caseDir, ask, maxUsd })` and resolves { label: 'ai_hypothesis', items, calls, spentUsd, notes }.
// A module that is absent (or broken) is skipped with a note, never a crash. Every call is recorded in the case as a `model.call`
// event, and the total spend of all stages is capped (`--ai-budget`, default US$0.25).
//   node --test src/release/cli/ai-stages.test.mjs
import { basename, dirname } from 'node:path'
import { anchor } from '../anchor.mjs'
import { openCase } from '../evidence.mjs'

export const DEFAULT_BUDGET_USD = 0.25
export const STAGES = [
  { id: 'tests', flag: 'aiTests', title: 'AI-written tests', path: '../aitest.mjs', file: 'src/release/aitest.mjs' },
  { id: 'flows', flag: 'aiFlows', title: 'AI-proposed click paths', path: '../crawl/propose-flows.mjs', file: 'src/release/crawl/propose-flows.mjs' },
  { id: 'describe', flag: 'aiDescribe', title: 'AI description of the pictures', path: '../visual/describe.mjs', file: 'src/release/visual/describe.mjs' },
  { id: 'triage', flag: 'aiTriage', title: 'AI ranking of unproven differences', path: '../triage.mjs', file: 'src/release/triage.mjs' },
  // not part of --ai: it screenshots the app to a model, so it is asked for by name, and it needs the app and both versions (context)
  { id: 'canvas', flag: 'aiCanvas', title: 'AI-listed canvas controls, clicked by code', path: './canvas-senses.mjs', file: 'src/release/cli/canvas-senses.mjs', alone: true },
]
const PRICE = { inPerTok: 1.25e-6, outPerTok: 4.25e-6 } // the project's estimate, same as src/llm.mjs (an unverified third-party price)
const usdOf = (pt, ct) => pt * PRICE.inPerTok + ct * PRICE.outPerTok
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d

/** Which stages the options ask for. `--ai` is all four; the single flags add one each. */
export function selectedStages(options = {}) {
  return STAGES.filter(s => (options.ai && !s.alone) || options[s.flag]).map(s => s.id)
}

/** The default `ask`: Meta Muse Spark through the one client. Resolves the superset of shapes the modules read. */
export async function defaultAsk(messages, { reasoning = 'low', maxTokens = 4000 } = {}) {
  const { chat, PROVIDERS, ENV } = await import('../../llm.mjs')
  if (!ENV[PROVIDERS.meta.keyEnv]) throw new Error(`${PROVIDERS.meta.keyEnv} is empty (put it in .env)`)
  const r = await chat('meta', messages, { maxTokens, reasoning })
  return {
    text: r.text, model: PROVIDERS.meta.model, provider: 'meta', pt: r.pt, ct: r.ct, rt: r.rt, ms: r.ms, finish: r.finish,
    usage: { promptTokens: r.pt, completionTokens: r.ct, reasoningTokens: r.rt, ms: r.ms, finish: r.finish, model: PROVIDERS.meta.model, provider: 'meta' },
  }
}

/** Whether a Meta key is available, without reading its value anywhere it could be printed. */
export async function keyPresent() {
  const { ENV, PROVIDERS } = await import('../../llm.mjs')
  return Boolean(ENV[PROVIDERS.meta.keyEnv])
}

const FIELDS = ['description', 'hypothesis', 'reason', 'title', 'text', 'summary', 'name', 'claim', 'idea']
const short = (v, n = 600) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** One module item as a plain, uniform row: what the model said, and what code was able to check about it. */
export function normalizeItem(stage, item) {
  if (item === null || typeof item !== 'object') return { text: short(item), status: 'unverified', detail: null }
  let text = ''
  for (const f of FIELDS) if (typeof item[f] === 'string' && item[f].trim()) { text = item[f]; break }
  if (stage === 'tests' && item.name) text = `${item.name}${item.reason ? `: ${item.reason}` : ''}`
  else if (stage === 'flows' && item.purpose) text = `${item.purpose}${Array.isArray(item.steps) ? ` (${item.steps.length} step${item.steps.length === 1 ? '' : 's'})` : ''}`
  if (!text && item.findingId) text = `difference ${item.findingId}${item.rank ? ` (rank ${item.rank})` : ''}${item.reason ? `: ${item.reason}` : ''}`
  if (!text) text = short(JSON.stringify(item), 300)
  else if (item.findingId && stage === 'triage') text = `${item.rank ? `${item.rank}. ` : ''}${item.findingId}: ${text}`
  let status = 'unverified', detail = null
  if (item.verified === true) { status = 'verified'; detail = stage === 'tests' && item.runs ? `passes ${item.runs.good?.passed}/${item.runs.good?.total} on the good version and fails ${item.runs.candidate?.failed}/${item.runs.candidate?.total} on the candidate, each run on a fresh build` : item.kindCheck ? `the described place changed above the noise floor in the pixels${item.kindCheck === 'unchecked' ? `; what kind of change (${item.kind ?? 'other'}) was not measured` : `; the pixels ${item.kindCheck} with "${item.kind ?? 'the kind of change'}"`}` : (item.verification ?? item.verifiedBy ?? null) }
  else if (item.verified === false) { status = 'not verified'; detail = item.droppedBecause ?? item.why ?? null }
  else if (typeof item.status === 'string') { status = item.status; detail = item.detail ?? null }
  else if (stage === 'flows' && item.replay) {
    if (item.plan && !item.droppedBecause) { status = 'replayed'; detail = `replayed ${item.replay.passed} of ${item.replay.runs} times on the good version with the same trace each time; it has not been run on the candidate` }
    else { status = 'not verified'; detail = item.droppedBecause ?? null }
  }
  else if (item.passed === true || item.passesOnGood === true) status = 'verified'
  return { text: short(text), status: short(status, 40), detail: detail ? short(detail, 240) : null }
}

/** Load one stage's module. Resolves { mod } or { skipped: reason }; an absent module and a broken one are both a skip. */
export async function loadStage(stage, load) {
  try {
    const mod = await load(stage)
    if (typeof mod?.run !== 'function') return { skipped: `${stage.file} does not export run()` }
    return { mod }
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(stage.path.replace(/^\.\.\//, '').replace(/\.mjs$/, ''))) return { skipped: `${stage.file} is not part of this build` }
    return { skipped: `${stage.file} could not be loaded (${short(e?.message ?? e, 120)})` }
  }
}

const defaultLoad = stage => import(new URL(stage.path, import.meta.url).href)

/**
 * Run the selected stages against a finished case. Never throws, never touches the verdict.
 *   caseDir        out/evidence/<case>/
 *   stages         ids to run (see selectedStages)
 *   budgetUsd      cap on the total spend of all stages (and `spentBeforeUsd`, e.g. an --explain call already made)
 *   ask            (messages, { reasoning, maxTokens }) => { text, usage, model, provider }; default Muse Spark
 *   load           (stage) => module; the test seam for fake modules
 *   context        { app, good, cand, prepare }: passed to the stages that need the app; prepare(stage) may resolve { extra, stop }
 *   record         write model.call events, the stage output and an ai.stage event into the case (default true)
 * Resolves { label, budgetUsd, spentUsd, totalUsd, stages: [{ id, title, status, reason, items, notes, calls, spentUsd }] }.
 */
export async function runAiStages({ caseDir, stages = [], budgetUsd = DEFAULT_BUDGET_USD, spentBeforeUsd = 0, ask = null, load = defaultLoad, record = true, log = () => {}, context = null } = {}) {
  const out = { label: 'ai_hypothesis', budgetUsd, spentUsd: 0, totalUsd: round(spentBeforeUsd), stages: [] }
  if (!stages.length) return out
  const useDefault = !ask
  let keyOk = true
  if (useDefault) { try { keyOk = await keyPresent() } catch { keyOk = false } }
  let spent = spentBeforeUsd
  let c = null
  if (record) { try { c = openCase(caseDir) } catch { c = null } }
  const baseAsk = ask ?? defaultAsk
  for (const id of STAGES.map(s => s.id).filter(x => stages.includes(x))) {
    const stage = STAGES.find(s => s.id === id)
    const row = { id, title: stage.title, status: 'skipped', reason: null, items: [], notes: [], calls: [], spentUsd: 0 }
    out.stages.push(row)
    if (useDefault && !keyOk) { row.reason = 'No META_API_KEY is set, so nothing can be sent'; continue }
    if (spent >= budgetUsd) { row.reason = `the AI budget of $${budgetUsd.toFixed(2)} is used up (spent $${spent.toFixed(4)})`; continue }
    const loaded = await loadStage(stage, load)
    if (!loaded.mod) { row.reason = loaded.skipped; continue }
    // every call goes through here: the cap is checked before it is sent, and what it cost is counted from the reply itself
    const seen = []
    const counted = async (messages, opts) => {
      if (spent >= budgetUsd) throw new Error(`the AI budget of $${budgetUsd.toFixed(2)} is used up (spent $${spent.toFixed(4)})`)
      const t0 = Date.now()
      const r = await baseAsk(messages, opts)
      const u = r?.usage ?? {}
      const pt = num(u.promptTokens ?? u.pt ?? r?.pt), ct = num(u.completionTokens ?? u.ct ?? r?.ct)
      const usd = usdOf(pt, ct)
      spent += usd
      seen.push({ model: r?.model ?? u.model ?? 'muse-spark-1.3', provider: r?.provider ?? u.provider ?? 'meta', promptTokens: pt, completionTokens: ct, reasoningTokens: num(u.reasoningTokens ?? u.rt ?? r?.rt), ms: num(u.ms ?? r?.ms) || Date.now() - t0, finish: u.finish ?? r?.finish ?? null, usd: round(usd) })
      return r
    }
    log(`ai: ${stage.title} (${id})`)
    let result, prepared = null
    try {
      // a stage that needs the app (the good version running, the app's adapter) gets it from the caller; it is stopped afterwards
      prepared = context?.prepare ? await context.prepare(stage) : null
      result = await loaded.mod.run({ caseDir, ask: counted, maxUsd: Math.max(0, round(budgetUsd - spent)), record: false, ...(prepared?.extra ?? {}), ...(context ? { context: { ...context, log } } : {}) })
    }
    catch (e) { try { await prepared?.stop?.() } catch {} row.status = 'failed'; row.reason = short(e?.message ?? e, 200); row.calls = seen; row.spentUsd = round(seen.reduce((s, x) => s + x.usd, 0)); record && c && recordStage(c, row, null, seen); continue }
    try { await prepared?.stop?.() } catch {}
    // calls the module made through its own client (not through `counted`) are taken from what it reports
    const reported = Array.isArray(result?.calls) ? result.calls.map(k => ({ model: k.model ?? 'muse-spark-1.3', provider: k.provider ?? 'meta', promptTokens: num(k.promptTokens), completionTokens: num(k.completionTokens), reasoningTokens: num(k.reasoningTokens), ms: num(k.ms), finish: k.finish ?? null, usd: round(k.usd ?? usdOf(num(k.promptTokens), num(k.completionTokens))) })) : []
    if (!seen.length && reported.length) { for (const k of reported) spent += k.usd; seen.push(...reported) }
    row.status = 'ran'
    row.calls = seen
    row.spentUsd = round(seen.reduce((s, x) => s + x.usd, 0))
    row.items = (Array.isArray(result?.items) ? result.items : []).map(it => normalizeItem(id, it))
    row.notes = (Array.isArray(result?.notes) ? result.notes : []).map(n => short(n, 300))
    row.rawItems = Array.isArray(result?.items) ? result.items : []
    if (record && c) recordStage(c, row, result, seen)
    delete row.rawItems
  }
  if (record && c) { try { anchor(dirname(caseDir), basename(caseDir), c, { mirror: process.env.BEHIQUE_ANCHOR_MIRROR || null }) } catch {} } // the stages added lines after the check's own anchor: file the new head too
  out.spentUsd = round(out.stages.reduce((s, r) => s + r.spentUsd, 0))
  out.totalUsd = round(spentBeforeUsd + out.spentUsd)
  return out
}

/** File one stage in the case: a model.call event per call, the stage's output as evidence, one ai.stage event. */
function recordStage(c, row, result, calls) {
  try {
    for (const k of calls) c.event('model.call', { kind: row.id, provider: k.provider, model: k.model, promptTokens: k.promptTokens, completionTokens: k.completionTokens, reasoningTokens: k.reasoningTokens, estUsd: k.usd, ms: k.ms, finish: k.finish })
    const saved = c.artifact(`ai-${row.id}.json`, { label: 'ai_hypothesis', stage: row.id, items: row.rawItems ?? row.items, notes: row.notes, sent: result?.sent ?? null, unexplainedRegions: result?.unexplainedRegions ?? undefined }, 'application/json')
    c.event('ai.stage', { stage: row.id, label: 'ai_hypothesis', status: row.status, reason: row.reason, items: row.items.length, verified: row.items.filter(i => i.status === 'verified').length, calls: calls.length, estUsd: row.spentUsd, evidence: [saved] })
  } catch (e) { row.notes.push(`could not record this stage in the case: ${short(e?.message ?? e, 120)}`) }
}

/** The part of a result that an AI stage must never change. Used by the tests and by bin/behique.mjs to make that visible. */
export function verdictFingerprint(result) {
  return JSON.stringify({ recommendation: result.recommendation, word: result.word, exitCode: result.exitCode, summary: result.summary, counts: result.counts, findings: result.findings })
}
