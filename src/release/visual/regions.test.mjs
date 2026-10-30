// Tests for region proposals: pure PNG computation, offline.
// Run: node --test src/release/visual/regions.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { blank, decode, encode, paint } from '../../senses/pixels.mjs'
import { validateProfile } from '../onboard/profile.mjs'
import { drawProposals, placeOf, proposeRegions, slug, toProfileRegions } from './regions.mjs'

const SCALE = 2
const CSS_W = 1280
const CSS_H = 800
const IMG_W = CSS_W * SCALE
const IMG_H = CSS_H * SCALE

function baseImage() {
  return blank(IMG_W, IMG_H, [255, 255, 255, 255])
}

function pngOf(image) {
  return encode(image)
}

// Paint a CSS-pixel box onto an image (image pixels) with a colour.
function paintCss(image, box, rgba) {
  paint(image, { x: box.x * SCALE, y: box.y * SCALE, w: box.w * SCALE, h: box.h * SCALE }, rgba)
  return image
}

test('identical pictures give no regions', () => {
  const ref = pngOf(baseImage())
  const out = proposeRegions(ref, ref)
  assert.deepEqual(out.regions, [])
  assert.equal(out.total, 0)
  assert.equal(out.sizeMismatch, false)
  assert.equal(out.ignored, 0)
})

test('far left strip gives one left-edge region containing the strip', () => {
  const refImg = baseImage()
  const curImg = baseImage()
  const strip = { x: 0, y: 0, w: 7, h: 800 }
  paintCss(curImg, strip, [0, 0, 0, 255])
  const pad = 4
  const out = proposeRegions(pngOf(refImg), pngOf(curImg), { pad })
  assert.equal(out.regions.length, 1)
  const r = out.regions[0]
  assert.equal(r.name, 'left-edge')
  assert.equal(r.where, 'left edge')
  assert.ok(out.total > 0)
  assert.equal(r.changed, out.total)
  assert.ok(r.box.x <= strip.x)
  assert.ok(r.box.y <= strip.y)
  assert.ok(r.box.x + r.box.w >= strip.x + strip.w)
  assert.ok(r.box.y + r.box.h >= strip.y + strip.h)
  assert.ok(r.box.x >= strip.x - pad - 1)
  assert.ok(r.box.x + r.box.w <= strip.x + strip.w + pad + 1)
  assert.ok(Number.isInteger(r.box.x) && Number.isInteger(r.box.w))
  assert.ok(r.box.w >= 1 && r.box.h >= 1)
})

test('opposite edge strips give left-edge and right-edge ordered by size', () => {
  const refImg = baseImage()
  const curImg = baseImage()
  paintCss(curImg, { x: 0, y: 0, w: 7, h: 800 }, [0, 0, 0, 255])
  paintCss(curImg, { x: CSS_W - 20, y: 0, w: 20, h: 800 }, [0, 0, 0, 255])
  const out = proposeRegions(pngOf(refImg), pngOf(curImg))
  assert.equal(out.regions.length, 2)
  const names = out.regions.map(r => r.name).sort()
  assert.deepEqual(names, ['left-edge', 'right-edge'])
  assert.ok(out.regions[0].changed >= out.regions[1].changed)
  assert.equal(out.regions[0].name, 'right-edge')
})

test('squares closer than one empty cell join, far apart stay separate', () => {
  const cell = 8
  const cellPx = cell * SCALE
  function twoSquares(gapCells) {
    const refImg = baseImage()
    const curImg = baseImage()
    const y = 400 * SCALE
    const s = 4
    const x1 = 500 * SCALE
    const x2 = x1 + s + gapCells * cellPx
    paint(curImg, { x: x1, y, w: s, h: s }, [0, 0, 0, 255])
    paint(curImg, { x: x2, y, w: s, h: s }, [0, 0, 0, 255])
    return proposeRegions(pngOf(refImg), pngOf(curImg), { cell, pad: 1 })
  }
  assert.equal(twoSquares(1).regions.length, 1)
  assert.equal(twoSquares(3).regions.length, 2)
})

test('volatile spot is masked and counted in ignored', () => {
  const refImg = baseImage()
  const noiseImg = baseImage()
  const curImg = baseImage()
  // Volatile 10x10 image-pixel spot.
  paint(noiseImg, { x: 200, y: 200, w: 10, h: 10 }, [0, 0, 0, 255])
  // Changed area covering that spot plus more.
  paint(curImg, { x: 190, y: 190, w: 30, h: 30 }, [0, 0, 0, 255])
  const out = proposeRegions(pngOf(refImg), pngOf(curImg), { noisePngs: [pngOf(noiseImg)] })
  assert.equal(out.ignored, 100)
  assert.equal(out.total, 30 * 30 - 100)
  assert.ok(out.regions.length >= 1)
  const sum = out.regions.reduce((n, r) => n + r.changed, 0)
  assert.ok(sum <= out.total)
})

test('minPixels drops small regions but total counts them, maxRegions honoured, overlap merges', () => {
  const refImg = baseImage()
  const curImg = baseImage()
  paint(curImg, { x: 10, y: 10, w: 2, h: 2 }, [0, 0, 0, 255])
  paint(curImg, { x: 2000, y: 1000, w: 40, h: 40 }, [0, 0, 0, 255])
  const out = proposeRegions(pngOf(refImg), pngOf(curImg), { minPixels: 10 })
  assert.equal(out.total, 4 + 1600)
  assert.equal(out.regions.length, 1)
  assert.equal(out.regions[0].changed, 1600)

  // maxRegions
  const ref2 = baseImage()
  const cur2 = baseImage()
  for (let i = 0; i < 8; i++) paint(cur2, { x: 50 + i * 200, y: 100, w: 20, h: 20 }, [0, 0, 0, 255])
  const many = proposeRegions(pngOf(ref2), pngOf(cur2), { maxRegions: 3 })
  assert.ok(many.regions.length <= 3)

  // overlapping padded boxes merge: two squares whose padded boxes overlap become one
  const ref3 = baseImage()
  const cur3 = baseImage()
  paint(cur3, { x: 600, y: 600, w: 20, h: 20 }, [0, 0, 0, 255])
  paint(cur3, { x: 600 + 20 + 30, y: 600, w: 20, h: 20 }, [0, 0, 0, 255])
  const merged = proposeRegions(pngOf(ref3), pngOf(cur3), { cell: 4, pad: 30 })
  assert.equal(merged.regions.length, 1)
  assert.equal(merged.regions[0].changed, 800)
})

test('different sizes give sizeMismatch', () => {
  const a = pngOf(blank(100, 100))
  const b = pngOf(blank(120, 100))
  const out = proposeRegions(a, b)
  assert.deepEqual(out, { regions: [], total: 0, sizeMismatch: true, ignored: 0 })
})

test('placeOf covers every rule', () => {
  const W = 1280
  const H = 800
  assert.equal(placeOf({ x: 0, y: 0, w: 1280, h: 800 }, W, H), 'most of the page')
  assert.equal(placeOf({ x: 0, y: 0, w: 7, h: 800 }, W, H), 'left edge')
  assert.equal(placeOf({ x: W - 7, y: 0, w: 7, h: 800 }, W, H), 'right edge')
  assert.equal(placeOf({ x: 0, y: 0, w: 1280, h: 40 }, W, H), 'top strip')
  assert.equal(placeOf({ x: 0, y: H - 40, w: 1280, h: 40 }, W, H), 'bottom strip')
  assert.equal(placeOf({ x: 10, y: 10, w: 20, h: 20 }, W, H), 'top left')
  assert.equal(placeOf({ x: 600, y: 10, w: 20, h: 20 }, W, H), 'top')
  assert.equal(placeOf({ x: 1200, y: 10, w: 20, h: 20 }, W, H), 'top right')
  assert.equal(placeOf({ x: 10, y: 390, w: 20, h: 20 }, W, H), 'left')
  assert.equal(placeOf({ x: 630, y: 390, w: 20, h: 20 }, W, H), 'center')
  assert.equal(placeOf({ x: 1200, y: 390, w: 20, h: 20 }, W, H), 'right')
  assert.equal(placeOf({ x: 10, y: 750, w: 20, h: 20 }, W, H), 'bottom left')
  assert.equal(placeOf({ x: 630, y: 750, w: 20, h: 20 }, W, H), 'bottom')
  assert.equal(placeOf({ x: 1200, y: 750, w: 20, h: 20 }, W, H), 'bottom right')
})

test('slug and duplicate names get -2', () => {
  assert.equal(slug('left edge'), 'left-edge')
  assert.equal(slug('  Top  STRIP!! '), 'top-strip')
  const refImg = baseImage()
  const curImg = baseImage()
  // Two separate centered squares both in the center cell: same place name twice.
  paint(curImg, { x: 1200, y: 700, w: 60, h: 60 }, [0, 0, 0, 255])
  paint(curImg, { x: 1500, y: 900, w: 60, h: 60 }, [0, 0, 0, 255])
  const out = proposeRegions(pngOf(refImg), pngOf(curImg), { pad: 2 })
  assert.equal(out.regions.length, 2)
  assert.equal(out.regions[0].where, out.regions[1].where)
  assert.equal(out.regions[0].name, slug(out.regions[0].where))
  assert.equal(out.regions[1].name, `${slug(out.regions[1].where)}-2`)
  for (const r of out.regions) {
    assert.ok(r.share >= 0 && r.share <= 1)
  }
})

test('toProfileRegions output passes validateProfile', () => {
  const refImg = baseImage()
  const curImg = baseImage()
  paintCss(curImg, { x: 0, y: 0, w: 7, h: 800 }, [0, 0, 0, 255])
  const out = proposeRegions(pngOf(refImg), pngOf(curImg))
  const regions = toProfileRegions(out.regions)
  const profile = { name: 'test-app', repo: '/tmp/repo', workRoot: '/tmp/work', serve: { kind: 'static' }, regions }
  assert.deepEqual(validateProfile(profile), [])
  for (const box of Object.values(regions)) {
    assert.ok(Number.isInteger(box.x) && Number.isInteger(box.y) && Number.isInteger(box.w) && Number.isInteger(box.h))
    assert.ok(box.w >= 1 && box.h >= 1)
  }
})

test('drawProposals paints red outline and leaves input unchanged', () => {
  const refImg = baseImage()
  const curImg = baseImage()
  paintCss(curImg, { x: 100, y: 100, w: 50, h: 40 }, [0, 0, 0, 255])
  const curPng = pngOf(curImg)
  const before = Buffer.from(curPng)
  const out = proposeRegions(pngOf(refImg), curPng, { pad: 4 })
  assert.ok(out.regions.length >= 1)
  const drawn = drawProposals(curPng, out.regions, { scale: SCALE })
  assert.ok(Buffer.compare(curPng, before) === 0)
  const img = decode(drawn)
  const box = out.regions[0].box
  const ix = Math.round(box.x * SCALE)
  const iy = Math.round(box.y * SCALE)
  const i = (iy * img.width + ix) * 4
  assert.deepEqual([img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]], [255, 0, 0, 255])
  // Inside the box away from the outline keeps the old colour (white here).
  const cx = ix + Math.round((box.w * SCALE) / 2)
  const cy = iy + Math.round((box.h * SCALE) / 2)
  const j = (cy * img.width + cx) * 4
  assert.ok(!(img.data[j] === 255 && img.data[j + 1] === 0 && img.data[j + 2] === 0))
})
