// Prove each difference between two versions of a native program, and turn the proof into a recommendation.
//   node --test src/release/native/confirm.test.mjs
//
// A difference becomes a test: "run case C on a fresh folder; fact K must equal the good version's value" (or, for a fact
// that only the candidate has, "K must be absent"). The test is run `runs` times on each version, each time from an empty
// folder. It is CONFIRMED only if it passed every time on the good version and failed every time on the candidate. If the
// good version ever fails it, or the candidate passes it some of the time, it is UNSTABLE; if the candidate always passes,
// it is NOT REPRODUCED. Runs are shared: one fresh run of a case answers every test for that case.
//
// Recommendation, computed by code and nothing else:
//   hold          a confirmed difference a person would notice (exit code, message, value, grid) or a changed output file
//   inconclusive  differences were seen but none could be confirmed, so a person has to look (REVIEW); this includes a
//                 fact that is steady on one version and varies between runs of the other
//   ship          no differences, or only output-file churn (bytes changed, every value equal)
//   fail          the evidence is incomplete: a case could not run on the good version at all
import { join } from 'node:path'
import { factsOf } from './facts.mjs'
import { runCase } from './run.mjs'

/** A test for one difference. `expect` null means the fact must be absent. */
export const testFor = (d, i) => ({ id: `N${i + 1}`, case: d.case, key: d.key, expect: d.good, cls: d.cls, what: d.what })

export const passes = (t, facts) => (facts[t.key] ?? null) === t.expect

/** Pure: judge one test from its outcomes on each version. */
export function judge(goodOutcomes, candOutcomes) {
  const goodPassed = goodOutcomes.filter(Boolean).length, candFailed = candOutcomes.filter(x => !x).length
  const verdict = goodPassed === goodOutcomes.length && candFailed === candOutcomes.length ? 'confirmed'
    : candFailed === 0 ? 'not_reproduced' : 'unstable'
  return { verdict, goodPassed, candFailed, runs: goodOutcomes.length }
}

/** Pure: the recommendation from judged tests and the comparison. */
export function recommend({ judged, diffs, incomplete }) {
  if (incomplete) return 'fail'
  const real = diffs.filter(d => d.cls !== 'churn')
  if (judged.some(j => j.verdict === 'confirmed' && j.cls !== 'churn')) return 'hold'
  if (real.length) return 'inconclusive'
  return 'ship'
}

/**
 * Run every test `runs` times on each version. versions = { good: {src, build}, cand: {src, build} }.
 * Returns the tests with their outcomes and judgement.
 */
export async function confirmDiffs(profile, diffs, versions, { workDir, runs = 3, onRun = () => {} }) {
  const tests = diffs.filter(d => d.cls !== 'churn' && d.cls !== 'unsteady').map(testFor)
  const outcomes = Object.fromEntries(tests.map(t => [t.id, { good: [], cand: [] }]))
  const byCase = new Map()
  for (const t of tests) byCase.set(t.case, [...(byCase.get(t.case) ?? []), t])
  for (const [caseId, ts] of byCase) {
    const kase = profile.cases.find(c => c.id === caseId)
    for (const side of ['good', 'cand']) {
      for (let n = 0; n < runs; n++) {
        const r = await runCase(profile, kase, { ...versions[side], runDir: join(workDir, 'confirm', side, caseId, `run${n + 1}`) })
        const { facts } = factsOf(r, kase, profile)
        for (const t of ts) {
          const ok = passes(t, facts)
          outcomes[t.id][side].push(ok)
          onRun({ id: t.id, side, n: n + 1, outcome: ok ? 'passed' : 'failed', value: facts[t.key] ?? null })
        }
      }
    }
  }
  return tests.map(t => ({ ...t, ...judge(outcomes[t.id].good, outcomes[t.id].cand), outcomes: outcomes[t.id] }))
}
