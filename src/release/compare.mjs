// Compare two builds of an app by the facts their pages show, with run-twice masking and a control run.
// Every build runs on the same port, one after another, so the port never shows up as a difference.
import { startBuild } from './build.mjs'
import { buildBaseline, diffFacts, rankDiffs, recordRun, widenMask } from './facts.mjs'

const kinds = d => ['changed', 'added', 'removed', 'moved'].map(k => `${k} ${d.filter(x => x.kind === k).length}`).join(', ')

/** The three summary lines shared by diff-builds and confirm. */
export function summaryLines({ baseline, cand, control, learned = null }, baseRef, candRef) {
  const nStable = Object.keys(baseline.stable).length, nVol = Object.keys(baseline.volatile).length
  return [
    `facts: ${nStable} stable, ${nVol} volatile (${(100 * nVol / (nStable + nVol)).toFixed(1)}% masked)`,
    `control (${baseRef} a third time): ${control.length} differences${control.length ? ' (' + kinds(control) + ')' : ''}`,
    `candidate (${candRef}): ${cand.length} differences (${kinds(cand)})`,
    ...(learned ? [`noise learned from the control: ${learned.added} more facts ignored after ${learned.rounds} extra recording${learned.rounds === 1 ? '' : 's'}`] : []),
  ]
}

/** Returns { baseline, cand, control, learned, baseSha, candSha }. cand and control are ranked difference lists. */
export async function compareBuilds({ adapter, baseRef, candRef, port, actions, readOnly = false, maxExtraControls = 5 }) {
  const record = async ref => {
    const b = await startBuild({ adapter, ref, port })
    try { return { steps: await recordRun(b.base, actions, { readOnly }), sha: b.sha } } finally { await b.stop() }
  }
  const a = await record(baseRef), b = await record(baseRef)
  let baseline = buildBaseline(a.steps, b.steps)
  const cand = await record(candRef)
  let control = await record(baseRef)
  // The control must come back clean. If it does not, what it disagreed on is noise the two baseline recordings missed: widen the mask
  // and record a fresh control, at most five times. The candidate is diffed against the final mask, so nothing the control flagged can pass as a change.
  let learned = null
  for (let round = 1; round <= maxExtraControls; round++) {
    const diffs = diffFacts(baseline, control.steps)
    if (!diffs.length) break
    const w = widenMask(baseline, diffs)
    baseline = w.baseline
    learned = { added: (learned?.added ?? 0) + w.added, rounds: round }
    control = await record(baseRef)
  }
  return { baseline, baseSha: a.sha, candSha: cand.sha, learned, cand: rankDiffs(diffFacts(baseline, cand.steps)), control: rankDiffs(diffFacts(baseline, control.steps)) }
}
