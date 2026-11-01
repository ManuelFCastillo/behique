// Tests for canvas regions in the main check, offline with synthetic PNGs. No browser, no model.
// Run with: node --test src/release/canvas-check.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { blank, decode, encode, paint, scaleBox } from '../senses/pixels.mjs'
import { canvasNotice, compareCanvases, diffCanvasPng, measureCanvases, pickCanvasSteps, pickCanvases, recordCanvases } from './canvas-check.mjs'

function pngOf(image) {
  return encode(image)
}

function white(w, h) {
  return blank(w, h, [255, 255, 255, 255])
}

function fakeDoc() {
  const mkEl = ({ rect, id = '', cls = '', style = {} }) => ({
    id,
    getAttribute: (name) => (name === 'class' ? cls : null),
    getBoundingClientRect: () => ({ ...rect })
  })
  const els = [
    mkEl({ rect: { x: 10.4, y: 20.6, width: 300.2, height: 200.7 }, id: 'stage', cls: 'board' }),
    mkEl({ rect: { x: 0, y: 0, width: 100, height: 100 }, id: 'hidden', cls: '', style: { display: 'none' } }),
    mkEl({ rect: { x: 5, y: 5, width: 0, height: 50 }, id: '', cls: '' })
  ]
  const styles = new Map([
    [els[0], { display: 'block', visibility: 'visible' }],
    [els[1], { display: 'none', visibility: 'visible' }],
    [els[2], { display: 'block', visibility: 'visible' }]
  ])
  return {
    querySelectorAll: () => els,
    __styleFor: (el) => styles.get(el)
  }
}

test('measureCanvases reads rects, rounds, flags hidden and zero-size', () => {
  const doc = fakeDoc()
  globalThis.document = doc
  globalThis.getComputedStyle = (el) => doc.__styleFor(el)
  try {
    const got = measureCanvases()
    assert.equal(got.length, 3)
    assert.deepEqual(got[0], { x: 10, y: 21, w: 300, h: 201, visible: true, id: 'stage', cls: 'board' })
    assert.equal(got[1].visible, false)
    assert.equal(got[2].visible, false)
    assert.equal(got[1].id, 'hidden')
  } finally {
    delete globalThis.document
    delete globalThis.getComputedStyle
  }
})

test('measureCanvases treats visibility hidden as not visible', () => {
  const el = { id: '', getAttribute: () => '', getBoundingClientRect: () => ({ x: 0, y: 0, width: 50, height: 50 }) }
  globalThis.document = { querySelectorAll: () => [el] }
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'hidden' })
  try {
    const got = measureCanvases()
    assert.equal(got[0].visible, false)
  } finally {
    delete globalThis.document
    delete globalThis.getComputedStyle
  }
})

test('measureCanvases has no free variables', () => {
  const src = measureCanvases.toString()
  assert.ok(!src.includes('require') && !src.includes('import'))
})

test('pickCanvases clips, filters, orders, limits and labels', () => {
  const list = [
    { x: 100, y: 80, w: 800, h: 600, visible: true, id: 'stage', cls: '' },
    { x: -50, y: -20, w: 300, h: 300, visible: true, id: '', cls: '' },
    { x: 0, y: 0, w: 100, h: 100, visible: true, id: '', cls: '' },
    { x: 10, y: 10, w: 400, h: 400, visible: false, id: 'ghost', cls: '' }
  ]
  const viewport = { width: 1000, height: 700 }
  const got = pickCanvases(list, viewport)
  assert.equal(got.length, 2)
  assert.equal(got[0].label, '#stage (800x600 at 100,80)')
  assert.deepEqual([got[0].x, got[0].y, got[0].w, got[0].h], [100, 80, 800, 600])
  assert.equal(got[1].label, 'canvas 2 (250x280 at 0,0)')
  assert.deepEqual([got[1].x, got[1].y, got[1].w, got[1].h], [0, 0, 250, 280])
})

test('pickCanvases respects max and sorts by area', () => {
  const list = [
    { x: 0, y: 0, w: 300, h: 300, visible: true, id: '', cls: '' },
    { x: 0, y: 0, w: 500, h: 500, visible: true, id: '', cls: '' },
    { x: 0, y: 0, w: 400, h: 400, visible: true, id: '', cls: '' }
  ]
  const got = pickCanvases(list, { width: 2000, height: 2000 }, { max: 2 })
  assert.equal(got.length, 2)
  assert.ok(got[0].w === 500 && got[1].w === 400)
  assert.ok(got[0].label.startsWith('canvas 1'))
  assert.ok(got[1].label.startsWith('canvas 2'))
})

test('compareCanvases above when only the candidate differs', () => {
  const W = 60, H = 40
  const base = white(W, H)
  const goodA = pngOf(base)
  const goodB = pngOf(white(W, H))
  const cImg = white(W, H)
  paint(cImg, { x: 5, y: 5, w: 10, h: 10 }, [0, 0, 0, 255])
  const cand = pngOf(cImg)
  const boxes = [{ x: 5, y: 5, w: 10, h: 10, label: 'canvas 1 (10x10 at 5,5)' }]
  const [r] = compareCanvases({ goodA, goodB, cand, boxes })
  assert.equal(r.floor, 0)
  assert.equal(r.changed, 100)
  assert.equal(r.above, true)
  assert.ok(r.text.includes('100 pixels changed'))
  assert.ok(r.text.includes('a drawing a person would notice'))
})

test('compareCanvases not above when goodB differs as much (floor)', () => {
  const W = 60, H = 40
  const goodA = pngOf(white(W, H))
  const bImg = white(W, H)
  paint(bImg, { x: 5, y: 5, w: 10, h: 10 }, [0, 0, 0, 255])
  const goodB = pngOf(bImg)
  const cImg = white(W, H)
  paint(cImg, { x: 5, y: 5, w: 10, h: 10 }, [10, 10, 10, 255])
  const cand = pngOf(cImg)
  const boxes = [{ x: 5, y: 5, w: 10, h: 10, label: 'canvas 1 (10x10 at 5,5)' }]
  const [r] = compareCanvases({ goodA, goodB, cand, boxes })
  assert.equal(r.floor, 100)
  assert.equal(r.above, false)
  assert.ok(r.text.includes('no change beyond the noise floor'))
})

test('compareCanvases respects minPixels', () => {
  const W = 60, H = 40
  const goodA = pngOf(white(W, H))
  const goodB = pngOf(white(W, H))
  const cImg = white(W, H)
  paint(cImg, { x: 0, y: 0, w: 2, h: 1 }, [0, 0, 0, 255])
  const cand = pngOf(cImg)
  const boxes = [{ x: 0, y: 0, w: 20, h: 20, label: 'canvas 1 (20x20 at 0,0)' }]
  const [r] = compareCanvases({ goodA, goodB, cand, boxes, minPixels: 4 })
  assert.equal(r.changed, 2)
  assert.equal(r.above, false)
})

test('compareCanvases empty boxes and size mismatch', () => {
  const goodA = pngOf(white(10, 10))
  const goodB = pngOf(white(10, 10))
  const cand = pngOf(white(10, 10))
  assert.deepEqual(compareCanvases({ goodA, goodB, cand, boxes: [] }), [])
  const other = pngOf(white(12, 10))
  assert.throws(() => compareCanvases({ goodA, goodB, cand: other, boxes: [{ x: 0, y: 0, w: 5, h: 5, label: 'canvas 1 (5x5 at 0,0)' }] }), /the screenshots differ in size/)
})

test('compareCanvases scales boxes by dpr', () => {
  const W = 40, H = 40
  const goodA = pngOf(white(W, H))
  const goodB = pngOf(white(W, H))
  const cImg = white(W, H)
  paint(cImg, { x: 4, y: 4, w: 4, h: 4 }, [0, 0, 0, 255])
  const cand = pngOf(cImg)
  const boxes = [{ x: 2, y: 2, w: 2, h: 2, label: 'canvas 1 (2x2 at 2,2)' }]
  const [r] = compareCanvases({ goodA, goodB, cand, boxes, dpr: 2 })
  assert.equal(r.changed, 16)
  assert.equal(r.above, true)
  const region = scaleBox({ x: 2, y: 2, w: 2, h: 2 }, 2)
  assert.equal(r.ratio, 16 / (region.w * region.h))
})

test('diffCanvasPng returns the box size with changed pixels inside', () => {
  const W = 40, H = 30
  const goodA = pngOf(white(W, H))
  const cImg = white(W, H)
  paint(cImg, { x: 12, y: 8, w: 4, h: 4 }, [0, 0, 0, 255])
  const cand = pngOf(cImg)
  const box = { x: 10, y: 5, w: 10, h: 10, label: 'canvas 1 (10x10 at 10,5)' }
  const out = diffCanvasPng(goodA, cand, box)
  const img = decode(out)
  assert.equal(img.width, 10)
  assert.equal(img.height, 10)
  let red = 0
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 0) red++
  }
  assert.equal(red, 16)
})

function fakeEv() {
  const calls = { events: [], artifacts: [], claims: [] }
  return {
    calls,
    event: (type, data) => { calls.events.push({ type, data }) },
    artifact: (name, buffer, mediaType) => {
      calls.artifacts.push({ name, buffer, mediaType })
      return `hash-${calls.artifacts.length}`
    },
    claim: (label, text, { evidence }) => {
      calls.claims.push({ label, text, evidence })
      return calls.claims.length
    }
  }
}

test('recordCanvases files one event plus artifact and claim per change', () => {
  const W = 40, H = 30
  const goodA = pngOf(white(W, H))
  const goodB = pngOf(white(W, H))
  const cImg = white(W, H)
  paint(cImg, { x: 2, y: 2, w: 5, h: 5 }, [0, 0, 0, 255])
  const cand = pngOf(cImg)
  const boxes = [
    { x: 2, y: 2, w: 10, h: 10, label: 'canvas 1 (10x10 at 2,2)' },
    { x: 25, y: 15, w: 10, h: 10, label: 'canvas 2 (10x10 at 25,15)' }
  ]
  const results = compareCanvases({ goodA, goodB, cand, boxes })
  assert.equal(results[0].above, true)
  assert.equal(results[1].above, false)
  const ev = fakeEv()
  const out = recordCanvases({ ev, step: 1, label: 'open', goodRef: 'v1', candRef: 'v2', results, pngs: { goodA, cand }, dpr: 1 })
  assert.equal(out.changed, 1)
  assert.deepEqual(out.claims, [1])
  assert.equal(ev.calls.events.length, 1)
  assert.equal(ev.calls.events[0].type, 'canvas.compared')
  assert.equal(ev.calls.events[0].data.step, 1)
  assert.equal(ev.calls.events[0].data.results.length, 2)
  assert.equal(ev.calls.artifacts.length, 1)
  assert.equal(ev.calls.artifacts[0].name, 'canvas-1-1-diff.png')
  assert.equal(ev.calls.artifacts[0].mediaType, 'image/png')
  assert.equal(ev.calls.claims.length, 1)
  assert.equal(ev.calls.claims[0].label, 'verified_fact')
  assert.deepEqual(ev.calls.claims[0].evidence, ['hash-1'])
  assert.ok(ev.calls.claims[0].text.includes('At step 1 (open)'))
  assert.ok(ev.calls.claims[0].text.includes('Good: v1. Candidate: v2.'))
})

test('recordCanvases writes the event even when nothing changed', () => {
  const goodA = pngOf(white(20, 20))
  const goodB = pngOf(white(20, 20))
  const cand = pngOf(white(20, 20))
  const boxes = [{ x: 0, y: 0, w: 20, h: 20, label: 'canvas 1 (20x20 at 0,0)' }]
  const results = compareCanvases({ goodA, goodB, cand, boxes, minPixels: 1 })
  const ev = fakeEv()
  const out = recordCanvases({ ev, step: 2, label: 'idle', goodRef: 'v1', candRef: 'v2', results, pngs: { goodA, cand } })
  assert.equal(out.changed, 0)
  assert.deepEqual(out.claims, [])
  assert.equal(ev.calls.events.length, 1)
  assert.equal(ev.calls.artifacts.length, 0)
  assert.equal(ev.calls.claims.length, 0)
})

test('canvasNotice both ways', () => {
  assert.deepEqual(canvasNotice({ above: true }), { cls: 'visible', why: 'a drawing changed on the canvas' })
  assert.deepEqual(canvasNotice({ above: false }), { cls: 'churn', why: 'the canvas drawing is within its noise floor' })
})

test('pickCanvasSteps: step 0 and the last canvas step of each flow, from the @canvas facts', () => {
  const baseline = { stable: { '0|body/canvas@canvas': '800x600', '1|body/canvas@canvas': '800x600', '2|body/canvas@canvas': '800x600', '4|body/canvas@canvas': '800x600', '5|body/canvas@canvas': '800x600' }, volatile: {} }
  const actions = [{ type: 'click' }, { type: 'click' }, { type: 'goto', path: '/' }, { type: 'click' }, { type: 'click' }]
  // steps 0..2 are the first flow, step 3 is the page after `goto /`, steps 4..5 the second flow
  assert.deepEqual(pickCanvasSteps(baseline, actions), [0, 2, 5])
})

test('pickCanvasSteps: nothing without a canvas fact, volatile facts count too, capped', () => {
  assert.deepEqual(pickCanvasSteps({ stable: { '0|body/div@text': 'x' }, volatile: {} }, [{ type: 'click' }]), [])
  assert.deepEqual(pickCanvasSteps({ stable: {}, volatile: { '1|body/canvas@canvas': { a: '1x1', b: '2x2' } } }, [{ type: 'click' }]), [1])
  assert.deepEqual(pickCanvasSteps(null, null), [])
  const stable = {}, actions = []
  for (let i = 0; i < 12; i++) { stable[`${i}|c@canvas`] = '1x1'; if (i) actions.push({ type: 'goto', path: '/' }) }
  assert.equal(pickCanvasSteps({ stable, volatile: {} }, actions).length, 8)
})
