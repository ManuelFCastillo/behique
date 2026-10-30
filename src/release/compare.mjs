// Compare two builds of an app by the facts their pages show, with run-twice masking and a control run.
// Every build runs on the same port, one after another, so the port never shows up as a difference.
import { startBuild } from './build.mjs'
import { buildBaseline, diffFacts, rankDiffs, recordRun } from './facts.mjs'

const kinds = d => ['changed', 'added', 'removed', 'moved'].map(k => `${k} ${d.filter(x => x.kind === k).length}`).join(', ')

/** The three summary lines shared by diff-builds and confirm. */
export function summaryLines({ baseline, cand, control }, baseRef, candRef) {
  const nStable = Object.keys(baseline.stable).length, nVol = Object.keys(baseline.volatile).length
  return [
    `facts: ${nStable} stable, ${nVol} volatile (${(100 * nVol / (nStable + nVol)).toFixed(1)}% masked)`,
    `control (${baseRef} a third time): ${control.length} differences${control.length ? ' (' + kinds(control) + ')' : ''}`,
    `candidate (${candRef}): ${cand.length} differences (${kinds(cand)})`,
  ]
}

/** Returns { baseline, cand, control, baseSha, candSha }. cand and control are ranked difference lists. */
export async function compareBuilds({ adapter, baseRef, candRef, port, actions, readOnly = false }) {
  const record = async ref => {
    const b = await startBuild({ adapter, ref, port })
    try { return { steps: await recordRun(b.base, actions, { readOnly }), sha: b.sha } } finally { await b.stop() }
  }
  const a = await record(baseRef), b = await record(baseRef)
  const baseline = buildBaseline(a.steps, b.steps)
  const cand = await record(candRef)
  const control = await record(baseRef)
  return { baseline, baseSha: a.sha, candSha: cand.sha, cand: rankDiffs(diffFacts(baseline, cand.steps)), control: rankDiffs(diffFacts(baseline, control.steps)) }
}
