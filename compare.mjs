#!/usr/bin/env node
// Compare finished bench runs of the same model, left to right.
//   node compare.mjs label=dir label=dir [label=dir ...]
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { categorize } from './src/categorize.mjs'

const specs = process.argv.slice(2).map(a => { const i = a.indexOf('='); return { label: a.slice(0, i), dir: a.slice(i + 1) } })
if (specs.length < 2 || specs.some(s => !s.dir)) { console.error('usage: node compare.mjs label=dir label=dir [...]'); process.exit(2) }
const UNREACHABLE = new Set(['H3-ids-not-reset'])
const SMOKE = new Set(['C1-login-any-password', 'S2-blank-accepted'])
const REJ = ['not_reproduced', 'ungrounded', 'unstable', 'invalid', 'error']

function load(dir) {
  const jobs = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const m = { cats: {}, why: {}, detected: {}, tokens: 0, cost: 0, secs: 0, capped: 0, runs: jobs.length, clean: [], rej: {}, exp: { ran: 0, agree: 0, validated: 0, killers: 0 } }
  for (const j of jobs) {
    const s = j.summary
    m.tokens += s.tokens; m.cost += s.costEst; m.secs += s.secs; m.capped += s.capped ? 1 : 0
    for (const k of REJ) m.rej[k] = (m.rej[k] ?? 0) + (s.rejected?.[k] ?? 0)
    for (const k of Object.keys(m.exp)) m.exp[k] += s.exportCheck?.[k] ?? 0
    const cats = j.findings.map(categorize)
    cats.forEach(c => { m.cats[c.cat] = (m.cats[c.cat] ?? 0) + 1; if (c.why) m.why[c.why] = (m.why[c.why] ?? 0) + 1 })
    if (s.job.startsWith('clean')) m.clean.push(cats.map(c => c.cat))
    else if (!UNREACHABLE.has(s.job)) m.detected[s.job] = !!s.detected
  }
  const ids = Object.keys(m.detected)
  m.found = ids.filter(i => m.detected[i]).length
  m.heldOut = ids.filter(i => !SMOKE.has(i) && m.detected[i]).length
  m.reports = Object.values(m.cats).reduce((a, b) => a + b, 0)
  const t = (m.cats.validated ?? 0) + (m.cats.real_unplanted ?? 0), fa = m.cats.false_alarm ?? 0
  m.trueRate = t + fa ? t / (t + fa) : 0
  m.cleanFA = m.clean.filter(c => c.includes('false_alarm')).length
  return m
}
const runs = specs.map(s => ({ ...s, m: load(s.dir) }))
const W = 13
const head = 'metric'.padEnd(52) + runs.map(r => r.label.padStart(W)).join('')
console.log(head)
const row = (label, fn) => console.log(label.padEnd(52) + runs.map(r => String(fn(r.m)).padStart(W)).join(''))
const dash = x => (x === undefined ? '-' : x)
row('planted bugs found (of 27)', m => m.found)
row('  without C1 and S2 used while tuning (of 25)', m => m.heldOut)
row('reports kept', m => m.reports)
row('  planted bug, reproduced', m => m.cats.validated ?? 0)
row('  real bug nobody planted', m => m.cats.real_unplanted ?? 0)
row('  false alarm', m => m.cats.false_alarm ?? 0)
row('  did not reproduce (reached the score)', m => m.cats.not_reproduced ?? 0)
row('  replay error', m => m.cats.error ?? 0)
row('reports that were true, of those that reproduced', m => (100 * m.trueRate).toFixed(0) + '%')
row('clean-app runs with a false alarm (of 2)', m => m.cleanFA)
for (const k of REJ) row(`self-check rejections: ${k}`, m => (m.rej[k] ? m.rej[k] : '-'))
row('exported tests agreeing with the replay', m => (m.exp.ran ? `${m.exp.agree}/${m.exp.ran}` : '-'))
row('validated findings whose exported test kills the bug', m => (m.exp.validated ? `${m.exp.killers}/${m.exp.validated}` : '-'))
row('runs stopped by the step cap', m => m.capped)
row('average seconds per run', m => Math.round(m.secs / m.runs))
row('tokens', m => m.tokens.toLocaleString())
row('estimated cost (unverified price)', m => '$' + m.cost.toFixed(2))
const first = runs[0].m, last = runs.at(-1).m, ids = Object.keys(last.detected)
for (const r of runs) console.log(`\nfalse alarms by reason, ${r.label}: ${JSON.stringify(r.m.why)}`)
console.log(`\nvs ${runs[0].label}:  gained: ${ids.filter(i => last.detected[i] && !first.detected[i]).join(', ') || 'none'}   lost: ${ids.filter(i => !last.detected[i] && first.detected[i]).join(', ') || 'none'}`)
if (runs.length > 2) { const prev = runs.at(-2).m; console.log(`vs ${runs.at(-2).label}:  gained: ${ids.filter(i => last.detected[i] && !prev.detected[i]).join(', ') || 'none'}   lost: ${ids.filter(i => !last.detected[i] && prev.detected[i]).join(', ') || 'none'}`) }
