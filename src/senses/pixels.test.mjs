// node --test src/senses/pixels.test.mjs   (offline: synthetic images, no browser)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aboveFloor, blank, decode, diff, diffImage, emptiness, encode, noiseFloor, paint, scaleBox } from './pixels.mjs'

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255]

test('identical images differ by nothing, and a painted box is counted exactly', () => {
  const a = blank(40, 30), b = blank(40, 30)
  assert.deepEqual(diff(a, b), { sizeMismatch: false, width: 40, height: 30, total: 1200, changed: 0, ratio: 0, bbox: null, inRegion: null })
  paint(b, { x: 10, y: 5, w: 8, h: 4 }, RED)
  const d = diff(a, b)
  assert.equal(d.changed, 32); assert.deepEqual(d.bbox, { x: 10, y: 5, w: 8, h: 4 }); assert.equal(d.ratio, 32 / 1200)
})

test('PNG round trip keeps every pixel', () => {
  const a = blank(16, 16); paint(a, { x: 2, y: 2, w: 5, h: 5 }, BLUE)
  assert.equal(diff(a, decode(encode(a))).changed, 0)
  assert.equal(diff(encode(a), encode(blank(16, 16))).changed, 25) // buffers are accepted directly
})

test('tolerance ignores small colour drift but not a real change', () => {
  const a = blank(10, 10, [100, 100, 100, 255]), b = blank(10, 10, [103, 98, 100, 255])
  assert.equal(diff(a, b).changed, 100)
  assert.equal(diff(a, b, { tolerance: 3 }).changed, 0)
  paint(b, { x: 0, y: 0, w: 2, h: 2 }, [160, 100, 100, 255])
  assert.equal(diff(a, b, { tolerance: 3 }).changed, 4)
})

test('the region count covers only that box, the overall count covers all of it', () => {
  const a = blank(50, 50), b = blank(50, 50)
  paint(b, { x: 0, y: 0, w: 10, h: 10 }, RED); paint(b, { x: 30, y: 30, w: 10, h: 10 }, RED)
  const d = diff(a, b, { region: { x: 25, y: 25, w: 20, h: 20 } })
  assert.equal(d.changed, 200); assert.equal(d.inRegion, 100)
})

test('ignored boxes are skipped, for a clock or a blinking caret', () => {
  const a = blank(50, 50), b = blank(50, 50)
  paint(b, { x: 0, y: 0, w: 10, h: 10 }, RED); paint(b, { x: 30, y: 30, w: 10, h: 10 }, RED)
  const d = diff(a, b, { ignore: [{ x: 0, y: 0, w: 12, h: 12 }] })
  assert.equal(d.changed, 100); assert.deepEqual(d.bbox, { x: 30, y: 30, w: 10, h: 10 })
})

test('images of different sizes are never the same', () => {
  const d = diff(blank(10, 10), blank(10, 12))
  assert.equal(d.sizeMismatch, true); assert.equal(d.changed, 120); assert.equal(d.ratio, 1)
  assert.equal(aboveFloor(d, { changed: 5 }), true)
})

test('scaleBox converts CSS pixels to image pixels at a device scale factor', () => {
  assert.deepEqual(scaleBox({ x: 10, y: 20, w: 30, h: 5 }, 2), { x: 20, y: 40, w: 60, h: 10 })
})

test('diffImage marks changed pixels red and nothing else', () => {
  const a = blank(20, 20), b = blank(20, 20); paint(b, { x: 4, y: 4, w: 3, h: 3 }, BLUE)
  const out = decode(diffImage(a, b))
  const at = (x, y) => [...out.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 3)]
  assert.deepEqual(at(5, 5), [255, 0, 0]); assert.notDeepEqual(at(15, 15), [255, 0, 0])
})

test('noise floor is the worst pair of the same state, and needs two shots', () => {
  const clean = blank(30, 30), jitter = blank(30, 30), more = blank(30, 30)
  paint(jitter, { x: 0, y: 0, w: 3, h: 1 }, RED); paint(more, { x: 0, y: 0, w: 3, h: 1 }, RED); paint(more, { x: 10, y: 10, w: 2, h: 2 }, RED)
  const f = noiseFloor([clean, jitter, more])
  assert.equal(f.n, 3); assert.equal(f.pairs, 3); assert.equal(f.changed, 7) // clean vs more: 3 + 4
  assert.throws(() => noiseFloor([clean]), /at least 2/)
  assert.equal(noiseFloor([clean, blank(30, 30)]).changed, 0)
})

test('a difference only counts when it beats the floor by the margin', () => {
  const floor = { changed: 10 }
  assert.equal(aboveFloor({ changed: 15 }, floor), false)  // 1.5x of 10 is the limit, not above it
  assert.equal(aboveFloor({ changed: 16 }, floor), true)
  assert.equal(aboveFloor({ changed: 0 }, null), false)
  assert.equal(aboveFloor({ changed: 1 }, null), true)
  assert.equal(aboveFloor({ changed: 5 }, null, { minPixels: 20 }), false)
})

test('emptiness is 1 over background, lower over ink, and a solid colour swatch is not empty', () => {
  const a = blank(100, 100)
  assert.equal(emptiness(a, { x: 10, y: 10, w: 40, h: 40 }), 1)
  paint(a, { x: 20, y: 20, w: 20, h: 3 }, [0, 0, 0, 255]) // a line of text-like ink
  const e = emptiness(a, { x: 10, y: 10, w: 40, h: 40 })
  assert.ok(e < 0.99 && e > 0.9, `emptiness ${e}`)
  paint(a, { x: 60, y: 60, w: 30, h: 30 }, [58, 111, 209, 255]) // solid fill, no text
  assert.equal(emptiness(a, { x: 65, y: 65, w: 20, h: 20 }), 0)
  assert.equal(emptiness(a, { x: 500, y: 500, w: 5, h: 5 }), 1) // a box outside the image counts as empty
})
