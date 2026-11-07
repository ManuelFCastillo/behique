// Native check: given two built versions of a program and a command profile, record both, compare, prove each difference,
// write everything to an evidence case, and return the result. Building from git refs is the caller's job (Phase 5).
//   node --test src/release/native/check.test.mjs
import { join } from 'node:path'
import { openCase } from '../evidence.mjs'
import { compareRecordings, recordVersion } from './compare.mjs'
import { confirmDiffs, recommend } from './confirm.mjs'

const short = v => (v === null || v === undefined ? '(absent)' : String(v).length > 160 ? `${String(v).slice(0, 157)}...` : String(v))

/**
 * versions = { good: {src, build, ref?, sha?}, cand: {...} }. Returns
 * { recommendation, findings, diffs, masked, cases, caseDir }, and leaves the evidence in caseDir.
 */
export async function checkVersions(profile, versions, { caseDir, workDir, recordRuns = 2, confirmRuns = 3, maxFindings = 10, tol = 0, log = () => {} }) {
  const ev = openCase(caseDir)
  const label = side => versions[side].ref ?? versions[side].sha ?? side
  ev.event('case.opened', {
    mode: 'native', app: profile.name, goodRef: label('good'), candRef: label('cand'),
    goodSha: versions.good.sha ?? null, candSha: versions.cand.sha ?? null,
    cases: profile.cases.map(c => c.id), options: { recordRuns, confirmRuns, maxFindings, tol },
  })
  ev.artifact('profile.json', profile, 'application/json')

  const recs = {}, factsHash = {}
  for (const side of ['good', 'cand']) {
    log(`recording ${label(side)}: ${profile.cases.length} case(s), ${recordRuns} run(s) each`)
    recs[side] = await recordVersion(profile, { ...versions[side], workDir: join(workDir, 'record', side), runs: recordRuns,
      onRun: r => log(`  ${side} ${r.case} run ${r.run}: exit ${r.exit} (${r.ms} ms)`) })
    const stable = Object.fromEntries(Object.entries(recs[side].cases).map(([id, c]) => [id, { stable: c.stable, masked: c.masked }]))
    factsHash[side] = ev.artifact(`facts-${side}.json`, stable, 'application/json')
    for (const [id, c] of Object.entries(recs[side].cases)) {
      ev.artifact(`log-${side}-${id}.txt`, `$ exit ${c.runs[0].exitCode}${c.runs[0].timedOut ? ' (timed out)' : ''}\n--- stdout\n${c.runs[0].stdout}\n--- stderr\n${c.runs[0].stderr}`)
    }
  }

  // A case that could not even start on the good version means the profile or the build is broken: no recommendation.
  const notStarted = Object.entries(recs.good.cases).filter(([, c]) => c.stable.exit === 'not started').map(([id]) => id)
  const cmp = compareRecordings(recs.good, recs.cand, { tol })
  const total = Object.values(recs.good.cases).reduce((n, c) => n + Object.keys(c.stable).length + c.masked.length, 0)
  const masked = Object.fromEntries(Object.entries(cmp.cases).map(([id, c]) => [id, c.masked]))
  const nMasked = Object.values(masked).reduce((n, m) => n + m.length, 0)
  ev.event('masking.summary', { masked: nMasked, total, byCase: masked })
  ev.claim('statistical', `${nMasked} of ${total} recorded facts changed between identical runs and were not compared.`, { evidence: [factsHash.good, factsHash.cand] })
  ev.event('builds.compared', { diffs: cmp.diffs.length, byClass: countBy(cmp.diffs, d => d.cls) })

  const picked = cmp.diffs.filter(d => d.cls !== 'churn' && d.cls !== 'unsteady').slice(0, maxFindings)
  const unsteady = cmp.diffs.filter(d => d.cls === 'unsteady')
  for (const d of cmp.diffs) {
    ev.claim('verified_fact', `${d.case}: ${d.what} ${d.kind} (${d.key}): ${short(d.good)} -> ${short(d.cand)}`, { evidence: [factsHash.good, factsHash.cand], extra: { case: d.case, key: d.key, cls: d.cls } })
  }

  let judged = []
  if (!notStarted.length && picked.length) {
    log(`proving ${picked.length} difference(s), ${confirmRuns} fresh run(s) per version`)
    const testsEvents = new Map()
    judged = await confirmDiffs(profile, picked, versions, { workDir, runs: confirmRuns,
      onRun: r => { const seq = ev.event('test.run', { id: r.id, ref: label(r.side), side: r.side, n: r.n, outcome: r.outcome, value: r.value }); testsEvents.set(r.id, [...(testsEvents.get(r.id) ?? []), `event:${seq}`]) } })
    for (const j of judged) {
      ev.event('test.exported', { id: j.id, case: j.case, fact: j.key, good: j.expect })
      ev.event('test.judged', { id: j.id, verdict: j.verdict, goodPassed: j.goodPassed, candFailed: j.candFailed, runs: j.runs })
      log(`  ${j.id} ${j.case} ${j.key}: ${j.verdict} (good passed ${j.goodPassed}/${j.runs}, candidate failed ${j.candFailed}/${j.runs})`)
      if (j.verdict === 'confirmed') {
        ev.claim('reproduced_failure', `${j.case}: ${j.what} differs every time: good gives ${short(j.expect)}, the candidate does not (${j.runs} of ${j.runs} fresh runs each).`,
          { evidence: testsEvents.get(j.id), extra: { id: j.id, case: j.case, key: j.key } })
      }
    }
  }

  const recommendation = recommend({ judged, diffs: cmp.diffs, incomplete: notStarted.length > 0 })
  const findings = judged.map(j => {
    const d = picked.find(x => x.case === j.case && x.key === j.key)
    return { id: j.id, case: j.case, key: j.key, what: j.what, cls: j.cls, kind: d.kind, good: d.good, cand: d.cand, grid: d.grid ?? null, verdict: j.verdict, goodPassed: j.goodPassed, candFailed: j.candFailed, runs: j.runs }
  })
  const result = { recommendation, findings, unsteady: unsteady.map(d => ({ case: d.case, key: d.key, what: d.what, side: d.side, good: d.good, cand: d.cand })), diffs: cmp.diffs.length, churn: cmp.diffs.filter(d => d.cls === 'churn').length, masked: { count: nMasked, total, byCase: masked }, notStarted, caseDir }
  ev.event('case.closed', { recommendation, findings: findings.length, confirmed: findings.filter(f => f.verdict === 'confirmed').length })
  return result
}

function countBy(xs, f) {
  const o = {}
  for (const x of xs) o[f(x)] = (o[f(x)] ?? 0) + 1
  return o
}
