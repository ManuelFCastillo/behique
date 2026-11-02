// Screenshots as evidence in a release check: capture settled viewport pictures,
// compare good versus candidate, describe the result honestly, and file it.
// Run tests with: node --test src/release/shots.test.mjs
import { Session } from '../session.mjs'
import { CANVAS_SETTLE, settle } from '../senses/hands.mjs'
import { aboveFloor, diff, diffImage, shiftMatch } from '../senses/pixels.mjs'
import { canvasHeavy, measureCanvases, pickCanvases } from './canvas-check.mjs'

const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9._-]/g, '_')

/**
 * Capture settled viewport screenshots at the requested steps.
 * Step 0 is right after opening, step n is after the n-th action (1-based).
 * Only the largest requested step is reached, the rest of the actions are not run.
 */
export async function captureShots(base, actions, steps, options = {}) {
  return (await captureShotsWithCanvases(base, actions, steps, options)).shots
}

/** The same pictures, plus the large canvases measured on the page at each wanted step: { shots: { step: png }, canvases: { step: boxes } }. */
export async function captureShotsWithCanvases(base, actions, steps, { viewport = { width: 1280, height: 900 }, settleOptions = {}, readOnly = false } = {}) {
  for (const s of steps) {
    if (!Number.isInteger(s) || s < 0 || s > actions.length) throw new Error(`step ${s} is outside 0..${actions.length}`)
  }
  const wanted = new Set(steps)
  const max = steps.length ? Math.max(...steps) : -1
  const out = {}, canvases = {}
  const s = new Session(base, { viewport, navigationTimeoutMs: 30000 })
  const measure = () => s.page.evaluate(measureCanvases).catch(() => [])
  let opts = settleOptions
  // a page that is mostly a drawn canvas gets its animation loop paused for every picture and a longer screenshot timeout
  const adapt = async () => { if (!opts.pauseFrames && canvasHeavy(await measure(), viewport)) opts = { ...settleOptions, ...CANVAS_SETTLE } }
  const take = async i => { const r = await settle(s.page, opts); out[i] = r.png; canvases[i] = pickCanvases(await measure(), viewport) }
  try {
    await s.open()
    if (readOnly) await s.ctx.route('**/*', route => (['GET', 'HEAD'].includes(route.request().method()) || s.writesAllowed ? route.continue() : route.abort())) // the same rule as the recording
    await adapt()
    if (wanted.has(0)) await take(0); else await settle(s.page, opts)
    for (let i = 0; i < max; i++) {
      await s.act(actions[i])
      await adapt()
      if (wanted.has(i + 1)) await take(i + 1); else await settle(s.page, opts)
    }
  } finally {
    await s.close()
  }
  return { shots: out, canvases }
}

/**
 * Compare two screenshots. floorPng is a second picture of the good version,
 * taken the same way, used to measure run to run noise.
 */
export function compareShots(goodPng, candPng, { floorPng = null, minPixels = 4 } = {}) {
  const d = diff(goodPng, candPng)
  const floor = floorPng ? diff(goodPng, floorPng).changed : 0
  const above = d.sizeMismatch ? true : aboveFloor({ changed: d.changed }, { changed: floor }, { minPixels })
  // A row inserted or removed moves everything under it, and a plain diff paints all of that as changed. When one offset explains
  // most of the differing box, the difference is that move plus what is left: the moved part is drawn blue, what is new stays red.
  const shift = above && !d.sizeMismatch && d.bbox ? shiftMatch(goodPng, candPng, { box: d.bbox }) : null
  const diffPng = diffImage(goodPng, candPng, { shift })
  return { changed: d.changed, ratio: d.ratio, bbox: d.bbox, sizeMismatch: !!d.sizeMismatch, floor, above, shift, diffPng }
}

const describeMove = sh => [sh.dy ? `${Math.abs(sh.dy)} pixels ${sh.dy > 0 ? 'down' : 'up'}` : null, sh.dx ? `${Math.abs(sh.dx)} pixels ${sh.dx > 0 ? 'right' : 'left'}` : null].filter(Boolean).join(' and ')

/** One or two plain sentences saying what the pictures show, and no more. */
export function describeShots(c, { step, label, goodRef, candRef }) {
  if (c.sizeMismatch) {
    return `After step ${step} (${label}) a screenshot of ${candRef} and a screenshot of ${goodRef} have different sizes, so they cannot be compared pixel by pixel.`
  }
  if (c.above) {
    const b = c.bbox, sh = c.shift
    const moved = sh ? ` Most of that is the same content moved ${describeMove(sh)}: once it is lined up, ${sh.remaining} pixel${sh.remaining === 1 ? '' : 's'} still differ${sh.newBox ? `, in the box x ${sh.newBox.x}, y ${sh.newBox.y}, ${sh.newBox.w} by ${sh.newBox.h}: that is what is new or changed` : ''}.` : ''
    return `After step ${step} (${label}) a screenshot of ${candRef} differs from ${goodRef} by ${c.changed} pixels (the same version differs from itself by ${c.floor}), in the box x ${b.x}, y ${b.y}, ${b.w} by ${b.h}.${moved} The screen can differ for reasons unrelated to the change the test proves, so look at the difference.`
  }
  return `After step ${step} (${label}) a screenshot of ${candRef} looks the same as ${goodRef} (${c.changed} pixels differ, ${c.floor} from run to run noise). A change that does not show on screen, such as a link address, cannot be seen in a picture.`
}

/**
 * File both screenshots plus their diff, then write one verified_fact claim.
 * A picture that differs is a lead for a person, never a reproduced failure.
 */
export function recordShots({ ev, step, label, goodRef, candRef, goodPng, candPng, floorPng = null }) {
  const c = compareShots(goodPng, candPng, { floorPng })
  const gName = `step${step}-${safeRef(goodRef)}-screenshot.png`
  const kName = `step${step}-${safeRef(candRef)}-screenshot.png`
  const dName = `step${step}-versions-diff.png`
  const h1 = ev.artifact(gName, Buffer.from(goodPng), 'image/png')
  const h2 = ev.artifact(kName, Buffer.from(candPng), 'image/png')
  const h3 = ev.artifact(dName, Buffer.from(c.diffPng), 'image/png')
  const hashes = [h1, h2, h3]
  const text = describeShots(c, { step, label, goodRef, candRef })
  const claimId = ev.claim('verified_fact', text, { evidence: hashes }) // the hash of the claim event
  return { claimId, text, above: c.above, shift: c.shift ? { dx: c.shift.dx, dy: c.shift.dy, remaining: c.shift.remaining, newBox: c.shift.newBox } : null, hashes }
}
