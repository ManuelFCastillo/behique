// Run a full release check on many apps and keep one table of what happened.
// Pure logic: the runner that starts `node` and the cleanup are injected, so tests use fakes.
//   node --test src/release/check-bench.test.mjs
import { parseTimingLine } from './timing.mjs'

const ID_RE = /^[A-Za-z0-9\-_.]{1,40}$/
const APP_RE = /^[a-z0-9-]+$/
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/

function firstLine(s) {
  if (s == null) return null
  const t = String(s).split('\n').map(l => l.trim()).filter(Boolean)[0]
  return t == null || t === '' ? null : t
}

function toInt(s) {
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

function toNum(s) {
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Read the output lines of one check-app.mjs run into plain data. Never throws. */
export function parseCheckOutput(lines) {
  try {
    const out = {
      outcome: null,
      caseId: null,
      crawl: null,
      facts: null,
      controlDifferences: null,
      candidateDifferences: null,
      learnedFacts: null,
      timing: null,
      findings: [],
      confirmed: 0,
      total: 0,
      error: null,
      seconds: null,
    }
    if (!Array.isArray(lines)) lines = []
    let seenBuild = null
    let seenCrawlFail = null
    let seenNoSteps = false
    let seenConfirmed = false
    let seenNotConfirmed = false
    let seenNoChange = false
    let seenNoisy = null
    let summaryConfirmed = null
    let summaryTotal = null

    for (const raw of lines) {
      if (typeof raw !== 'string') continue
      const line = raw.trim()
      if (line === '') continue

      let m = line.match(/^evidence:\s*(\S+)\s*$/)
      if (m) { out.caseId = m[1]; continue }

      m = line.match(/(\d+)\s+page states,\s*(\d+)\s+flows,\s*(\d+)\s+steps\s*\(stopped:\s*([^,]+),\s*([\d.]+)\s*s\)/)
      if (m) {
        out.crawl = {
          states: toInt(m[1]),
          flows: toInt(m[2]),
          steps: toInt(m[3]),
          stoppedBy: m[4].trim(),
          seconds: toNum(m[5]),
        }
        continue
      }

      m = line.match(/^the crawl failed:\s*(.*)\s*$/)
      if (m) { seenCrawlFail = firstLine(m[1]) ?? ''; continue }

      if (line === 'the crawl did not produce any steps, so there is nothing to compare') { seenNoSteps = true; continue }

      m = line.match(/^a build failed to start, so the versions could not be compared:\s*(.*)\s*$/)
      if (m) { seenBuild = firstLine(m[1]) ?? ''; continue }

      m = line.match(/facts:\s*(\d+)\s+stable,\s*(\d+)\s+volatile\s*\(/)
      if (m) { out.facts = { stable: toInt(m[1]), volatile: toInt(m[2]) }; continue }

      m = line.match(/^control\s*\(.*?\):\s*(\d+)\s+differences/)
      if (m) { out.controlDifferences = toInt(m[1]); continue }

      m = line.match(/^candidate\s*\(.*?\):\s*(\d+)\s+differences/)
      if (m) { out.candidateDifferences = toInt(m[1]); continue }

      m = line.match(/^noise learned from the control:\s*(\d+)\s+more facts/)
      if (m) { out.learnedFacts = toInt(m[1]); continue }

      const tl = parseTimingLine(line)
      if (tl) { out.timing = tl; continue }

      m = line.match(/^control run shows\s+(\d+)\s+differences/)
      if (m) { seenNoisy = toInt(m[1]); continue }

      m = line.match(/^(\d+)\s+of\s+(\d+)\s+findings confirmed/)
      if (m) { summaryConfirmed = toInt(m[1]) ?? 0; summaryTotal = toInt(m[2]) ?? 0; continue }

      if (
        line.includes('no changed facts between the builds') ||
        line.includes('none of the changed facts can be written as a test') ||
        line.startsWith('no value changed')
      ) { seenNoChange = true; continue }

      if (line.startsWith('CONFIRMED:')) { seenConfirmed = true; continue }
      if (line.startsWith('NOT CONFIRMED')) { seenNotConfirmed = true; continue }

      // Finding verdict line: <id>: <ref> (good) passed p/r, <ref> (candidate) failed f/r: <verdict>
      const ci = line.indexOf(': ')
      if (ci > 0) {
        const id = line.slice(0, ci)
        const rest = line.slice(ci + 2)
        if (ID_RE.test(id)) {
          const fm = rest.match(/\(good\)\s+passed\s+\d+\/\d+,\s+.*\(candidate\)\s+failed\s+\d+\/\d+:\s*(confirmed|fails_both|not_reproduced|unstable|error)\s*$/)
          if (fm) { out.findings.push({ id, verdict: fm[1] }); continue }
        }
      }
    }

    if (summaryConfirmed !== null && summaryTotal !== null) {
      out.confirmed = summaryConfirmed
      out.total = summaryTotal
    } else {
      out.total = out.findings.length
      out.confirmed = out.findings.filter(f => f.verdict === 'confirmed').length
    }

    // Outcome precedence: build_failed, noisy, crawl_failed, no_steps, then confirmed, not_confirmed, no_change.
    if (seenBuild !== null) {
      out.outcome = 'build_failed'
      out.error = seenBuild || null
    } else if (seenNoisy !== null) {
      out.outcome = 'noisy'
      out.error = `The control still differed in ${seenNoisy} facts.`
    } else if (seenCrawlFail !== null) {
      out.outcome = 'crawl_failed'
      out.error = seenCrawlFail || null
    } else if (seenNoSteps) {
      out.outcome = 'no_steps'
      out.error = null
    } else if (seenConfirmed) {
      out.outcome = 'confirmed'
      out.error = null
    } else if (seenNotConfirmed) {
      out.outcome = 'not_confirmed'
      out.error = null
    } else if (seenNoChange) {
      out.outcome = 'no_change'
      out.error = null
    } else {
      out.outcome = 'error'
      out.error = out.findings.length ? 'No result line found.' : 'No result line found.'
    }
    return out
  } catch {
    return {
      outcome: 'error',
      caseId: null,
      crawl: null,
      facts: null,
      controlDifferences: null,
      candidateDifferences: null,
      findings: [],
      confirmed: 0,
      total: 0,
      error: 'No result line found.',
      seconds: null,
    }
  }
}

function validApp(app) {
  return typeof app === 'string' && APP_RE.test(app)
}

function validRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.startsWith('-')
}

function round1(n) {
  return Math.round(n * 10) / 10
}

/** Run one app check through the injected runner. Never throws. */
export async function runOne({ app, good, cand, runner, bisect = false, timeoutMs = 1_200_000, now = Date.now, env = {} }) {
  const start = now()
  const secondsOf = () => {
    try { return round1((now() - start) / 1000) } catch { return 0 }
  }
  const base = { app, good, cand, caseId: null, crawl: null, facts: null, controlDifferences: null, candidateDifferences: null, findings: [], confirmed: 0, total: 0, error: null, seconds: 0 }
  if (!validApp(app) || !validRef(good) || !validRef(cand)) {
    return { ...base, outcome: 'error', error: 'Invalid app or version name.', seconds: secondsOf() }
  }
  const argv = ['src/release/check-app.mjs', app, good, cand]
  if (bisect) argv.push('--bisect')
  let res
  try {
    res = await runner(argv, { timeoutMs, env })
  } catch (e) {
    return { ...base, outcome: 'error', error: firstLine(e?.message ?? e) ?? 'Unknown error.', seconds: secondsOf() }
  }
  const seconds = secondsOf()
  let parsed
  try {
    const lines = res && Array.isArray(res.lines) ? res.lines : []
    parsed = parseCheckOutput(lines)
  } catch {
    parsed = parseCheckOutput([])
  }
  const out = { ...base, ...parsed, app, good, cand, seconds }
  if (res?.timedOut) {
    const mins = Math.round(timeoutMs / 60000)
    out.outcome = 'timeout'
    out.error = `Timed out after ${mins} minutes.`
    return out
  }
  const code = res?.code ?? 0
  if (code !== 0 && (out.outcome === 'error' && out.error === 'No result line found.')) {
    out.error = 'No result line found.'
    return out
  }
  return out
}

/** Run jobs one at a time, in order, cleaning up after every job. Never throws. */
export async function runAll({ jobs, runner, cleanup, onResult, ...options }) {
  const list = Array.isArray(jobs) ? jobs : []
  if (list.length === 0) return []
  const results = []
  for (let i = 0; i < list.length; i++) {
    const j = list[i] ?? {}
    let result
    try {
      result = await runOne({ app: j.app, good: j.good, cand: j.cand, runner, bisect: options.bisect, timeoutMs: options.timeoutMs, now: options.now, env: options.env })
    } catch (e) {
      result = { app: j.app, good: j.good, cand: j.cand, outcome: 'error', caseId: null, crawl: null, facts: null, controlDifferences: null, candidateDifferences: null, findings: [], confirmed: 0, total: 0, error: firstLine(e?.message ?? e) ?? 'Unknown error.', seconds: 0 }
    }
    results.push(result)
    if (typeof cleanup === 'function') {
      try { await cleanup() } catch {}
    }
    if (typeof onResult === 'function') {
      try { await onResult(result, i) } catch {}
    }
  }
  return results
}

function cell(s) {
  return String(s).replace(/\r?\n/g, ' ')
}

/** Render results as one markdown table plus a totals line. */
export function renderTable(results) {
  const list = Array.isArray(results) ? results : []
  const header = '| App | Versions | Outcome | Crawl (states/steps) | Control diffs | Candidate diffs | Findings (confirmed/total) | Seconds | Phases compare/tests/shots s (builds, cached) | Note |'
  const sep = '|---|---|---|---|---|---|---|---|---|---|'
  const rows = list.map(r => {
    const app = r?.app ?? '-'
    const versions = r?.good != null && r?.cand != null ? `${r.good} to ${r.cand}` : '-'
    const outcome = r?.outcome ?? '-'
    let crawl = '-'
    if (r?.crawl && typeof r.crawl.states === 'number' && typeof r.crawl.steps === 'number') crawl = `${r.crawl.states}/${r.crawl.steps}`
    const control = typeof r?.controlDifferences === 'number' ? String(r.controlDifferences) : '-'
    const candidate = typeof r?.candidateDifferences === 'number' ? String(r.candidateDifferences) : '-'
    const findings = `${typeof r?.confirmed === 'number' ? r.confirmed : 0}/${typeof r?.total === 'number' ? r.total : 0}`
    const seconds = typeof r?.seconds === 'number' ? String(r.seconds) : '-'
    const ph = r?.timing?.phases
    const phases = ph ? ['compare', 'tests', 'shots'].map(k => `${Math.round(ph[k]?.seconds ?? 0)} (${ph[k]?.builds ?? 0}, ${ph[k]?.cached ?? 0})`).join(' / ') : '-'
    let note = r?.error == null ? '' : String(r.error)
    note = note.replace(/\|/g, '/').slice(0, 80)
    return `| ${cell(app)} | ${cell(versions)} | ${cell(outcome)} | ${cell(crawl)} | ${cell(control)} | ${cell(candidate)} | ${cell(findings)} | ${cell(seconds)} | ${cell(phases)} | ${cell(note)} |`
  })
  const n = list.length
  const c = outcome => list.filter(r => r?.outcome === outcome).length
  const failed = c('build_failed') + c('noisy') + c('crawl_failed') + c('no_steps') + c('timeout') + c('error')
  const totals = `${n} apps: ${c('confirmed')} confirmed, ${c('no_change')} no_change, ${c('not_confirmed')} not_confirmed, ${failed} failed`
  return [header, sep, ...rows, totals].join('\n')
}
