// Canvas regions in the main check: measure canvas boxes, compare them across screenshots, file evidence.
// Run tests with: node --test src/release/canvas-check.test.mjs
import { blank, decode, diff, diffImage, encode, scaleBox } from '../senses/pixels.mjs'

/** Measured in the page via page.evaluate(measureCanvases): no free variables, only the two globals. */
export function measureCanvases() {
  const doc = globalThis.document
  const styleFor = globalThis.getComputedStyle
  const els = doc.querySelectorAll('canvas')
  const out = []
  for (let i = 0; i < els.length; i++) {
    const el = els[i]
    const r = el.getBoundingClientRect()
    const x = Math.round(r.x)
    const y = Math.round(r.y)
    const w = Math.round(r.width)
    const h = Math.round(r.height)
    let visible = true
    if (w <= 0 || h <= 0) {
      visible = false
    } else {
      const st = styleFor(el)
      if (st.display === 'none' || st.visibility === 'hidden') visible = false
    }
    let id = ''
    if (el.id) id = el.id
    let cls = ''
    if (typeof el.getAttribute === 'function') {
      cls = el.getAttribute('class') || ''
    } else if (el.className) {
      cls = String(el.className)
    }
    out.push({ x, y, w, h, visible, id, cls })
  }
  return out
}

/** Keep the large visible canvas boxes, clipped to the viewport, biggest first. */
export function pickCanvases(list, viewport, { minW = 200, minH = 150, max = 4 } = {}) {
  const kept = []
  for (const c of list) {
    if (!c.visible) continue
    const x0 = Math.max(0, c.x)
    const y0 = Math.max(0, c.y)
    const x1 = Math.min(viewport.width, c.x + c.w)
    const y1 = Math.min(viewport.height, c.y + c.h)
    const w = x1 - x0
    const h = y1 - y0
    if (w <= 0 || h <= 0) continue
    if (w < minW || h < minH) continue
    kept.push({ x: x0, y: y0, w, h, id: c.id || '' })
  }
  kept.sort((a, b) => (b.w * b.h) - (a.w * a.h))
  const sliced = kept.slice(0, max)
  return sliced.map((b, i) => {
    const name = b.id ? `#${b.id}` : `canvas ${i + 1}`
    return { x: b.x, y: b.y, w: b.w, h: b.h, label: `${name} (${b.w}x${b.h} at ${b.x},${b.y})` }
  })
}

/** Compare each canvas box across the check screenshots, using the second good shot as the noise floor. */
export function compareCanvases({ goodA, goodB, cand, boxes, dpr = 1, minPixels = 4, margin = 1.5 }) {
  if (!boxes || boxes.length === 0) return []
  const a = decode(goodA)
  const b = decode(goodB)
  const c = decode(cand)
  if (a.width !== b.width || a.height !== b.height || a.width !== c.width || a.height !== c.height) {
    throw new Error('the screenshots differ in size')
  }
  return boxes.map((box) => {
    const region = scaleBox({ x: box.x, y: box.y, w: box.w, h: box.h }, dpr)
    const floorRes = diff(goodA, goodB, { region })
    const changedRes = diff(goodA, cand, { region })
    const floor = floorRes.inRegion ?? floorRes.changed
    const changed = changedRes.inRegion ?? changedRes.changed
    const area = region.w * region.h
    const ratio = area > 0 ? changed / area : 0
    const above = changed > Math.max(minPixels, Math.ceil(floor * margin))
    const fmt = (n) => Number(n).toLocaleString('en-US')
    const text = above
      ? `${box.label}: ${fmt(changed)} pixels changed in the candidate (noise floor ${fmt(floor)}), a drawing a person would notice`
      : `${box.label}: no change beyond the noise floor (${fmt(changed)} of ${fmt(floor)} allowed)`
    return { box, label: box.label, floor, changed, ratio, above, text }
  })
}

/** The diff picture cropped to one canvas box, as a PNG buffer. */
export function diffCanvasPng(goodA, cand, box, dpr = 1) {
  const region = scaleBox({ x: box.x, y: box.y, w: box.w, h: box.h }, dpr)
  const full = decode(diffImage(goodA, cand))
  const out = blank(region.w, region.h)
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      const sx = region.x + x
      const sy = region.y + y
      if (sx < 0 || sy < 0 || sx >= full.width || sy >= full.height) continue
      const si = (sy * full.width + sx) * 4
      const di = (y * region.w + x) * 4
      out.data[di] = full.data[si]
      out.data[di + 1] = full.data[si + 1]
      out.data[di + 2] = full.data[si + 2]
      out.data[di + 3] = full.data[si + 3]
    }
  }
  return encode(out)
}

/** File the canvas verdict in the evidence case: one event always, one diff plus one claim per change. */
export function recordCanvases({ ev, step, label, goodRef, candRef, results, pngs: { goodA, cand }, dpr = 1 }) {
  ev.event('canvas.compared', {
    step,
    label,
    results: results.map((r) => ({ label: r.label, box: r.box, floor: r.floor, changed: r.changed, ratio: r.ratio, above: r.above }))
  })
  const claims = []
  let changed = 0
  let n = 0
  for (const r of results) {
    if (!r.above) continue
    changed += 1
    n += 1
    const name = `canvas-${step}-${n}-diff.png`
    const png = diffCanvasPng(goodA, cand, r.box, dpr)
    const hash = ev.artifact(name, png, 'image/png')
    const text = `At step ${step} (${label}), ${r.text}. Good: ${goodRef}. Candidate: ${candRef}.`
    const seq = ev.claim('verified_fact', text, { evidence: [hash] })
    claims.push(seq)
  }
  return { changed, claims }
}

/**
 * Which recorded steps get a canvas comparison: step 0 when it shows a canvas, and the last step of every flow that does
 * (a flow starts at a `goto /` action; step i is the page after action i - 1). The recorder marks a canvas with a fact whose
 * key ends in `@canvas`. At most `max` steps, lowest first.
 */
export function pickCanvasSteps(baseline, actions, { max = 8 } = {}) {
  const has = new Set()
  for (const key of [...Object.keys(baseline?.stable ?? {}), ...Object.keys(baseline?.volatile ?? {})]) {
    const m = key.match(/^(\d+)\|.*@canvas$/)
    if (m) has.add(Number(m[1]))
  }
  if (!has.size) return []
  const picked = new Set()
  if (has.has(0)) picked.add(0)
  let last = null
  const list = Array.isArray(actions) ? actions : []
  for (let i = 1; i <= list.length; i++) {
    const a = list[i - 1]
    if (a && a.type === 'goto' && a.path === '/' && last !== null) { picked.add(last); last = null }
    if (has.has(i)) last = i
  }
  if (last !== null) picked.add(last)
  return [...picked].sort((a, b) => a - b).slice(0, max)
}

/** How a canvas result ranks: a changed drawing is person-visible, floor noise is churn. */
export function canvasNotice(result) {
  if (result.above) return { cls: 'visible', why: 'a drawing changed on the canvas' }
  return { cls: 'churn', why: 'the canvas drawing is within its noise floor' }
}
