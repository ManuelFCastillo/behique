// Propose visual-check regions by boxing changed pixels. Pure PNG computation, no browser.
// Run: node --test src/release/visual/regions.test.mjs
import { decode, encode, paint } from '../../senses/pixels.mjs'

function changedAt(a, b, i, tolerance) {
  return Math.abs(a[i] - b[i]) > tolerance ||
    Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
    Math.abs(a[i + 2] - b[i + 2]) > tolerance ||
    Math.abs(a[i + 3] - b[i + 3]) > tolerance
}

/** Plain-English place of a CSS-pixel box in a CSS-pixel picture. First match wins. */
export function placeOf(box, width, height) {
  if (box.w * box.h >= 0.6 * width * height) return 'most of the page'
  if (box.x <= 2 && box.w <= 0.1 * width && box.h >= 0.5 * height) return 'left edge'
  if (box.x + box.w >= width - 2 && box.w <= 0.1 * width && box.h >= 0.5 * height) return 'right edge'
  if (box.y <= 2 && box.h <= 0.15 * height && box.w >= 0.5 * width) return 'top strip'
  if (box.y + box.h >= height - 2 && box.h <= 0.15 * height && box.w >= 0.5 * width) return 'bottom strip'
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const col = cx < width / 3 ? 0 : cx < (2 * width) / 3 ? 1 : 2
  const row = cy < height / 3 ? 0 : cy < (2 * height) / 3 ? 1 : 2
  return [
    ['top left', 'top', 'top right'],
    ['left', 'center', 'right'],
    ['bottom left', 'bottom', 'bottom right'],
  ][row][col]
}

/** Slug for a place name: lower case, non-alphanumerics become one dash. */
export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Shape stored in an app profile: only the boxes, keyed by name. */
export function toProfileRegions(regions) {
  const out = {}
  for (const r of regions) out[r.name] = { x: r.box.x, y: r.box.y, w: r.box.w, h: r.box.h }
  return out
}

/**
 * Propose regions where two pictures differ. Boxes are in CSS pixels.
 * Noise pictures show the same version as refPng; pixels that flicker there are ignored.
 */
export function proposeRegions(refPng, png, options = {}) {
  const { scale = 2, noisePngs = [], cell = 8, pad = 4, minPixels = 4, maxRegions = 6, tolerance = 0 } = options
  const a = decode(refPng)
  const b = decode(png)
  if (a.width !== b.width || a.height !== b.height) {
    return { regions: [], total: 0, sizeMismatch: true, ignored: 0 }
  }
  const width = a.width
  const height = a.height
  const cssW = width / scale
  const cssH = height / scale
  const noises = noisePngs.map(p => decode(p)).filter(n => n.width === width && n.height === height)
  const n = width * height
  const volatile = new Uint8Array(n)
  // A pixel is volatile when ref disagrees with any noise shot, or two noise shots disagree.
  for (let p = 0; p < n; p++) {
    const i = p * 4
    let v = 0
    for (const nz of noises) {
      if (changedAt(a.data, nz.data, i, tolerance)) { v = 1; break }
    }
    if (!v) {
      for (let x = 0; x < noises.length && !v; x++) {
        for (let y = x + 1; y < noises.length; y++) {
          if (changedAt(noises[x].data, noises[y].data, i, tolerance)) { v = 1; break }
        }
      }
    }
    volatile[p] = v
  }
  let ignored = 0
  for (let p = 0; p < n; p++) if (volatile[p]) ignored++
  const xs = []
  const ys = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (volatile[p]) continue
      if (changedAt(a.data, b.data, p * 4, tolerance)) { xs.push(x); ys.push(y) }
    }
  }
  const total = xs.length
  if (total === 0) return { regions: [], total: 0, sizeMismatch: false, ignored }
  // Cluster on a cell grid: a cell is on when it holds a changed pixel.
  const cellPx = Math.max(1, Math.round(cell * scale))
  const gridW = Math.ceil(width / cellPx)
  const gridH = Math.ceil(height / cellPx)
  const onSet = new Set()
  const cellOf = new Array(total)
  for (let k = 0; k < total; k++) {
    const cx = Math.floor(xs[k] / cellPx)
    const cy = Math.floor(ys[k] / cellPx)
    const key = cy * gridW + cx
    onSet.add(key)
    cellOf[k] = key
  }
  // Union-find: join cells that touch (8-way) and cells with exactly one empty cell between.
  const keys = [...onSet]
  const parent = new Map(keys.map(k => [k, k]))
  const find = k => {
    let r = k
    while (parent.get(r) !== r) r = parent.get(r)
    let c = k
    while (parent.get(c) !== r) { const nxt = parent.get(c); parent.set(c, r); c = nxt }
    return r
  }
  const keyToXY = new Map(keys.map(k => [k, { cx: k % gridW, cy: Math.floor(k / gridW) }]))
  const xyToKey = new Map(keys.map(k => [`${k % gridW},${Math.floor(k / gridW)}`, k]))
  for (const k of keys) {
    const { cx, cy } = keyToXY.get(k)
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue
        const nk = xyToKey.get(`${cx + dx},${cy + dy}`)
        if (nk === undefined) continue
        const r1 = find(k)
        const r2 = find(nk)
        if (r1 !== r2) parent.set(r1, r2)
      }
    }
  }
  const groups = new Map()
  for (let k = 0; k < total; k++) {
    const root = find(cellOf[k])
    let g = groups.get(root)
    if (!g) { g = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, changed: 0 }; groups.set(root, g) }
    const x = xs[k]
    const y = ys[k]
    if (x < g.x0) g.x0 = x
    if (y < g.y0) g.y0 = y
    if (x > g.x1) g.x1 = x
    if (y > g.y1) g.y1 = y
    g.changed++
  }
  // Box: changed-pixel bounds divided by scale, padded, clamped, snapped to whole CSS pixels.
  const boxes = [...groups.values()].map(g => {
    const gx0 = Math.max(0, g.x0 / scale - pad)
    const gy0 = Math.max(0, g.y0 / scale - pad)
    const gx1 = Math.min(cssW, (g.x1 + 1) / scale + pad)
    const gy1 = Math.min(cssH, (g.y1 + 1) / scale + pad)
    const x = Math.floor(gx0)
    const y = Math.floor(gy0)
    let x1 = Math.ceil(gx1)
    let y1 = Math.ceil(gy1)
    if (x1 < x + 1) x1 = x + 1
    if (y1 < y + 1) y1 = y + 1
    if (x1 > cssW) x1 = cssW
    if (y1 > cssH) y1 = cssH
    let w = x1 - x
    let h = y1 - y
    if (w < 1) w = 1
    if (h < 1) h = 1
    return { box: { x, y, w, h }, changed: g.changed }
  })
  // Merge padded boxes that overlap (touching counts) until none do.
  const overlaps = (r, s) =>
    !(r.box.x + r.box.w < s.box.x || s.box.x + s.box.w < r.box.x || r.box.y + r.box.h < s.box.y || s.box.y + s.box.h < r.box.y)
  let list = boxes
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!overlaps(list[i], list[j])) continue
        const x0 = Math.min(list[i].box.x, list[j].box.x)
        const y0 = Math.min(list[i].box.y, list[j].box.y)
        const x1 = Math.max(list[i].box.x + list[i].box.w, list[j].box.x + list[j].box.w)
        const y1 = Math.max(list[i].box.y + list[i].box.h, list[j].box.y + list[j].box.h)
        const next = { box: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }, changed: list[i].changed + list[j].changed }
        list = list.filter((_, k) => k !== i && k !== j)
        list.push(next)
        merged = true
        break outer
      }
    }
  }
  list.sort((r, s) => s.changed - r.changed)
  const kept = list.filter(r => r.changed >= minPixels).slice(0, maxRegions)
  const seen = new Map()
  const regions = kept.map(r => {
    const where = placeOf(r.box, cssW, cssH)
    const base = slug(where)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const name = count === 1 ? base : `${base}-${count}`
    return { name, box: r.box, changed: r.changed, share: total ? r.changed / total : 0, where }
  })
  return { regions, total, sizeMismatch: false, ignored }
}

/** Copy of the picture with each proposed box drawn as a red outline. Boxes are CSS pixels. */
export function drawProposals(png, regions, { scale = 2 } = {}) {
  const image = decode(png)
  const copy = { width: image.width, height: image.height, data: Buffer.from(image.data) }
  const red = [255, 0, 0, 255]
  const t = 3
  for (const r of regions) {
    const ix = Math.round(r.box.x * scale)
    const iy = Math.round(r.box.y * scale)
    const iw = Math.round(r.box.w * scale)
    const ih = Math.round(r.box.h * scale)
    paint(copy, { x: ix, y: iy, w: iw, h: t }, red)
    paint(copy, { x: ix, y: iy + ih - t, w: iw, h: t }, red)
    paint(copy, { x: ix, y: iy, w: t, h: ih }, red)
    paint(copy, { x: ix + iw - t, y: iy, w: t, h: ih }, red)
  }
  return encode(copy)
}
