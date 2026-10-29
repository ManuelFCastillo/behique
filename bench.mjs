#!/usr/bin/env node
// Score Behique against the todo-app's planted bugs.
//   node bench.mjs --model baseten|meta [--only C1,S2,clean] [--clean 2] [--workers 4]
//                  [--max-steps 20] [--max-tokens 150000] [--max-cost 0.30] [--budget 8] [--dry-run]
// Per job: explore the (mutated) app, then replay every finding on the mutated app and on the clean app.
//   validated          = assertion fails on the mutated app and passes on the clean app: a real, reproduced bug
//   wrong_expectation  = fails on the clean app too (wrong expectation, or an unplanted quirk; audit these)
//   not_reproduced     = assertion passes on the mutated app (the report was not true)
//   error              = replay could not run
// A mutation is detected when at least one finding is validated. Caps stop a run, never the whole bench,
// except --budget, which stops launching new jobs once the estimated total spend reaches it.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUTATIONS, startApp } from './src/apps.mjs'
import { explore } from './src/explorer.mjs'
import { estCost, PROVIDERS } from './src/llm.mjs'
import { replayFinding } from './src/replay.mjs'
import { loadCorpus } from './src/retrieve.mjs'
import { runExported, writeExport } from './src/export.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]) }
const model = arg('model', 'baseten')
if (!PROVIDERS[model]) { console.error('--model must be one of ' + Object.keys(PROVIDERS)); process.exit(2) }
const caps = { maxSteps: +arg('max-steps', 20), maxTokens: +arg('max-tokens', 150000), maxCostUsd: +arg('max-cost', 0.30) }
// Tuning arms (all off by default, so default runs match the earlier ones): --reasoning low|high, --temp 0, --actions 1
if (arg('reasoning', false)) caps.reasoning = String(arg('reasoning'))
if (arg('temp', false) !== false) caps.temperature = +arg('temp')
if (arg('actions', false)) caps.maxActions = +arg('actions')
const budget = +arg('budget', 8)
const workers = +arg('workers', 4)
const cleanRuns = +arg('clean', 2)
const UNREACHABLE = { 'H3-ids-not-reset': 'needs the test-only /api/reset endpoint, which a black-box tester cannot see' }
const selfCheck = !arg('no-selfcheck', false)
const corpusArg = String(arg('corpus', 'none'))
const retriever = corpusArg === 'none' ? null : loadCorpus(corpusArg.split('+'))
const only = arg('only', null)
const wanted = only ? String(only).split(',') : null

const jobs = []
for (let i = 0; i < cleanRuns; i++) jobs.push({ id: `clean-${i + 1}`, mutation: null })
for (const m of MUTATIONS) {
  if (UNREACHABLE[m.id]) continue
  jobs.push({ id: m.id, mutation: m })
}
const selected = jobs.filter(j => !wanted || wanted.some(w => j.id === w || j.id.startsWith(w + '-') || (w === 'clean' && !j.mutation)))
if (arg('dry-run', false)) { console.log(selected.map(j => j.id).join(' '), `\n${selected.length} jobs, caps`, caps, 'budget', budget); process.exit(0) }

const runId = `${model}${corpusArg === 'none' ? '' : '-' + corpusArg.replace('+', '_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const outDir = join(ROOT, 'bench/runs', runId)
mkdirSync(outDir, { recursive: true })
let spent = 0, nextJob = 0, launched = 0
const results = []

const classify = f => {
  if (f.onSubject.status === 'error' || f.onClean.status === 'error') return 'error'
  if (f.onSubject.status === 'pass') return 'not_reproduced'
  return f.onClean.status === 'pass' ? 'validated' : 'wrong_expectation'
}

async function runJob(job, slot) {
  const port = +arg('port-base', 5200) + slot * 4
  const t0 = Date.now()
  const subject = await startApp({ mutation: job.mutation, port })
  const replica = await startApp({ mutation: job.mutation, port: port + 3, allowReset: true }) // disposable copy for the self-check
  let ex
  try {
    ex = await explore({
      baseUrl: subject.base, model, caps, replicaBase: replica.base, selfCheck, retriever,
      brief: 'App under test: a small web page with a login form, a todo list backed by a JSON API under /api, and a few widgets. You have no other documentation.',
      onStep: e => console.log(`  [${job.id}] step ${e.step} +${e.pt + e.ct}tok  ${e.bugs ? e.bugs + ' bug(s) ' : ''}${(e.actions[0] ?? '').slice(0, 60)}${e.pushback ? ' (completion check pushed back)' : ''}`),
    })
  } finally { await subject.stop(); await replica.stop() }
  let exportCheck = null
  const mutApp = await startApp({ mutation: job.mutation, port: port + 1, allowReset: true })
  const cleanApp = await startApp({ mutation: null, port: port + 2, allowReset: true })
  try {
    for (const f of ex.findings) {
      f.onSubject = await replayFinding(mutApp.base, f.history, f.assert)
      f.onClean = job.mutation ? await replayFinding(cleanApp.base, f.history, f.assert) : f.onSubject
      f.verdict = classify(f)
    }
    // Export every accepted finding as a Playwright test and run it with Playwright's own runner.
    if (ex.findings.length) {
      const dir = join(outDir, 'tests', job.id)
      writeExport(dir, ex.findings)
      const onMut = runExported(dir, mutApp.base)
      const onCle = job.mutation ? runExported(dir, cleanApp.base) : onMut
      exportCheck = { tests: ex.findings.length, ran: 0, agree: 0, validated: 0, killers: 0, error: onMut.error ?? onCle.error ?? null }
      for (const f of ex.findings) {
        const m = onMut.results[f.id], c = onCle.results[f.id]
        if (m === undefined || c === undefined) continue
        exportCheck.ran++
        f.exported = { mutatedPasses: m, cleanPasses: c }
        if (m === (f.onSubject.status === 'pass') && c === (f.onClean.status === 'pass')) exportCheck.agree++
        if (f.verdict === 'validated') { exportCheck.validated++; if (m === false && c === true) exportCheck.killers++ }
      }
    }
  } finally { await mutApp.stop(); await cleanApp.stop() }
  const counts = {}
  for (const f of ex.findings) counts[f.verdict] = (counts[f.verdict] ?? 0) + 1
  const summary = {
    job: job.id, what: job.mutation?.what ?? 'clean app (no planted bug)', model, steps: ex.steps.length, actions: ex.actionsTaken,
    tokens: ex.pt + ex.ct, costEst: +ex.cost.toFixed(4), capped: ex.capped, finished: ex.finished, secs: Math.round((Date.now() - t0) / 1000),
    reported: ex.findings.length, counts, detected: job.mutation ? ex.findings.some(f => f.verdict === 'validated') : null,
    falsePositives: job.mutation ? null : ex.findings.filter(f => f.onSubject.status === 'fail').length,
    rejected: ex.rejected, selfCheck, exportCheck, corpus: corpusArg, retrievedChunks: ex.steps.reduce((a, e) => a + (e.retrieved?.length ?? 0), 0), retrievedUnique: new Set(ex.steps.flatMap(e => e.retrieved ?? [])).size,
  }
  writeFileSync(join(outDir, job.id + '.json'), JSON.stringify({ summary, findings: ex.findings.map(({ history, ...f }) => ({ ...f, historyLength: history.length })), steps: ex.steps }, null, 1))
  appendFileSync(join(outDir, 'results.jsonl'), JSON.stringify(summary) + '\n')
  console.log(`${job.id}: ${job.mutation ? (summary.detected ? 'DETECTED' : 'missed') : 'clean run'}  reported ${summary.reported} ${JSON.stringify(counts)}  ${summary.tokens} tok ~$${summary.costEst} ${summary.secs}s${summary.capped ? ' capped:' + summary.capped : ''}`)
  return summary
}

async function worker(slot) {
  while (nextJob < selected.length) {
    if (spent >= budget) { console.log(`budget ${budget} reached (est $${spent.toFixed(2)}), not launching more jobs`); return }
    const job = selected[nextJob++]
    launched++
    try {
      const s = await runJob(job, slot)
      spent += s.costEst; results.push(s)
    } catch (e) {
      console.log(`${job.id}: ERROR ${String(e.message).slice(0, 200)}`)
      results.push({ job: job.id, error: String(e.message), detected: job.mutation ? false : null, costEst: 0, tokens: 0, counts: {}, reported: 0 })
    }
  }
}

console.log(`corpus: ${corpusArg}${retriever ? ` (${retriever.size} test cases)` : ''}`)
console.log(`run ${runId}: ${selected.length} jobs on ${model} (${PROVIDERS[model].model}), ${workers} workers, caps ${JSON.stringify(caps)}, budget $${budget}`)
await Promise.all(Array.from({ length: Math.min(workers, selected.length) }, (_, i) => worker(i)))

const muts = results.filter(r => r.detected !== null && r.job && !r.job.startsWith('clean'))
const clean = results.filter(r => r.job?.startsWith('clean'))
const sum = (a, k) => a.reduce((x, r) => x + (r[k] ?? 0), 0)
const agg = k => results.reduce((x, r) => x + (r.counts?.[k] ?? 0), 0)
const lines = [
  `\n=== ${model} (${PROVIDERS[model].model}) ===`,
  `mutations detected: ${muts.filter(r => r.detected).length}/${muts.length} (H3-ids-not-reset excluded: ${UNREACHABLE['H3-ids-not-reset']})`,
  `missed: ${muts.filter(r => !r.detected).map(r => r.job).join(', ') || 'none'}`,
  `findings across all runs: ${sum(results, 'reported')}  validated ${agg('validated')}  wrong_expectation ${agg('wrong_expectation')}  not_reproduced ${agg('not_reproduced')}  error ${agg('error')}`,
  `clean-app runs: ${clean.length}, false positives (assertion fails on the correct app): ${sum(clean, 'falsePositives')}`,
  `self-check rejections: ${JSON.stringify(['invalid', 'ungrounded', 'not_reproduced', 'unstable', 'error'].reduce((o, k) => ({ ...o, [k]: results.reduce((x, r) => x + (r.rejected?.[k] ?? 0), 0) }), {}))}`,
  `exported Playwright tests: ${results.reduce((x, r) => x + (r.exportCheck?.ran ?? 0), 0)} ran, ${results.reduce((x, r) => x + (r.exportCheck?.agree ?? 0), 0)} agree with the replay; validated findings whose exported test fails on the buggy app and passes on the clean one: ${results.reduce((x, r) => x + (r.exportCheck?.killers ?? 0), 0)} of ${results.reduce((x, r) => x + (r.exportCheck?.validated ?? 0), 0)}`,
  `tokens ${sum(results, 'tokens').toLocaleString()}  est cost $${sum(results, 'costEst').toFixed(2)} (third-party price, unverified)  avg per run $${(sum(results, 'costEst') / Math.max(results.length, 1)).toFixed(3)}  capped runs: ${results.filter(r => r.capped).length}`,
  `details: ${outDir}`,
]
console.log(lines.join('\n'))
writeFileSync(join(outDir, 'summary.txt'), lines.join('\n'))
