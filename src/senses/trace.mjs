// A trace is one explore() run written out step by step (every before, after and diff picture, plus the verdicts), so a page
// can show the senses working, from a saved run or live. No model calls: the controls are proposals a model made earlier.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { explore } from './canvas-qa.mjs'

/**
 * Run one variant and write `dir/s<i>-{before,after,diff}.png` and `dir/trace.json`. `onEvent` gets each step as it happens
 * ({ type: 'step', ... }), then { type: 'replays', ... } and { type: 'done', ... }.
 */
export async function traceVariant({ url, controls, dir, variant, replays = 3, onEvent = () => {} }) {
  mkdirSync(dir, { recursive: true })
  const steps = []
  const res = await explore(url, controls, {
    replays,
    onStep: async (i, step, r) => {
      const files = {}
      if (!r.skipped && r.before) for (const [n, b] of [['before', r.before], ['after', r.after], ['diff', r.diffPng]]) { files[n] = `s${i}-${n}.png`; writeFileSync(join(dir, files[n]), b) }
      const a = step.action
      const ev = {
        type: 'step', i, label: step.control.label, kind: step.control.kind,
        action: a.type === 'drag' ? { type: 'drag', from: a.from, to: a.to } : { type: a.type, x: a.x, y: a.y },
        expectRegion: step.expect?.region ?? null, verdict: r.verdict, skipped: Boolean(r.skipped), error: r.error ?? null,
        changed: r.diff?.changed ?? null, inRegion: r.diff?.inRegion ?? null, bbox: r.diff?.bbox ?? null, files: r.skipped ? null : files,
      }
      steps.push(ev); onEvent(ev)
    },
  })
  const agree = res.findings.map(f => ({ i: f.index, agree: f.reproduced, of: f.replays }))
  onEvent({ type: 'replays', agree })
  const trace = { variant, created: new Date().toISOString(), viewport: { w: 1280, h: 800 }, image: { w: 2560, h: 1600 }, proposals: controls.length, steps, findings: res.findings.map(f => f.index), replays: agree, verdicts: res.verdicts, replayVerdicts: res.replayVerdicts }
  writeFileSync(join(dir, 'trace.json'), JSON.stringify(trace, null, 1))
  onEvent({ type: 'done', findings: trace.findings, replays: agree })
  return trace
}
