#!/usr/bin/env node
// Rescore finished bench runs with the extra categories, offline (no model calls).
//   node rescore.mjs [metaRunDir] [basetenRunDir]     -> writes bench/final-results.json and prints a summary
// Categories for a finding:
//   validated       fails on the mutated app, passes on the clean app: the planted bug, reproduced
//   real_unplanted  fails on the clean app too, but the clean app really has that defect ("1 tasks remaining")
//   false_alarm     fails on the clean app and the defect is not real: a guessed route or field, or a bad expectation
//   not_reproduced  the assertion passes on the app it was found on: the report was not true
//   error           the replay could not run
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { categorize } from './src/categorize.mjs'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const runsDir = join(ROOT, 'bench/runs')
const jobCount = d => readdirSync(join(runsDir, d)).filter(f => f.endsWith('.json')).length
const latest = m => join(runsDir, readdirSync(runsDir).filter(d => d.startsWith(m + '-2') && !d.endsWith('.log')).sort((a, b) => jobCount(a) - jobCount(b)).at(-1)) // the run with the most jobs, not a one-job rerun
const dirs = { meta: process.argv[2] ?? latest('meta'), baseten: process.argv[3] ?? latest('baseten') }
const MUTATIONS = JSON.parse(readFileSync(join(ROOT, 'bench/mutations.json'), 'utf8'))
const UNREACHABLE = new Set(['H3-ids-not-reset'])
const SMOKE = new Set(['C1-login-any-password', 'S2-blank-accepted'])
const layerOf = id => MUTATIONS.find(m => m.id === id)?.file === 'server.js' ? 'server' : 'page'

const out = { generated: new Date().toISOString(), models: {} }
for (const [model, dir] of Object.entries(dirs)) {
  const jobs = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const m = { dir, perMutation: {}, clean: [], cats: {}, alarmWhy: {}, tokens: 0, cost: 0, secs: 0, capped: 0, runs: jobs.length, realUnplantedRuns: 0 }
  for (const j of jobs) {
    const s = j.summary
    m.tokens += s.tokens; m.cost += s.costEst; m.secs += s.secs; m.capped += s.capped ? 1 : 0
    const cats = j.findings.map(categorize)
    cats.forEach(c => { m.cats[c.cat] = (m.cats[c.cat] ?? 0) + 1; if (c.why) m.alarmWhy[c.why] = (m.alarmWhy[c.why] ?? 0) + 1 })
    if (cats.some(c => c.cat === 'real_unplanted')) m.realUnplantedRuns++
    if (s.job.startsWith('clean')) m.clean.push({ job: s.job, reported: s.reported, cats: cats.map(c => c.cat) })
    else m.perMutation[s.job] = { detected: s.detected, reported: s.reported, steps: s.steps, tokens: s.tokens }
  }
  const scored = Object.entries(m.perMutation).filter(([id]) => !UNREACHABLE.has(id))
  const det = (arr) => arr.filter(([, v]) => v.detected).length
  m.detected = det(scored); m.scored = scored.length
  m.heldOut = det(scored.filter(([id]) => !SMOKE.has(id))); m.heldOutOf = scored.filter(([id]) => !SMOKE.has(id)).length
  for (const layer of ['server', 'page']) {
    const l = scored.filter(([id]) => layerOf(id) === layer)
    m[layer] = { detected: det(l), of: l.length }
  }
  const total = Object.values(m.cats).reduce((a, b) => a + b, 0)
  m.findings = total
  m.trueReports = (m.cats.validated ?? 0) + (m.cats.real_unplanted ?? 0)
  m.cleanRunsWithFalseAlarm = m.clean.filter(c => c.cats.includes('false_alarm')).length
  m.cleanRunsWithRealUnplanted = m.clean.filter(c => c.cats.includes('real_unplanted')).length
  out.models[model] = m
}
const A = out.models.meta.perMutation, B = out.models.baseten.perMutation
const ids = MUTATIONS.map(x => x.id).filter(id => !UNREACHABLE.has(id))
out.overlap = {
  both: ids.filter(i => A[i]?.detected && B[i]?.detected),
  metaOnly: ids.filter(i => A[i]?.detected && !B[i]?.detected),
  basetenOnly: ids.filter(i => !A[i]?.detected && B[i]?.detected),
  neither: ids.filter(i => !A[i]?.detected && !B[i]?.detected),
}
writeFileSync(join(ROOT, 'bench/final-results.json'), JSON.stringify(out, null, 2))

for (const [name, m] of Object.entries(out.models)) {
  console.log(`\n=== ${name} ===`)
  console.log(`detected ${m.detected}/${m.scored} (held-out ${m.heldOut}/${m.heldOutOf}; server ${m.server.detected}/${m.server.of}, page ${m.page.detected}/${m.page.of})`)
  console.log(`findings ${m.findings}: ${JSON.stringify(m.cats)}  true reports ${m.trueReports} (${(100 * m.trueReports / m.findings).toFixed(0)}%)`)
  console.log(`false alarms by reason: ${JSON.stringify(m.alarmWhy)}`)
  console.log(`real unplanted bug found in ${m.realUnplantedRuns} of ${m.runs} runs; clean runs with a false alarm ${m.cleanRunsWithFalseAlarm}/${m.clean.length}, with the real unplanted bug ${m.cleanRunsWithRealUnplanted}/${m.clean.length}`)
  console.log(`tokens ${m.tokens.toLocaleString()}  est cost $${m.cost.toFixed(2)}  avg ${Math.round(m.secs / m.runs)}s/run  capped ${m.capped}/${m.runs}`)
}
console.log('\nboth:', out.overlap.both.length, '| meta only:', out.overlap.metaOnly.join(', '), '| baseten only:', out.overlap.basetenOnly.join(', '), '| neither:', out.overlap.neither.join(', '))
