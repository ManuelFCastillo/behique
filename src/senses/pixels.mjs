// Pixels: decode, diff and noise floor. No browser, no model: every number here is a code fact.
// An image is { width, height, data } with data as RGBA bytes (what pngjs decodes to).
// Boxes are { x, y, w, h } in IMAGE pixels. The caller scales CSS pixels by the device scale factor.
import { PNG } from 'pngjs'

export const decode = png => {
  const { width, height, data } = PNG.sync.read(png)
  return { width, height, data }
}
export const encode = ({ width, height, data }) => PNG.sync.write(Object.assign(new PNG({ width, height }), { data: Buffer.from(data) }))
const img = x => (Buffer.isBuffer(x) || x instanceof Uint8Array ? decode(Buffer.from(x)) : x)

/** A blank image, for tests and masks. */
export function blank(width, height, rgba = [255, 255, 255, 255]) {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

/** Fill a box with one colour (tests). */
export function paint(image, box, rgba) {
  for (let y = Math.max(0, box.y); y < Math.min(image.height, box.y + box.h); y++)
    for (let x = Math.max(0, box.x); x < Math.min(image.width, box.x + box.w); x++) image.data.set(rgba, (y * image.width + x) * 4)
  return image
}

export const scaleBox = (b, k) => ({ x: Math.round(b.x * k), y: Math.round(b.y * k), w: Math.round(b.w * k), h: Math.round(b.h * k) })
const inBox = (x, y, b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h

/**
 * Compare two images of the same size. A pixel counts as changed when any channel differs by more than
 * `tolerance` (0 to 255). `ignore` boxes (a clock, a cursor blink) are skipped entirely. `region` only adds
 * the `inRegion` count; the overall counts always cover the whole image.
 * Different sizes are never "the same": the result says so and counts every pixel as changed.
 */
export function diff(a, b, { tolerance = 0, region = null, ignore = [] } = {}) {
  a = img(a); b = img(b)
  if (a.width !== b.width || a.height !== b.height) {
    const total = Math.max(a.width * a.height, b.width * b.height)
    return { sizeMismatch: true, width: b.width, height: b.height, total, changed: total, ratio: 1, bbox: null, inRegion: region ? total : null }
  }
  const { width, height } = a
  let changed = 0, inRegion = 0, x0 = width, y0 = height, x1 = -1, y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (Math.abs(a.data[i] - b.data[i]) <= tolerance && Math.abs(a.data[i + 1] - b.data[i + 1]) <= tolerance && Math.abs(a.data[i + 2] - b.data[i + 2]) <= tolerance && Math.abs(a.data[i + 3] - b.data[i + 3]) <= tolerance) continue
      if (ignore.length && ignore.some(g => inBox(x, y, g))) continue
      changed++
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      if (region && inBox(x, y, region)) inRegion++
    }
  }
  const total = width * height
  return { sizeMismatch: false, width, height, total, changed, ratio: changed / total, bbox: changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null, inRegion: region ? inRegion : null }
}

/** A picture of the difference for the evidence tile: the after image faded, changed pixels in red. */
export function diffImage(a, b, { tolerance = 0, ignore = [] } = {}) {
  a = img(a); b = img(b)
  if (a.width !== b.width || a.height !== b.height) return encode(blank(b.width, b.height, [255, 0, 0, 255]))
  const out = { width: b.width, height: b.height, data: Buffer.alloc(b.data.length) }
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const i = (y * b.width + x) * 4
      const hit = (Math.abs(a.data[i] - b.data[i]) > tolerance || Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance || Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance || Math.abs(a.data[i + 3] - b.data[i + 3]) > tolerance) && !ignore.some(g => inBox(x, y, g))
      if (hit) out.data.set([255, 0, 0, 255], i)
      else { const g = Math.round((b.data[i] + b.data[i + 1] + b.data[i + 2]) / 3 * 0.35 + 255 * 0.65); out.data.set([g, g, g, 255], i) }
    }
  }
  return encode(out)
}

/**
 * The noise floor: how much the SAME version differs from itself. Pass screenshots of one unchanged state
 * (taken in separate loads, or separate browsers). Every pair is diffed; the floor is the worst pair.
 * A difference between versions only counts when it is above this.
 */
export function noiseFloor(shots, opts = {}) {
  if (shots.length < 2) throw new Error('noise floor needs at least 2 screenshots of the same state')
  const imgs = shots.map(img)
  let changed = 0, ratio = 0, pairs = 0
  for (let i = 0; i < imgs.length; i++) for (let j = i + 1; j < imgs.length; j++) {
    const d = diff(imgs[i], imgs[j], opts)
    pairs++; changed = Math.max(changed, d.changed); ratio = Math.max(ratio, d.ratio)
  }
  return { n: imgs.length, pairs, changed, ratio, tolerance: opts.tolerance ?? 0 }
}

/**
 * Is a diff real? It must beat the noise floor by `margin` (default 1.5x) and be at least `minPixels`.
 * With a floor of zero any `minPixels` changed pixels count.
 */
export function aboveFloor(d, floor = null, { margin = 1.5, minPixels = 1 } = {}) {
  const limit = floor ? Math.ceil(floor.changed * margin) : 0
  return d.changed > limit && d.changed >= minPixels
}

/**
 * How empty is a box? The share of its pixels within `tolerance` of the whole image's most common colour, which on an
 * app is its background (0 to 1). Blank background is 1; a control has fill, edges or text, so it is lower. A solid
 * colour swatch is NOT empty, because its colour is not the background's. This is how code checks that a target a model
 * pointed at is not just empty canvas.
 */
export function emptiness(image, box, { tolerance = 8 } = {}) {
  image = img(image)
  const q = v => v >> 3, counts = new Map()
  for (let i = 0; i < image.data.length; i += 4 * 7) {
    const k = (q(image.data[i]) << 10) | (q(image.data[i + 1]) << 5) | q(image.data[i + 2])
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  let mode = -1, best = 0
  for (const [k, n] of counts) if (n > best) { best = n; mode = k }
  const mr = ((mode >> 10) & 31) * 8 + 4, mg = ((mode >> 5) & 31) * 8 + 4, mb = (mode & 31) * 8 + 4, t = tolerance + 4
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y), x1 = Math.min(image.width, box.x + box.w), y1 = Math.min(image.height, box.y + box.h)
  if (x1 <= x0 || y1 <= y0) return 1
  let near = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * image.width + x) * 4
    if (Math.abs(image.data[i] - mr) <= t && Math.abs(image.data[i + 1] - mg) <= t && Math.abs(image.data[i + 2] - mb) <= t) near++
  }
  return near / ((x1 - x0) * (y1 - y0))
}
