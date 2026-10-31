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
  const flags = new Set(['--bisect', '--recrawl', '--json', '--no-dashboard'])
  const withValue = new Set(['--max-findings', '--profile', '--repo', '--out', '--timeout-min', '--dashboard'])
  const pos = [], options = { bisect: false, recrawl: false, maxFindings: 5, profile: null, repo: null, out: null, timeoutMin: 45, dashboard: 'http://127.0.0.1:8790', json: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (flags.has(a)) { if (a === '--no-dashboard') options.dashboard = null; else options[a === '--json' ? 'json' : a.slice(2)] = true; continue }
    if (withValue.has(a)) {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) return { ok: false, error: `${a} needs a value.` }
      i++
      if (a === '--max-findings' || a === '--timeout-min') {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1 || n > (a === '--max-findings' ? 20 : 600)) return { ok: false, error: `${a} must be a whole number${a === '--max-findings' ? ' from 1 to 20' : ' of minutes from 1 to 600'}.` }
        options[a === '--max-findings' ? 'maxFindings' : 'timeoutMin'] = n
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
  if (pos.length !== 3) return { ok: false, error: 'Usage: behique check <app> <good> <cand> [--bisect] [--max-findings 5] [--recrawl] [--profile file.json --repo path] [--out file] [--json]' }
  if (!APP_RE.test(app)) return { ok: false, error: 'The app name must be lower-case letters, digits and dashes.' }
  for (const r of [good, cand]) if (!REF.test(r)) return { ok: false, error: `"${r.slice(0, 30)}" is not a git tag, branch or commit name.` }
  if (good === cand) return { ok: false, error: 'The good and candidate versions are the same.' }
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
  const q = s => encodeURIComponent(String(s))
  return {
    app: vm.app, good: vm.goodRef, cand: vm.candRef, caseId,
    recommendation: rec, word: WORD[rec] ?? String(rec).toUpperCase(), summary: vm.sub ?? '', failReason: vm.failReason ?? null,
    counts, findings, masked: vm.masked?.text ?? null,
    culprit: c ? { sha: c.sha, subject: c.subject, author: c.author, date: c.date, url: c.url ?? null } : null,
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
const code = v => '`' + String(v ?? '').replace(/`/g, "'").replace(/\r?\n/g, ' ').slice(0, 80) + '`'

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
  if (r.masked) lines.push('', `**Not seen by this check:** ${r.masked}`)
  if (r.report) lines.push('', `Report: [dashboard](${r.report.dashboard}) · [full report](${r.report.full}) · case \`${r.caseId}\``)
  else lines.push('', `Case \`${r.caseId}\` in out/evidence.`)
  lines.push('', 'A model proposes nothing here: every claim is a test that ran. A person decides.')
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n'
}
