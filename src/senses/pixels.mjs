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

/**
 * Is the difference inside `box` the same content moved? Slides the after image over the before image (vertical offsets up to
 * maxShift, then a small sideways correction) and counts the pixels of the box that still differ at each offset. Returns the best
 * offset ({ dx, dy }: how far the content moved on the after image), `before` (differing pixels in the box with no shift), `remaining`
 * (differing pixels at the best offset) and `newBox` (where those remaining pixels are on the after image: what is new or changed,
 * not moved), or null when no offset explains more than `minGain` of the difference with at least `minMoved` pixels. The counts are taken both ways (after against
 * before moved, and before against after moved back), so content that vanished is never reported as moved. A pixel whose source would fall outside the picture counts as
 * differing. Equality is exact: a shifted copy of a rendered page matches pixel for pixel.
 */
export function shiftMatch(a, b, { box = null, maxShift = 160, maxSideways = 8, minGain = 0.5, minMoved = 50 } = {}) {
  a = img(a); b = img(b)
  if (a.width !== b.width || a.height !== b.height) return null
  const { width, height } = a
  const r = box ?? { x: 0, y: 0, w: width, h: height }
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(width, r.x + r.w), y1 = Math.min(height, r.y + r.h)
  if (x1 <= x0 || y1 <= y0) return null
  const same = (i, j) => a.data[j] === b.data[i] && a.data[j + 1] === b.data[i + 1] && a.data[j + 2] === b.data[i + 2] && a.data[j + 3] === b.data[i + 3]
  const inside = (x, y) => x >= 0 && x < width && y >= 0 && y < height
  // Counted both ways: the box on b against a moved by (dx, dy), and the box on a against b moved back. Content that vanished would
  // otherwise look "moved" by any offset that pushes it out of the box (white against white).
  // A pixel whose counterpart falls outside the picture (content pushed past the bottom edge) is not compared; each direction's count
  // is scaled up to the whole box, and a direction that could compare less than half the box counts as all different.
  const total = (x1 - x0) * (y1 - y0)
  const count = (dx, dy, stopAt = Infinity) => {
    let f = 0, fc = 0, k = 0, kc = 0 // forward mismatches and compared pixels; backward likewise
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        if (inside(x - dx, y - dy)) { fc++; if (!same(i, ((y - dy) * width + (x - dx)) * 4)) f++ }
        if (inside(x + dx, y + dy)) { kc++; if (!same(((y + dy) * width + (x + dx)) * 4, i)) k++ }
      }
      if (f + k >= stopAt) return f + k
    }
    const scale = (m, c) => (c * 2 < total ? total : Math.round(m * total / c))
    return scale(f, fc) + scale(k, kc)
  }
  const before = count(0, 0)
  if (!before) return null
  let best = { dx: 0, dy: 0, remaining: before }
  const consider = (dx, dy) => { if (dx === 0 && dy === 0) return; const n = count(dx, dy, best.remaining); if (n < best.remaining) best = { dx, dy, remaining: n } }
  for (let d = 1; d <= maxShift; d++) { consider(0, d); consider(0, -d) }
  const dy = best.dy
  for (let d = 1; d <= maxSideways; d++) { consider(d, dy); consider(-d, dy) }
  if (best.remaining >= before * (1 - minGain) || before - best.remaining < minMoved) return null // the move must explain more than minGain of the difference, and a real number of pixels
  let nx0 = width, ny0 = height, nx1 = -1, ny1 = -1 // where the picture still differs once the moved content is lined up
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const sx = x - best.dx, sy = y - best.dy
    if (sx < 0 || sx >= width || sy < 0 || sy >= height || !same((y * width + x) * 4, (sy * width + sx) * 4)) { if (x < nx0) nx0 = x; if (x > nx1) nx1 = x; if (y < ny0) ny0 = y; if (y > ny1) ny1 = y }
  }
  return { dx: best.dx, dy: best.dy, before, remaining: best.remaining, newBox: best.remaining ? { x: nx0, y: ny0, w: nx1 - nx0 + 1, h: ny1 - ny0 + 1 } : null }
}

/**
 * A picture of the difference for the evidence tile: the after image faded, changed pixels in red. With `shift` (from shiftMatch), a
 * changed pixel that is the same content moved by that offset is blue instead, so what is new stays red.
 */
export function diffImage(a, b, { tolerance = 0, ignore = [], shift = null } = {}) {
  a = img(a); b = img(b)
  if (a.width !== b.width || a.height !== b.height) return encode(blank(b.width, b.height, [255, 0, 0, 255]))
  const out = { width: b.width, height: b.height, data: Buffer.alloc(b.data.length) }
  const { width, height } = b
  const moved = (x, y, i) => {
    if (!shift || (!shift.dx && !shift.dy)) return false
    const sx = x - shift.dx, sy = y - shift.dy
    if (sx < 0 || sx >= width || sy < 0 || sy >= height) return false
    const j = (sy * width + sx) * 4
    return a.data[j] === b.data[i] && a.data[j + 1] === b.data[i + 1] && a.data[j + 2] === b.data[i + 2] && a.data[j + 3] === b.data[i + 3]
  }
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const i = (y * b.width + x) * 4
      const hit = (Math.abs(a.data[i] - b.data[i]) > tolerance || Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance || Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance || Math.abs(a.data[i + 3] - b.data[i + 3]) > tolerance) && !ignore.some(g => inBox(x, y, g))
      if (hit) out.data.set(moved(x, y, i) ? [40, 110, 255, 255] : [255, 0, 0, 255], i)
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
