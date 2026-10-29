// node --test src/senses/canvas-qa.test.mjs   (launches Chromium, about 1 to 2 minutes; NO model calls)
// The controls are taken from the fixture's own model, as a perfect vision sense would give them, so this tests the
// hands and the rules alone: every planted bug must be found, and the clean app must produce nothing.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { VIEWPORT, explore, readingOrder, stepFor } from './canvas-qa.mjs'

const HTML = readFileSync(new URL('../../bench/fixtures/canvas-app/index.html', import.meta.url))
const BUGS = JSON.parse(readFileSync(new URL('../../bench/fixtures/canvas-app/bugs.json', import.meta.url)))
let server, base
before(async () => {
  server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML) })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}/`
})
after(() => server?.close())

/** What a perfect vision sense would propose: one control per fixture object, in unit coordinates. */
async function oracleControls() {
  const browser = await chromium.launch()
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })).newPage()
    await page.goto(base); await page.waitForTimeout(300)
    const L = await page.evaluate(() => window.__layout())
    const u = (x, y) => [x / VIEWPORT.width, y / VIEWPORT.height]
    const c = id => { const b = L.objects.find(o => o.id === id).box; return { x: b.x + b.w / 2, y: b.y + b.h / 2, b } }
    const track = L.objects.find(o => o.id === 'slider-track').box
    const out = []
    for (const o of L.objects) {
      const p = c(o.id)
      if (o.kind === 'slider-track') continue
      if (o.kind === 'slider-knob') out.push({ label: o.label, kind: 'slider', point: u(p.x, p.y), dragTo: u(track.x + track.w, track.y + track.h / 2) })
      else if (o.kind === 'card') out.push({ label: o.label, kind: 'card', point: u(p.x, p.y), dragTo: u(L.canvas.x + 24 + 3 * 80 + 40, L.canvas.y + 330 + 80 + 40) })
      else out.push({ label: o.label, kind: o.kind, point: u(p.x, p.y), objectId: o.id })
    }
    return out
  } finally { await browser.close() }
}

test('controls are ordered like reading and each kind gets its rule', () => {
  const cs = [{ label: 'b', kind: 'button', point: [0.5, 0.2] }, { label: 'a', kind: 'button', point: [0.1, 0.2] }, { label: 'top', kind: 'icon', point: [0.9, 0.05] }]
  assert.deepEqual(readingOrder(cs).map(c => c.label), ['top', 'a', 'b'])
  assert.equal(stepFor(cs[0], VIEWPORT).expect, null)
  const sw = stepFor({ label: 's', kind: 'swatch', point: [0.5, 0.5] }, VIEWPORT)
  assert.deepEqual(sw.expect.region, { x: 640 - 32, y: 400 - 32, w: 64, h: 64 })
  const sl = stepFor({ label: 'v', kind: 'slider', point: [0.2, 0.3], dragTo: [0.4, 0.3] }, VIEWPORT)
  assert.equal(sl.action.type, 'drag'); assert.deepEqual(sl.expect.region, { x: 512 - 14, y: 240 - 14, w: 28, h: 28 })
})

test('every planted bug is found on its own object and the clean app yields no finding', { timeout: 540000 }, async () => {
  const controls = await oracleControls()
  const variants = [{ id: 'clean', q: '' }, ...BUGS.map(b => ({ id: b.id, q: '?bug=' + b.id, object: b.object, detectable: b.detectable }))]
  const runs = await Promise.all(variants.map(async v => ({ v, r: await explore(base + v.q, controls, { replays: 1 }) })))
  for (const { v, r } of runs) {
    const summary = r.findings.map(f => `${f.control.label}:${f.verdict}:${f.reproduced}/${f.replays}`)
    if (v.id === 'clean') assert.deepEqual(summary, [], 'clean app must produce no finding')
    else if (v.detectable === false) assert.deepEqual(summary, [], `${v.id}: a wrong word on screen is invisible to pixel rules, so nothing is flagged (a known blind spot)`)
    else {
      const hit = r.findings.filter(f => f.control.objectId === v.object || (v.object === 'slider-knob' && f.control.kind === 'slider') || (v.object === 'card-note' && f.control.kind === 'card'))
      assert.equal(hit.length, 1, `${v.id}: found on its own object, got ${JSON.stringify(summary)}`)
      assert.equal(hit[0].reproduced, 1, `${v.id} reproduces in the replay`)
      assert.equal(r.findings.length, 1, `${v.id}: nothing else flagged, got ${JSON.stringify(summary)}`)
    }
  }
})
