// Screenshots as evidence in a release check: capture settled viewport pictures,
// compare good versus candidate, describe the result honestly, and file it.
// Run tests with: node --test src/release/shots.test.mjs
import { Session } from '../session.mjs'
import { settle } from '../senses/hands.mjs'
import { aboveFloor, diff, diffImage } from '../senses/pixels.mjs'

const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9._-]/g, '_')

/**
 * Capture settled viewport screenshots at the requested steps.
 * Step 0 is right after opening, step n is after the n-th action (1-based).
 * Only the largest requested step is reached, the rest of the actions are not run.
 */
export async function captureShots(base, actions, steps, { viewport = { width: 1280, height: 900 }, settleOptions = {} } = {}) {
  for (const s of steps) {
    if (!Number.isInteger(s) || s < 0 || s > actions.length) throw new Error(`step ${s} is outside 0..${actions.length}`)
  }
  const wanted = new Set(steps)
  const max = steps.length ? Math.max(...steps) : -1
  const out = {}
  const s = new Session(base, { viewport })
  try {
    await s.open()
    let r = await settle(s.page, settleOptions)
    if (wanted.has(0)) out[0] = r.png
    for (let i = 0; i < max; i++) {
      await s.act(actions[i])
      r = await settle(s.page, settleOptions)
      if (wanted.has(i + 1)) out[i + 1] = r.png
    }
  } finally {
    await s.close()
  }
  return out
}

/**
 * Compare two screenshots. floorPng is a second picture of the good version,
 * taken the same way, used to measure run to run noise.
 */
export function compareShots(goodPng, candPng, { floorPng = null, minPixels = 4 } = {}) {
  const d = diff(goodPng, candPng)
  const floor = floorPng ? diff(goodPng, floorPng).changed : 0
  const above = d.sizeMismatch ? true : aboveFloor({ changed: d.changed }, { changed: floor }, { minPixels })
  const diffPng = diffImage(goodPng, candPng)
  return { changed: d.changed, ratio: d.ratio, bbox: d.bbox, sizeMismatch: !!d.sizeMismatch, floor, above, diffPng }
}

/** One or two plain sentences saying what the pictures show, and no more. */
export function describeShots(c, { step, label, goodRef, candRef }) {
  if (c.sizeMismatch) {
    return `After step ${step} (${label}) a screenshot of ${candRef} and a screenshot of ${goodRef} have different sizes, so they cannot be compared pixel by pixel.`
  }
  if (c.above) {
    const b = c.bbox
    return `After step ${step} (${label}) a screenshot of ${candRef} differs from ${goodRef} by ${c.changed} pixels (the same version differs from itself by ${c.floor}), in the box x ${b.x}, y ${b.y}, ${b.w} by ${b.h}. The screen can differ for reasons unrelated to the change the test proves, so look at the difference.`
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
  return { claimId, text, above: c.above, hashes }
}
