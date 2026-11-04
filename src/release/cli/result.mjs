// The `behique check` command's result: what a check concluded, in one object, as Markdown for a person or a pull request,
// and as an exit code for CI. Pure: it reads the dashboard's own view-model of the evidence case and nothing else.
//   node --test src/release/cli/result.test.mjs
import { REF } from '../runparams.mjs'

export const EXIT = { ship: 0, hold: 1, inconclusive: 2, fail: 3, running: 3 }
const WORD = { ship: 'SHIP', hold: 'HOLD', inconclusive: 'REVIEW', fail: 'FAIL', running: 'RUNNING' }
const APP_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const CASE_RE = /^[0-9TZ]{16}_[A-Za-z0-9._\-/]+-vs-[A-Za-z0-9._\-/]+$/

/** `behique check <app> <good> <cand> [options]` argv (after the subcommand) to { ok, app, good, cand, options } or { ok: false, error }. */
export function parseCheckArgs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : []
  const flags = new Set(['--bisect', '--recrawl', '--json', '--no-dashboard', '--explain', '--ai', '--ai-tests', '--ai-flows', '--ai-describe', '--ai-triage', '--ai-canvas'])
  const withValue = new Set(['--max-findings', '--profile', '--repo', '--out', '--timeout-min', '--dashboard', '--ai-budget'])
  const camel = a => a.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
  const pos = [], options = { bisect: false, recrawl: false, explain: false, ai: false, aiTests: false, aiFlows: false, aiDescribe: false, aiTriage: false, aiCanvas: false, aiBudget: 0.25, maxFindings: 5, profile: null, repo: null, out: null, timeoutMin: 45, dashboard: 'http://127.0.0.1:8790', json: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (flags.has(a)) { if (a === '--no-dashboard') options.dashboard = null; else options[a === '--json' ? 'json' : camel(a)] = true; continue }
    if (withValue.has(a)) {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) return { ok: false, error: `${a} needs a value.` }
      i++
      if (a === '--max-findings' || a === '--timeout-min') {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1 || n > (a === '--max-findings' ? 20 : 600)) return { ok: false, error: `${a} must be a whole number${a === '--max-findings' ? ' from 1 to 20' : ' of minutes from 1 to 600'}.` }
        options[a === '--max-findings' ? 'maxFindings' : 'timeoutMin'] = n
      } else if (a === '--ai-budget') {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0 || n > 10) return { ok: false, error: '--ai-budget must be an amount in US dollars above 0 and at most 10.' }
        options.aiBudget = n
      } else if (a === '--dashboard') {
        if (!/^https?:\/\/[^\s/]+$/.test(v)) return { ok: false, error: '--dashboard must be an origin such as http://127.0.0.1:8790.' }
        options.dashboard = v
      } else options[a.slice(2)] = v
      continue
    }
    if (a.startsWith('--')) return { ok: false, error: `Unknown option ${a}.` }
    pos.push(a)
  }
  const [app, good, cand] = pos
  if (pos.length !== 3) return { ok: false, error: 'Usage: behique check <app> <good> <cand> [--bisect [--explain]] [--ai | --ai-tests --ai-flows --ai-describe --ai-triage --ai-canvas] [--ai-budget 0.25] [--max-findings 5] [--recrawl] [--profile file.json --repo path] [--out file] [--json]' }
  if (!APP_RE.test(app)) return { ok: false, error: 'The app name must be lower-case letters, digits and dashes.' }
  for (const r of [good, cand]) if (!REF.test(r)) return { ok: false, error: `"${r.slice(0, 30)}" is not a git tag, branch or commit name.` }
  if (good === cand) return { ok: false, error: 'The good and candidate versions are the same.' }
  if (options.explain && !options.bisect) return { ok: false, error: '--explain needs --bisect: the model explains the first change that makes the test fail.' }
  if (options.profile && !options.repo) return { ok: false, error: '--profile needs --repo <path to the checked-out repository>.' }
  return { ok: true, app, good, cand, options }
}

/** The case id a check printed (`evidence: <id>`), the last one if several, or null. */
export function caseIdFrom(lines) {
  const found = (Array.isArray(lines) ? lines : []).map(l => String(l).match(/^evidence: (\S+)$/)).filter(Boolean).at(-1)
  return found && CASE_RE.test(found[1]) ? found[1] : null
}

/** One object from the dashboard's view-model of a case. `dashboard` is the dashboard's origin, or null for no links. */
export function resultOf(vm, { caseId, dashboard = null } = {}) {
  if (!vm || typeof vm !== 'object') throw new Error('a view-model is required')
  const rec = vm.recommendation ?? vm.verdict ?? 'fail'
  const findings = (vm.findings ?? []).map(f => ({ id: f.id, cls: f.cls, label: f.label, why: f.why, where: f.where, what: f.what, was: f.was, now: f.now, step: f.step, verdict: f.verdict }))
  const confirmed = findings.filter(f => f.verdict === 'confirmed')
  const counts = { findings: findings.length, confirmed: confirmed.length, visible: confirmed.filter(f => f.cls === 'visible').length, churn: confirmed.filter(f => f.cls === 'churn').length }
  const c = vm.bisect?.commit ?? null
  const guess = (vm.claims ?? []).filter(k => k.kind === 'ai_hypothesis' && k.model).at(-1) ?? null // the newest model guess on the case, if one was asked for
  const q = s => encodeURIComponent(String(s))
  return {
    app: vm.app, good: vm.goodRef, cand: vm.candRef, caseId,
    recommendation: rec, word: WORD[rec] ?? String(rec).toUpperCase(), summary: vm.sub ?? '', failReason: vm.failReason ?? null,
    counts, findings, masked: vm.masked?.text ?? null,
    culprit: c ? { sha: c.sha, subject: c.subject, author: c.author, date: c.date, url: c.url ?? null } : null,
    explanation: guess ? { label: 'ai_hypothesis', model: guess.model, hypothesis: guess.text, quote: guess.quote ?? null, quoteFound: guess.grounded === true, confidence: guess.confidence ?? null, howToCheck: guess.howToCheck ?? null, estUsd: guess.estUsd ?? null } : null,
    bisect: vm.bisect ? { changes: vm.bisect.changes, steps: vm.bisect.steps, verified: vm.bisect.verifiedText ?? null } : null,
    report: dashboard ? { dashboard: `${dashboard}/dashboard?app=${q(vm.appId ?? vm.app)}&case=${q(caseId)}`, full: `${dashboard}/report?case=${q(caseId)}` } : null,
    chainOk: vm.chain?.ok ?? null,
    exitCode: EXIT[rec] ?? 3,
  }
}

export function exitCodeOf(result) {
  return EXIT[result?.recommendation] ?? 3
}

const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 120)
const para = (v, n = 900) => String(v ?? '').replace(/\r?\n/g, ' ').slice(0, n) // model text: a paragraph, longer than a table cell
const code = v => '`' + String(v ?? '').replace(/`/g, "'").replace(/\r?\n/g, ' ').slice(0, 80) + '`'

const hasAi = r => Boolean(r.explanation) || Boolean(r.ai?.stages?.some(s => s.status === 'ran' || s.status === 'failed'))
// Model text goes into a pull request comment: no HTML, no @mentions (GitHub would notify the person), one paragraph.
const safe = (v, n = 600) => String(v ?? '').replace(/\r?\n/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@(?=\w)/g, '@\u200b').replace(/`/g, "'").slice(0, n)
const usd = n => '$' + Number(n || 0).toFixed(4)

/**
 * The "AI guesses" part of the Markdown: [heading and cost line, ...one block per stage that ran, notes on stages that did not].
 * Empty when no AI flag was used. Nothing in it is read by the verdict or the exit code.
 */
export function aiSection(r) {
  const ai = r.ai
  if (!ai || !Array.isArray(ai.stages) || !ai.stages.length) return []
  const ran = ai.stages.filter(s => s.status === 'ran' || s.status === 'failed')
  const head = [`### AI guesses (a model wrote these; none of it changes the verdict or the exit code)`,
    `${ran.length ? `Total cost about ${usd(ai.totalUsd)} (estimate at an unverified price; budget ${usd(ai.budgetUsd)}).` : 'No model was called.'} Each item says which model wrote it and what code was able to check about it. "Unverified" means only a person can judge it.`].join('\n')
  const blocks = []
  for (const s of ai.stages) {
    if (s.status === 'skipped') { blocks.push(`- ${safe(s.title, 80)}: skipped, ${safe(s.reason, 200)}.`); continue }
    if (s.status === 'ran' && !(s.calls ?? []).length && !(s.items ?? []).length) { blocks.push(`- ${safe(s.title, 80)}: nothing to do, no model call was made${(s.notes ?? []).length ? ` (${(s.notes ?? []).map(n => safe(n, 160)).join('; ')})` : ''}.`); continue }
    const model = s.calls?.[0]?.model ?? 'no model call'
    const lines = [`**${safe(s.title, 80)}** (AI guess; ${safe(model, 60)}; ${s.calls?.length ?? 0} call${s.calls?.length === 1 ? '' : 's'}, about ${usd(s.spentUsd)} for the stage)`]
    if (s.status === 'failed') lines.push(`- This stage failed: ${safe(s.reason, 200)}.`)
    for (const it of s.items ?? []) lines.push(`- ${safe(it.text)} (${safe(model, 60)}; ${usd(s.spentUsd)} for the stage, ${s.items.length === 1 ? 'the only item of this stage' : `shared by its ${s.items.length} items`}; ${safe(it.status, 40)}${it.detail ? `: ${safe(it.detail, 240)}` : ''})`)
    if (s.status === 'ran' && !(s.items ?? []).length) lines.push('- The model offered nothing that survived the checks.')
    for (const n of s.notes ?? []) lines.push(`  - Note: ${safe(n, 300)}`)
    blocks.push(lines.join('\n'))
  }
  return [head, ...blocks.length ? [blocks.join('\n\n')] : []]
}

/** GitHub-flavoured Markdown for a pull request comment or a terminal. Findings most noticeable first, as the result lists them. */
export function markdownOf(r) {
  const lines = []
  lines.push(`## Behique recommends ${r.word}: ${r.app} ${r.good} (good) vs ${r.cand} (candidate)`)
  lines.push('')
  lines.push(r.summary ? r.summary + '.' : '')
  if (r.failReason) lines.push('', r.failReason)
  if (r.findings.length) {
    lines.push('', '| # | Would a person notice? | What | Where | Good | Candidate | Verdict |', '|---|---|---|---|---|---|---|')
    for (const f of r.findings) lines.push(`| ${f.id} | ${cell(f.label ?? 'unclassified')}${f.why ? ` (${cell(f.why)})` : ''} | ${cell(f.what)} | ${code(f.where)} | ${code(f.was)} | ${code(f.now)} | ${cell(String(f.verdict).replace(/_/g, ' '))} |`)
    lines.push('', '"Confirmed" means the test passed every run on the good version and failed every run on the candidate, each run on a fresh build.')
  }
  if (r.culprit) lines.push('', `**First change that makes the test fail:** ${r.culprit.url ? `[${r.culprit.sha.slice(0, 7)}](${r.culprit.url})` : r.culprit.sha.slice(0, 7)} ${cell(r.culprit.subject)} (${cell(r.culprit.author)}, ${cell(r.culprit.date)})${r.bisect ? `, ${r.bisect.changes} commits bisected in ${r.bisect.steps} steps${r.bisect.verified ? `, ${r.bisect.verified}` : ''}` : ''}.`)
  const ai = aiSection(r)
  if (ai.length) lines.push('', ...ai.slice(0, 1))
  if (r.explanation) {
    const e = r.explanation
    lines.push('', `**AI guess, not proof** (${cell(e.model)}${e.confidence ? `, ${cell(e.confidence)} confidence` : ''}; asked about the change above only): ${para(e.hypothesis)}`)
    if (e.quote) lines.push('', `It rests on this line of the change, which ${e.quoteFound ? 'is' : '**is NOT**'} in the diff: ${code(e.quote)}`)
    if (e.howToCheck) lines.push('', `To check it: ${para(e.howToCheck)}`)
    if (typeof e.estUsd === 'number') lines.push('', `One model call, about $${e.estUsd.toFixed(4)} (estimated).`)
  }
  else if (r.explanationSkipped) lines.push('', `No AI explanation was added: ${para(r.explanationSkipped, 200)}`)
  if (ai.length > 1) lines.push('', ...ai.slice(1))
  if (r.masked) lines.push('', `**Not seen by this check:** ${r.masked}`)
  if (r.report) lines.push('', `Report: [dashboard](${r.report.dashboard}) · [full report](${r.report.full}) · case \`${r.caseId}\``)
  else lines.push('', `Case \`${r.caseId}\` in out/evidence.`)
  lines.push('', r.ai?.stages?.some(s => s.status === 'ran' || s.status === 'failed') ? 'The verdict and every finding above are tests that ran; everything under "AI guesses" is the only part a model wrote, and it proves nothing. A person decides.' : r.explanation ? 'The verdict and every finding above are tests that ran; the AI guess is the only part a model wrote, and it proves nothing. A person decides.' : 'A model proposes nothing here: every claim is a test that ran. A person decides.')
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n'
}
