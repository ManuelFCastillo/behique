// Hands (Márohu): coordinate actions on a page, each checked by pixels before and after. No model.
// A target comes from vision as a PROPOSAL; the verdict here comes from the pixels, never from the model.
// Coordinates are CSS pixels of the viewport unless `frame: 'unit'`, where 0 to 1 spans the viewport (the frame the
// vision sense uses). Verdicts are plain facts: verified, no_change, changed_elsewhere, unexpected_change, changed.
import { chromium } from 'playwright'
import { aboveFloor, diff, diffImage, scaleBox } from './pixels.mjs'

export const HAND_ACTIONS = ['click_at', 'double_click_at', 'hover_at', 'drag', 'press']
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function viewportInfo(page) {
  return page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }))
}

function point(p, vp, frame = 'css') {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !isFinite(p.x) || !isFinite(p.y)) throw new Error('a target needs numeric x and y')
  const x = frame === 'unit' ? p.x * vp.w : p.x, y = frame === 'unit' ? p.y * vp.h : p.y
  if (frame === 'unit' && (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) throw new Error('unit coordinates must be between 0 and 1')
  if (x < 0 || y < 0 || x > vp.w || y > vp.h) throw new Error(`target (${Math.round(x)}, ${Math.round(y)}) is outside the ${vp.w}x${vp.h} viewport`)
  return { x, y }
}

/** The screenshot used for every before/after pair: the viewport only, never a tall page (Phase 0). */
export const shot = (page, { timeout = 20000 } = {}) => page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide', timeout })

/**
 * Stop the page's animation loop: requestAnimationFrame stops scheduling, so the frame being drawn is the last one.
 * A page that redraws a full-screen canvas every frame on a software GPU (no WebGPU adapter in headless Chromium:
 * a WebGPU star map ran at about 2 frames a second) never hands the compositor a finished frame in time, and every screenshot
 * times out. Best effort: a loop that kept its own reference to requestAnimationFrame keeps running.
 */
export async function pauseFrames(page) {
  await page.evaluate(() => {
    const w = globalThis
    if (w.__behiqueRaf) return
    w.__behiqueRaf = w.requestAnimationFrame
    w.requestAnimationFrame = () => 0
  })
}

export async function resumeFrames(page) {
  await page.evaluate(() => {
    const w = globalThis
    if (!w.__behiqueRaf) return
    w.requestAnimationFrame = w.__behiqueRaf
    delete w.__behiqueRaf
  })
}

/** Settle options for a page whose viewport is mostly a drawn canvas: the loop is paused for every picture and each screenshot gets a minute. */
export const CANVAS_SETTLE = { pauseFrames: true, shotTimeoutMs: 60000 }

/**
 * Wait until the viewport stops changing: `stableMs` of identical frames (polled every `pollMs`), or `maxMs` at most.
 * A fixed sleep is a guess about how long an app animates; on a real app under load the guess is wrong often enough that
 * the same action gave different "after" pictures (Music Blocks, Phase 3 measurement). Returns the last frame.
 * With `pauseFrames` the animation loop is stopped while the pictures are taken and started again after; `shotTimeoutMs`
 * is the time one screenshot may take.
 */
export async function settle(page, { stableMs = 600, pollMs = 150, maxMs = 8000, pauseFrames: pause = false, shotTimeoutMs = 20000 } = {}) {
  const need = Math.max(1, Math.ceil(stableMs / pollMs)), t0 = Date.now()
  if (pause) await pauseFrames(page).catch(() => {})
  try {
    let last = await shot(page, { timeout: shotTimeoutMs }), same = 0
    while (Date.now() - t0 < maxMs) {
      await sleep(pollMs)
      const next = await shot(page, { timeout: shotTimeoutMs })
      if (diff(last, next).changed === 0) { if (++same >= need) return { png: next, settled: true, ms: Date.now() - t0 } } else same = 0
      last = next
    }
    return { png: last, settled: false, ms: Date.now() - t0 }
  } finally {
    if (pause) await resumeFrames(page).catch(() => {})
  }
}

/** Run the action itself, with no checks. Throws on a bad target or action. */
export async function perform(page, a, vp) {
  const frame = a.frame ?? 'css'
  switch (a.type) {
    case 'click_at': { const p = point(a, vp, frame); await page.mouse.click(p.x, p.y); return p }
    case 'double_click_at': { const p = point(a, vp, frame); await page.mouse.dblclick(p.x, p.y); return p }
    case 'hover_at': { const p = point(a, vp, frame); await page.mouse.move(p.x, p.y); return p }
    case 'drag': {
      const from = point(a.from, vp, frame), to = point(a.to, vp, frame)
      const steps = Math.max(2, Math.min(60, Math.round(a.steps ?? 12)))
      await page.mouse.move(from.x, from.y); await page.mouse.down()
      for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await sleep(8) }
      await page.mouse.up()
      return { x: to.x, y: to.y, from }
    }
    case 'press': if (typeof a.key !== 'string' || !a.key) throw new Error('press needs a key'); await page.keyboard.press(a.key); return null
    default: throw new Error('unknown hand action ' + a.type)
  }
}

/**
 * Do one action and say what the pixels did.
 *   expect: omitted           -> verdict 'changed' or 'no_change'
 *           { region }        -> 'verified' only if enough pixels changed inside the region (CSS px, or unit with frame)
 *           { none: true }    -> 'verified' only if nothing changed above the floor
 * `floor` is a noiseFloor() result; `settleMs` is the wait after the action (animations, redraw).
 * `settling` (optional, see settle()) replaces the fixed `settleMs` wait; the result's `settled` says whether the page stopped changing.
 * `guard` (optional) can refuse an action before it happens, e.g. when the target is not on a canvas.
 * Also records page errors and requests that happened during the action, as facts.
 * Returns { action, verdict, diff, region, pageErrors, requests, before, after, diffPng } (the three PNGs are Buffers).
 */
export async function act(page, a, { expect = null, floor = null, tolerance = 0, minPixels = 4, settleMs = 250, ignore = [], guard = null, settling = null } = {}) {
  const vp = await viewportInfo(page)
  // guard(page, action, viewport) may return a reason string to skip the action (nothing is clicked); the verdict is that string
  const skip = guard ? await guard(page, a, vp) : null
  if (skip) return { action: a, viewport: vp, verdict: skip, skipped: true, diff: null, pageErrors: [], requests: [] }
  const errors = [], requests = []
  const onErr = e => errors.push(String(e.message).slice(0, 160)), onReq = r => requests.push(`${r.method()} ${new URL(r.url()).pathname}`)
  page.on('pageerror', onErr); page.on('request', onReq)
  try {
    const before = await shot(page)
    const target = await perform(page, a, vp)
    let after, settled = null
    if (settling) { const r = await settle(page, settling); after = r.png; settled = r.settled } else { await sleep(settleMs); after = await shot(page) }
    const scale = vp.dpr
    const frame = a.frame ?? 'css'
    let region = null
    if (expect?.region) {
      const r = frame === 'unit' ? { x: expect.region.x * vp.w, y: expect.region.y * vp.h, w: expect.region.w * vp.w, h: expect.region.h * vp.h } : expect.region
      region = scaleBox(r, scale)
    }
    const opts = { tolerance, ignore: ignore.map(g => scaleBox(g, scale)) }
    const d = diff(before, after, { ...opts, region })
    const real = aboveFloor(d, floor, { minPixels })
    let verdict
    if (expect?.none) verdict = real ? 'unexpected_change' : 'verified'
    else if (region) verdict = !real ? 'no_change' : aboveFloor({ changed: d.inRegion }, floor, { minPixels }) ? 'verified' : 'changed_elsewhere'
    else verdict = real ? 'changed' : 'no_change'
    return {
      action: a, target, viewport: vp, verdict, settled, diff: d, region: region ? { ...region, scale } : null,
      pageErrors: errors, requests, before, after, diffPng: diffImage(before, after, opts),
    }
  } finally { page.off('pageerror', onErr); page.off('request', onReq) }
}

/** Run a list of steps `{ action, expect? }` in order. Stops at the first step that throws; a failed verdict does not stop it. */
export async function runSteps(page, steps, opts = {}) {
  const results = []
  for (const s of steps) {
    try { results.push(await act(page, s.action, { ...opts, expect: s.expect ?? null })) }
    catch (e) { results.push({ action: s.action, verdict: 'error', error: String(e.message).slice(0, 200) }); break }
  }
  return results
}

/**
 * Replay steps in a brand new browser and report the verdicts. This is how a finding is proven again: the same steps,
 * a fresh page, `runs` times. `reliable` is true only when every run produced the same verdicts.
 */
export async function replay(url, steps, { runs = 1, viewport = { width: 1280, height: 800 }, deviceScaleFactor = 2, ...opts } = {}) {
  const all = []
  for (let i = 0; i < runs; i++) {
    const browser = await chromium.launch()
    try {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor })
      const page = await ctx.newPage()
      await page.goto(url)
      await sleep(opts.loadMs ?? 400)
      const res = await runSteps(page, steps, opts)
      all.push(res.map(r => ({ verdict: r.verdict, changed: r.diff?.changed ?? null, error: r.error ?? null })))
    } finally { await browser.close() }
  }
  const key = r => r.map(x => x.verdict).join(',')
  return { runs: all, reliable: all.every(r => key(r) === key(all[0])), verdicts: all.length ? key(all[0]).split(',') : [] }
}
