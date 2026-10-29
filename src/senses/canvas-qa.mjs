// Canvas QA: turn a model's PROPOSED controls (vision.mjs) into actions, run them with the hands, and report only what
// the pixels show, then repeat the whole sequence in fresh browsers. No model calls here.
//
// What counts as a candidate defect (all decided by code, from rules per kind of control, never by the model):
//   a button was clicked and NOTHING on the canvas changed                      -> no_change
//   a switch/checkbox/swatch/icon was clicked and its own spot did not change   -> no_change or changed_elsewhere
//   a slider or card was dragged to a point and the destination did not change  -> no_change or changed_elsewhere
// A candidate is "reproduced" when the same verdict comes back in the replays. Skipped without a click: targets that are
// not on a canvas (the semantic sense's job) and targets over empty canvas (the model invented a control).
import { chromium } from 'playwright'
import { act, replay, shot } from './hands.mjs'
import { emptiness, scaleBox } from './pixels.mjs'
import { toCss } from './vision.mjs'

export const VIEWPORT = { width: 1280, height: 800 }, DPR = 2
// How far from a point a change may appear and still count as "at the control" (CSS px). It has to reach a selection ring
// drawn just outside a roughly 56 px control (a swatch's ring is 28 to 31 px from its centre) and stay short of the next
// control's ring (37 px away on the fixture's 68 px swatch grid). This is a per-app heuristic, not a law: see docs.
export const RADIUS = { self: 32, slider: 14, card: 20 }
const BLANK = 0.995 // emptiness at or above this means nothing but background around the point

/** Order controls the way a person reads: rows from the top, left to right inside a row. */
export const readingOrder = controls => [...controls].sort((a, b) => Math.round(a.point[1] / 0.04) - Math.round(b.point[1] / 0.04) || a.point[0] - b.point[0])

const box = (p, r) => ({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r })

/** One control becomes one step: the action, and what a correct app would show. */
export function stepFor(c, vp) {
  const vpi = { w: vp.width, h: vp.height }, p = toCss(c.point, vpi)
  if (c.kind === 'slider') { const to = toCss(c.dragTo, vpi); return { control: c, action: { type: 'drag', from: p, to }, expect: { region: box(to, RADIUS.slider) } } }
  if (c.kind === 'card') { const to = toCss(c.dragTo, vpi); return { control: c, action: { type: 'drag', from: p, to }, expect: { region: box(to, RADIUS.card) } } }
  if (c.kind === 'button') return { control: c, action: { type: 'click_at', ...p }, expect: null }
  return { control: c, action: { type: 'click_at', ...p }, expect: { region: box(p, RADIUS.self) } }
}

/** Refuse a click that is not a canvas control: not over a canvas, or over nothing but background. */
export async function guard(page, a, vp) {
  const at = a.type === 'drag' ? a.from : a
  const tag = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? null, [at.x, at.y])
  if (tag !== 'CANVAS') return 'skipped_not_canvas'
  const png = await shot(page)
  return emptiness(png, scaleBox(box(at, RADIUS.self), vp.dpr)) >= BLANK ? 'skipped_blank' : null
}

const FAIL = new Set(['no_change', 'changed_elsewhere'])

/** Run the steps once in a fresh browser and keep everything, including the screenshots. */
export async function runFresh(url, steps, { settleMs = 250, onStep = null } = {}) {
  const browser = await chromium.launch()
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })).newPage()
    const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)))
    await page.goto(url); await page.waitForTimeout(400)
    const results = []
    for (const s of steps) {
      try { results.push(await act(page, s.action, { expect: s.expect, guard, settleMs })) }
      catch (e) { results.push({ action: s.action, verdict: 'error', error: String(e.message).slice(0, 200) }) }
      await onStep?.(results.length - 1, s, results.at(-1))
      if (results.at(-1).verdict === 'error') break
    }
    return { results, pageErrors: errors }
  } finally { await browser.close() }
}

/**
 * Explore a url with the proposed controls. `url` must already carry any variant query. Returns the steps, the first run's
 * verdicts, and a finding for every step that failed its rule, each with how many of `replays` fresh runs agreed.
 */
export async function explore(url, controls, { replays = 3, settleMs = 250, onStep = null } = {}) {
  const steps = readingOrder(controls).map(c => stepFor(c, VIEWPORT))
  const first = await runFresh(url, steps, { settleMs, onStep })
  // the replay list is exactly the steps that ran, in order, so indexes line up
  const ran = steps.slice(0, first.results.length)
  const again = replays ? await replay(url, ran.map(s => ({ action: s.action, expect: s.expect })), { runs: replays, viewport: VIEWPORT, deviceScaleFactor: DPR, guard, settleMs }) : { runs: [] }
  const findings = [], skipped = []
  first.results.forEach((r, i) => {
    if (r.skipped) { skipped.push({ control: ran[i].control, reason: r.verdict }); return }
    if (!FAIL.has(r.verdict)) return
    const agree = again.runs.filter(run => run[i]?.verdict === r.verdict).length
    findings.push({
      index: i, control: ran[i].control, action: ran[i].action, expect: ran[i].expect, verdict: r.verdict,
      diff: { changed: r.diff.changed, inRegion: r.diff.inRegion, bbox: r.diff.bbox }, reproduced: agree, replays: again.runs.length,
      pageErrors: r.pageErrors, requests: r.requests, png: { before: r.before, after: r.after, diff: r.diffPng },
    })
  })
  return { steps: ran, verdicts: first.results.map(r => r.verdict), findings, skipped, replayVerdicts: again.runs.map(run => run.map(x => x.verdict)), pageErrors: first.pageErrors }
}
