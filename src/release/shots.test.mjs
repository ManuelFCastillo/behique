// Tests for screenshots as evidence: compare, describe, capture, record.
// Run with: node --test src/release/shots.test.mjs
import { strict as assert } from 'node:assert/strict'
import { describe, it } from 'node:test'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, paint, encode, diff } from '../senses/pixels.mjs'
import { openCase } from './evidence.mjs'
import { captureShots, compareShots, describeShots, recordShots } from './shots.mjs'

const pngOf = (image) => encode(image)

describe('compareShots and describeShots', () => {
  it('identical pictures are not above the floor', () => {
    const a = pngOf(blank(20, 20, [255, 255, 255, 255]))
    const b = pngOf(blank(20, 20, [255, 255, 255, 255]))
    const c = compareShots(a, b)
    assert.equal(c.changed, 0)
    assert.equal(c.floor, 0)
    assert.equal(c.above, false)
    assert.equal(c.sizeMismatch, false)
    assert.equal(c.bbox, null)
    assert.ok(Buffer.isBuffer(c.diffPng))
    const text = describeShots(c, { step: 1, label: 'start', goodRef: 'good', candRef: 'cand' })
    assert.match(text, /looks the same/)
    assert.match(text, /cannot be seen in a picture/)
  })

  it('a difference under the floor is not above it', () => {
    const good = blank(20, 20, [255, 255, 255, 255])
    const floorImg = blank(20, 20, [255, 255, 255, 255])
    paint(floorImg, { x: 0, y: 0, w: 5, h: 4 }, [0, 0, 0, 255])
    const cand = blank(20, 20, [255, 255, 255, 255])
    paint(cand, { x: 10, y: 10, w: 2, h: 2 }, [0, 0, 0, 255])
    const c = compareShots(pngOf(good), pngOf(cand), { floorPng: pngOf(floorImg) })
    assert.equal(c.floor, 20)
    assert.equal(c.changed, 4)
    assert.equal(c.above, false)
    const text = describeShots(c, { step: 0, label: 'open', goodRef: 'v1', candRef: 'v2' })
    assert.match(text, /looks the same/)
  })

  it('a difference over the floor names the bbox', () => {
    const good = blank(20, 20, [255, 255, 255, 255])
    const floorImg = blank(20, 20, [255, 255, 255, 255])
    paint(floorImg, { x: 0, y: 0, w: 2, h: 2 }, [0, 0, 0, 255])
    const cand = blank(20, 20, [255, 255, 255, 255])
    paint(cand, { x: 5, y: 6, w: 4, h: 2 }, [0, 0, 0, 255])
    const c = compareShots(pngOf(good), pngOf(cand), { floorPng: pngOf(floorImg) })
    assert.equal(c.floor, 4)
    assert.equal(c.changed, 8)
    assert.equal(c.above, true)
    assert.deepEqual(c.bbox, { x: 5, y: 6, w: 4, h: 2 })
    const text = describeShots(c, { step: 1, label: 'click', goodRef: 'v1', candRef: 'v2' })
    assert.equal(text, 'After step 1 (click) a screenshot of v2 differs from v1 by 8 pixels (the same version differs from itself by 4), in the box x 5, y 6, 4 by 2. The screen can differ for reasons unrelated to the change the test proves, so look at the difference.')
  })

  it('a size mismatch cannot be compared pixel by pixel', () => {
    const a = pngOf(blank(20, 20))
    const b = pngOf(blank(10, 10))
    const c = compareShots(a, b)
    assert.equal(c.sizeMismatch, true)
    assert.equal(c.above, true)
    const text = describeShots(c, { step: 2, label: 'go', goodRef: 'v1', candRef: 'v2' })
    assert.match(text, /different sizes/)
    assert.match(text, /cannot be compared pixel by pixel/)
  })
})

function startPage() {
  const parts = [
    '<!doctype html><html><body>',
    '<div id="box" style="width:100px;height:100px;background:white"></div>',
    '<button id="go">go</button>',
    '<script>',
    'document.getElementById("go").addEventListener("click", function () {',
    'document.getElementById("box").style.background = "black";',
    '});',
    '</scr' + 'ipt>',
    '</body></html>'
  ]
  const html = parts.join('')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, base: 'http://127.0.0.1:' + addr.port })
    })
  })
}

describe('captureShots', () => {
  it('captures before and after, only what was asked, and throws past the end', async () => {
    const started = await startPage()
    const server = started.server
    const base = started.base
    try {
      const actions = [{ type: 'click', selector: '#go' }]
      const opts = { viewport: { width: 400, height: 300 }, settleOptions: { stableMs: 200, pollMs: 100, maxMs: 4000 } }
      const both = await captureShots(base, actions, [0, 1], opts)
      assert.deepEqual(Object.keys(both).sort(), ['0', '1'])
      assert.ok(Buffer.isBuffer(both[0]))
      assert.ok(Buffer.isBuffer(both[1]))
      assert.ok(diff(both[0], both[1]).changed > 0)
      const only = await captureShots(base, actions, [0], opts)
      assert.deepEqual(Object.keys(only), ['0'])
      await assert.rejects(() => captureShots(base, actions, [2], opts), /outside/)
      await assert.rejects(() => captureShots(base, actions, [-1], opts), /outside/)
      const again = await captureShots(base, actions, [0], opts)
      assert.ok(Buffer.isBuffer(again[0]))
    } finally {
      server.close()
    }
  })
})

describe('recordShots', () => {
  it('writes three artifacts and one verified_fact claim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shots-'))
    const ev = openCase(dir)
    ev.event('case.opened', {
      goodRef: 'v1',
      candRef: 'v2',
      adapter: 'test',
      kind: 'test',
      steps: [],
      options: { bisect: false, runs: 1 },
      scenario: { name: 't', label: 't', about: 't', upstream: null }
    })
    const good = blank(16, 16, [255, 255, 255, 255])
    const cand = blank(16, 16, [255, 255, 255, 255])
    paint(cand, { x: 2, y: 3, w: 4, h: 2 }, [0, 0, 0, 255])
    const goodPng = pngOf(good)
    const candPng = pngOf(cand)
    const c = compareShots(goodPng, candPng)
    const expected = describeShots(c, { step: 1, label: 'pressed go', goodRef: 'v1', candRef: 'v2' })
    const res = recordShots({ ev, step: 1, label: 'pressed go', goodRef: 'v1', candRef: 'v2', goodPng, candPng })
    assert.equal(res.above, c.above)
    assert.equal(res.hashes.length, 3)
    const data = ev.read()
    const claims = data.filter((e) => e.type === 'claim')
    assert.equal(claims.length, 1)
    const field = (e, k) => e[k] ?? (e.data && e.data[k]) ?? (e.claim && e.claim[k]) ?? (e.entry && e.entry[k])
    assert.equal(field(claims[0], 'label'), 'verified_fact')
    assert.equal(field(claims[0], 'text'), expected)
    assert.deepEqual(field(claims[0], 'evidence'), res.hashes)
    ev.event('case.closed', { outcome: 'differences found' })
    assert.equal(ev.verify().ok, true)
  })
})
