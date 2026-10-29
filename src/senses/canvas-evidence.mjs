// Write a canvas run into the evidence store, as a release check of one version of an app against another.
// Good = the unchanged app, candidate = the version under test. Both were explored with the SAME proposed controls, each
// in fresh browsers (see trace.mjs). A step is a proven behaviour change only when it fails every run on the candidate
// and passes every run on the good version. Who writes what is enforced by evidence.mjs:
//   the model's proposal of the control      -> ai_hypothesis (by the model; never proof)
//   what the pixels did, and the replays     -> reproduced_failure / verified_fact / statistical (by code)
// The model never writes a verdict.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCase } from '../release/evidence.mjs'
import { aboveFloor, diff, diffImage } from './pixels.mjs'

const FAIL = new Set(['no_change', 'changed_elsewhere', 'unexpected_change'])
const PASS = new Set(['verified', 'changed'])
const WORDS = { verified: 'changed at the expected spot', changed: 'changed something', no_change: 'changed nothing', changed_elsewhere: 'changed, but not at the expected spot', unexpected_change: 'changed when nothing should change' }

/**
 * What one step shows, from its verdicts in every run on each version.
 *   regression   fails the same way every run on the candidate, passes every run on the good version
 *   fails_both   fails every run on both versions: not a difference between them
 *   unstable     the candidate fails in some runs and not others, or the good version is mixed
 *   pass         the candidate never fails
 *   skipped      the control was not clicked (not on the canvas, or nothing there)
 */
export function classify(goodRuns, candRuns) {
  if (candRuns.every(v => String(v).startsWith('skipped')) || goodRuns.every(v => String(v).startsWith('skipped'))) return 'skipped'
  if (!candRuns.some(v => FAIL.has(v))) return 'pass'
  const candSame = candRuns.every(v => v === candRuns[0] && FAIL.has(v))
  if (!candSame) return 'unstable'
  if (goodRuns.every(v => PASS.has(v))) return 'regression'
  if (goodRuns.every(v => FAIL.has(v))) return 'fails_both'
  return 'unstable'
}

const runsAt = (t, i) => [t.verdicts[i], ...(t.replayVerdicts ?? []).map(r => r[i])].filter(v => v !== undefined)
const readTrace = dir => JSON.parse(readFileSync(join(dir, 'trace.json'), 'utf8'))
const where = a => { const p = a.from ?? a; return `(${Math.round(p.x)}, ${Math.round(p.y)})` }

/**
 * @param goodDir,candDir  trace directories (trace.json plus s<i>-{before,after,diff}.png) written by trace.mjs
 * @param floorDir  optional: another run of the GOOD version. How much its pictures differ from goodDir's is the noise floor, step by step.
 * @param screenshot,proposals  paths to the one picture the model was shown and the controls it proposed
 * @param model  the model that proposed them, e.g. 'muse-spark-1.3'
 * @returns { caseId, counts }
 */
export function recordCanvasCase({ evidenceRoot, goodDir, candDir, floorDir = null, variantId, bug = null, screenshot, proposals, model, provenance }) {
  const good = readTrace(goodDir), cand = readTrace(candDir)
  if (good.steps.length !== cand.steps.length) throw new Error('the two traces do not cover the same steps')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const caseId = `${stamp}_canvas-clean-vs-${variantId}`.replace(/[^\w.-]/g, '_')
  const c = openCase(join(evidenceRoot, caseId))
  const goodRef = 'the unchanged test app', candRef = `the ${variantId === 'clean' ? 'second clean copy of the' : variantId} ${variantId === 'clean' ? 'test app' : 'version'}`
  const controls = JSON.parse(readFileSync(proposals, 'utf8'))
  const about = (bug ? `Planted in this version (known to the bench, not told to the model): ${bug.what}` : 'No bug is planted in this copy, so any finding here would be a false alarm.')
    + ' How it works: a model looked at one screenshot and proposed the controls; the hands then clicked or dragged each one in fresh browsers, and the pixels decided whether the right spot changed. This check cannot see wrong words or colours that still change the screen in the expected place.'
  c.event('case.opened', {
    goodRef, candRef, adapter: 'canvas-senses', kind: 'canvas', steps: cand.steps.map(s => ({ type: s.action.type, label: s.label, kind: s.kind })),
    options: { bisect: false, runs: 1 + (cand.replayVerdicts?.length ?? 0) },
    scenario: { name: `canvas-${variantId}`, label: `Canvas test app, ${variantId === 'clean' ? 'no planted bug' : variantId}`, about, upstream: null },
    proposals: { model, count: controls.length, ...provenance },
  })

  const art = (name, file, mediaType = 'image/png') => c.artifact(name, readFileSync(file), mediaType)
  const shotH = art('screenshot-the-model-saw.png', screenshot)
  const propH = c.artifact('proposed-controls.json', readFileSync(proposals, 'utf8'), 'application/json')
  const goodT = c.artifact('unchanged-app-trace.json', readFileSync(join(goodDir, 'trace.json'), 'utf8'), 'application/json')
  const candT = c.artifact('candidate-trace.json', readFileSync(join(candDir, 'trace.json'), 'utf8'), 'application/json')
  const stepArt = (dir, i, which, tag) => { const f = join(dir, `s${i}-${which}.png`); return existsSync(f) ? art(`step${i + 1}-${tag}-${which}.png`, f) : null }

  const counts = { regression: 0, fails_both: 0, unstable: 0, pass: 0, skipped: 0, differs: 0 }
  const rows = cand.steps.map((s, i) => ({ s, i, kind: classify(runsAt(good, i), runsAt(cand, i)), g: runsAt(good, i), k: runsAt(cand, i) }))
  for (const r of rows) counts[r.kind]++
  const nGoodRuns = 1 + (good.replayVerdicts?.length ?? 0), nCandRuns = 1 + (cand.replayVerdicts?.length ?? 0)
  const skipped = [...new Set(rows.filter(r => r.kind === 'skipped').map(r => cand.steps[r.i].verdict))]

  c.claim('verified_fact', `The model proposed ${controls.length} controls from one screenshot. ${cand.steps.length - counts.skipped} of them were clicked or dragged on ${candRef}${counts.skipped ? `; ${counts.skipped} ${counts.skipped === 1 ? 'was' : 'were'} skipped without a click (${skipped.map(v => v.replace('skipped_', '').replace('_', ' ')).join(', ')})` : ''}. ${rows.filter(r => r.kind !== 'skipped' && r.k[0] && PASS.has(r.k[0])).length} did what a correct app does on the first run.`, { evidence: [candT, propH] })
  if (nCandRuns > 1) {
    const stable = rows.filter(r => r.kind !== 'skipped' && r.k.every(v => v === r.k[0])).length, active = cand.steps.length - counts.skipped
    const gStable = rows.filter(r => r.kind !== 'skipped' && r.g.every(v => v === r.g[0])).length
    c.claim('statistical', `The same steps were repeated in ${nCandRuns} fresh browsers on ${candRef}: ${stable} of ${active} steps gave the same verdict every time. On ${goodRef} (${nGoodRuns} browsers): ${gStable} of ${active}.`, { evidence: [candT, goodT] })
  }

  for (const r of rows.filter(r => r.kind === 'regression')) {
    const s = r.s, n = r.i + 1
    const ev = [...new Set([stepArt(candDir, r.i, 'before', 'candidate'), stepArt(candDir, r.i, 'after', 'candidate'), stepArt(candDir, r.i, 'diff', 'candidate'), stepArt(goodDir, r.i, 'after', 'unchanged'), candT, goodT].filter(Boolean))]
    const verb = s.action.type === 'drag' ? 'Dragging' : 'Clicking'
    c.claim('ai_hypothesis', `From one screenshot the model proposed a ${s.kind} labelled "${s.label}" at ${where(s.action)}, and that it can be operated${s.action.type === 'drag' ? ' by dragging' : ''}. This is its guess about what is on the screen. It did not judge whether the control works; only the pixels did.`, {
      by: 'model', model, evidence: [shotH, propH], extra: { source: 'canvas-vision', step: n, controlKind: s.kind, controlLabel: s.label },
    })
    c.claim('reproduced_failure', `Step ${n}: ${verb.toLowerCase()} the "${s.label}" control ${where(s.action)} ${WORDS[r.k[0]] ?? r.k[0]} on ${candRef} in ${r.k.length} of ${r.k.length} fresh browsers (${s.changed ?? 0} pixels changed${s.expectRegion ? `, ${s.inRegion ?? 0} of them at the spot a correct app would change` : ''}), and on ${goodRef} the same step ${WORDS[r.g[0]] ?? r.g[0]} in ${r.g.length} of ${r.g.length} fresh browsers.`, { evidence: ev })
  }
  for (const r of rows.filter(r => r.kind === 'fails_both')) c.claim('verified_fact', `Step ${r.i + 1}: the "${r.s.label}" control ${WORDS[r.k[0]] ?? r.k[0]} on both ${goodRef} and ${candRef} in every run, so it is not a difference between the versions.`, { evidence: [candT, goodT] })
  for (const r of rows.filter(r => r.kind === 'unstable')) c.claim('statistical', `Step ${r.i + 1}: the "${r.s.label}" control gave mixed results (${candRef}: ${r.k.join(', ')}; ${goodRef}: ${r.g.join(', ')}), so it is not called a change.`, { evidence: [candT, goodT] })

  // Picture comparison: after the same action, does the screen differ between the versions, by more than the unchanged app
  // differs from itself? Verdicts can pass on both versions while the picture is wrong (a misspelled word is still a change).
  // Only the first run's pictures are kept, so this is a lead to look at, not a reproduced failure.
  const pic = (dir, i) => { const f = join(dir, `s${i}-after.png`); return existsSync(f) ? readFileSync(f) : null }
  const pics = rows.map(r => {
    const g = pic(goodDir, r.i), k = pic(candDir, r.i)
    if (!g || !k) return null
    const d = diff(g, k).changed, fl = floorDir && pic(floorDir, r.i) ? diff(g, pic(floorDir, r.i)).changed : 0
    return { i: r.i, g, k, d, fl, differs: aboveFloor({ changed: d }, { changed: fl }, { minPixels: 4 }) }
  })
  const first = pics.find(p => p?.differs)
  if (first) {
    counts.differs = pics.filter(p => p?.differs).length
    const r = rows[first.i]
    if (r.kind !== 'regression') {
      const n = first.i + 1, verb = r.s.action.type === 'drag' ? 'dragging' : 'clicking'
      const gH = c.artifact(`step${n}-unchanged-after.png`, first.g, 'image/png'), kH = c.artifact(`step${n}-candidate-after.png`, first.k, 'image/png'), dH = c.artifact(`step${n}-versions-diff.png`, diffImage(first.g, first.k), 'image/png')
      const later = counts.differs - 1
      c.claim('verified_fact', `Step ${n}: after ${verb} the "${r.s.label}" control, the screen on ${candRef} differs from ${goodRef} by ${first.d} pixels${floorDir ? ` (two runs of ${goodRef} differ by ${first.fl} there)` : ' (no noise floor was measured)'}. Both versions did what the rules expect, so no failure was proven, but the pictures are not the same: look at the difference. This is the first step where they differ${later ? `; ${later} later step${later === 1 ? ' also differs' : 's also differ'}, which may carry over from this one` : ''}. Compared on the first run only.`, { evidence: [gH, kH, dH, candT, goodT] })
    }
  }

  const outcome = counts.regression ? 'regression proven' : first ? 'differences found' : 'no candidate defects'
  c.event('case.closed', { outcome, bisected: false, canvas: counts })
  return { caseId, counts, ok: c.verify().ok }
}
