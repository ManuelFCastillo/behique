// Tests for settled pictures: pure region math on synthetic PNGs, then headless Chromium on 127.0.0.1.
// Run: node --test src/release/visual/picture.test.mjs
import { strict as assert } from 'node:assert/strict'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import { chromium } from 'playwright'
import { blank, decode, diff, encode, paint } from '../../senses/pixels.mjs'
import { anchorsOk, measureFloor, pictureOf, regionReport } from './picture.mjs'

function pngOf(image) {
  return encode(image)
}

function changedBox(x, y, w, h, size = 20) {
  const ref = blank(size, size)
  const mod = blank(size, size)
  paint(mod, { x, y, w, h }, [255, 0, 0, 255])
  return { ref: pngOf(ref), mod: pngOf(mod) }
}

describe('regionReport pure', () => {
  it('counts changes only inside the region', () => {
    const { ref, mod } = changedBox(2, 2, 2, 2)
    const inside = regionReport(ref, mod, 'r', { x: 2, y: 2, w: 2, h: 2 }, { scale: 1 })
    assert.equal(inside.changed, 4)
    assert.equal(inside.inRegion, 4)
    assert.equal(inside.above, true)
    const outside = regionReport(ref, mod, 'r', { x: 10, y: 10, w: 2, h: 2 }, { scale: 1 })
    assert.equal(outside.changed, 4)
    assert.equal(outside.inRegion, 0)
    assert.equal(outside.above, false)
  })

  it('applies the 4 pixel minimum', () => {
    const { ref, mod } = changedBox(2, 2, 1, 1)
    const r = regionReport(ref, mod, 'r', { x: 2, y: 2, w: 1, h: 1 }, { scale: 1 })
    assert.equal(r.inRegion, 1)
    assert.equal(r.above, false)
  })

  it('applies the floor per region', () => {
    const { ref, mod } = changedBox(2, 2, 2, 2, 20)
    const over = regionReport(ref, mod, 'r', { x: 0, y: 0, w: 20, h: 20 }, { scale: 1, floor: null })
    assert.equal(over.above, true)
    const under = regionReport(ref, mod, 'r', { x: 0, y: 0, w: 20, h: 20 }, { scale: 1, floor: { regions: { r: 10 } } })
    assert.equal(under.above, false)
  })

  it('scales a CSS region by scale', () => {
    const { ref, mod } = changedBox(2, 2, 2, 2)
    const r = regionReport(ref, mod, 'r', { x: 1, y: 1, w: 1, h: 1 }, { scale: 2 })
    assert.equal(r.inRegion, 4)
    assert.equal(r.above, true)
    const miss = regionReport(ref, mod, 'r', { x: 5, y: 5, w: 1, h: 1 }, { scale: 2 })
    assert.equal(miss.inRegion, 0)
  })

  it('treats a size mismatch as above with the whole picture', () => {
    const ref = pngOf(blank(10, 10))
    const mod = pngOf(blank(12, 12))
    const r = regionReport(ref, mod, 'r', { x: 0, y: 0, w: 2, h: 2 }, { scale: 1 })
    assert.equal(r.above, true)
    assert.equal(r.inRegion, r.changed)
  })
})

describe('anchorsOk pure', () => {
  it('lists failing anchors', () => {
    const { ref, mod } = changedBox(2, 2, 3, 3)
    const res = anchorsOk(ref, mod, {
      hit: { x: 2, y: 2, w: 3, h: 3 },
      calm: { x: 12, y: 12, w: 3, h: 3 },
    }, { scale: 1 })
    assert.equal(res.ok, false)
    assert.deepEqual(res.failed, ['hit'])
    const clean = anchorsOk(ref, ref, { calm: { x: 12, y: 12, w: 3, h: 3 } }, { scale: 1 })
    assert.equal(clean.ok, true)
    assert.deepEqual(clean.failed, [])
  })
})

function staticHtml(extra = '') {
  return `<!doctype html><html><body style="margin:0;background:white">`
    + `<div id="box" style="position:absolute;left:20px;top:20px;width:80px;height:60px;background:rgb(0,120,200)"></div>`
    + extra
    + `</body></html>`
}

async function startLocal(routes) {
  const server = createServer((req, res) => {
    const body = routes[req.url] ?? routes['/']
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { server, base: `http://127.0.0.1:${port}` }
}

const FAST = { stableMs: 300, pollMs: 100, maxMs: 4000 }

describe('browser pictures', () => {
  it('pictureOf returns the expected size and a zero diff for an unchanged page', async () => {
    const { server, base } = await startLocal({ '/': staticHtml() })
    const browser = await chromium.launch()
    try {
      const profile = { viewport: { width: 200, height: 150, deviceScaleFactor: 2 }, setup: [], regions: {}, anchors: {}, settle: FAST }
      const a = await pictureOf(base + '/', profile, { browser })
      assert.equal(a.settled, true)
      const img = decode(a.png)
      assert.equal(img.width, 400)
      assert.equal(img.height, 300)
      const b = await pictureOf(base + '/', profile, { browser })
      assert.equal(diff(a.png, b.png).changed, 0)
    } finally {
      await browser.close()
      server.close()
    }
  })

  it('measureFloor of a static page is zero', async () => {
    const { server, base } = await startLocal({ '/': staticHtml() })
    const browser = await chromium.launch()
    try {
      const profile = {
        viewport: { width: 200, height: 150, deviceScaleFactor: 2 },
        setup: [],
        regions: { box: { x: 20, y: 20, w: 80, h: 60 } },
        anchors: { corner: { x: 120, y: 100, w: 40, h: 30 } },
        settle: FAST,
      }
      const floor = await measureFloor(base + '/', profile, { loads: 3, browser })
      assert.equal(floor.changed, 0)
      assert.equal(floor.regions.box, 0)
      assert.equal(floor.regions.corner, 0)
    } finally {
      await browser.close()
      server.close()
    }
  })

  it('a click_at setup step changes the picture', async () => {
    const html = staticHtml(`<button id="go" style="position:absolute;left:130px;top:30px;width:40px;height:20px" `
      + `onclick="document.getElementById('box').style.background='rgb(200,30,30)'">go</button>`)
    const { server, base } = await startLocal({ '/': html })
    const browser = await chromium.launch()
    try {
      const vp = { width: 200, height: 150, deviceScaleFactor: 2 }
      const plain = await pictureOf(base + '/', { viewport: vp, setup: [], settle: FAST }, { browser })
      const clicked = await pictureOf(base + '/', { viewport: vp, setup: [{ type: 'click_at', x: 140, y: 40 }], settle: FAST }, { browser })
      assert.equal(plain.settled, true)
      assert.equal(clicked.settled, true)
      assert.ok(diff(plain.png, clicked.png).changed > 0)
    } finally {
      await browser.close()
      server.close()
    }
  })

  it('blocks an external host and lists it', async () => {
    const html = staticHtml(`<img src="http://example.invalid/x.png" width="10" height="10">`)
    const { server, base } = await startLocal({ '/': html })
    const browser = await chromium.launch()
    try {
      const profile = { viewport: { width: 200, height: 150, deviceScaleFactor: 2 }, setup: [], settle: FAST }
      const r = await pictureOf(base + '/', profile, { browser })
      assert.ok(r.blocked.some(u => u.includes('example.invalid')))
    } finally {
      await browser.close()
      server.close()
    }
  })

  it('an always changing page does not settle', async () => {
    const html = `<!doctype html><html><body style="margin:0">`
      + `<div id="box" style="width:100px;height:100px;background:red"></div>`
      + `<script>setInterval(() => { const b = document.getElementById('box'); `
      + `b.style.background = b.style.background === 'red' ? 'blue' : 'red' }, 100)</script>`
      + `</body></html>`
    const { server, base } = await startLocal({ '/': html })
    const browser = await chromium.launch()
    try {
      const profile = {
        viewport: { width: 200, height: 150, deviceScaleFactor: 2 },
        setup: [],
        settle: { stableMs: 1500, pollMs: 100, maxMs: 900 },
      }
      const r = await pictureOf(base + '/', profile, { browser })
      assert.equal(r.settled, false)
    } finally {
      await browser.close()
      server.close()
    }
  })
})
