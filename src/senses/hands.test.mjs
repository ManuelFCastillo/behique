// node --test src/senses/hands.test.mjs   (launches headless Chromium against bench/fixtures/canvas-app, served in process)
// Ground truth is the fixture's own model (window.__layout / __state), read by the harness only, as in bench/canvas-bench.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright'
import { act, perform, replay, runSteps, shot } from './hands.mjs'
import { diff, noiseFloor } from './pixels.mjs'

const HTML = readFileSync(new URL('../../bench/fixtures/canvas-app/index.html', import.meta.url))
let server, url, browser, page
const sleep = ms => new Promise(r => setTimeout(r, ms))
const layout = () => page.evaluate(() => window.__layout())
const state = () => page.evaluate(() => window.__state())
const obj = async id => (await layout()).objects.find(o => o.id === id).box
const centre = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const open = async () => { await page.goto(url); await sleep(300) }
// CSS-pixel strip where the canvas draws "Status: ..." (logical 24,590 to 300,612)
const statusStrip = async () => { const l = await layout(); return { x: l.canvas.x + 20, y: l.canvas.y + 588, w: 300, h: 26 } }

before(async () => {
  server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}/`
  browser = await chromium.launch()
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })).newPage()
})
after(async () => { await browser?.close(); await new Promise(r => server?.close(r)) })

test('a click at the Start button changes the status text, and the pixels say so inside that strip', async () => {
  await open()
  const b = await obj('btn-start')
  const r = await act(page, { type: 'click_at', ...centre(b) }, { expect: { region: await statusStrip() } })
  assert.equal((await state()).status, 'playing')
  assert.equal(r.verdict, 'verified'); assert.ok(r.diff.inRegion > 50, `changed in strip: ${r.diff.inRegion}`)
  assert.deepEqual(r.pageErrors, [])
})

test('the same click is "changed_elsewhere" when the caller expected a different part of the canvas to move', async () => {
  await open()
  const l = await layout(), b = await obj('btn-stop')
  const wrong = { x: l.canvas.x + 800, y: l.canvas.y + 400, w: 100, h: 100 }
  const r = await act(page, { type: 'click_at', ...centre(b) }, { expect: { region: wrong } })
  assert.equal((await state()).status, 'stopped'); assert.equal(r.verdict, 'changed_elsewhere'); assert.equal(r.diff.inRegion, 0)
})

test('a click on empty canvas changes nothing, and an expectation of "none" is verified', async () => {
  await open()
  const l = await layout()
  const empty = { x: l.canvas.x + 700, y: l.canvas.y + 500 }
  const r1 = await act(page, { type: 'click_at', ...empty })
  assert.equal(r1.verdict, 'no_change'); assert.equal(r1.diff.changed, 0)
  const r2 = await act(page, { type: 'click_at', ...empty }, { expect: { none: true } })
  assert.equal(r2.verdict, 'verified')
  const b = await obj('btn-start')
  const r3 = await act(page, { type: 'click_at', ...centre(b) }, { expect: { none: true } })
  assert.equal(r3.verdict, 'unexpected_change')
})

test('unit coordinates (the frame vision answers in) land on the same pixel as CSS coordinates', async () => {
  await open()
  const b = await obj('toggle-sound'), c = centre(b)
  // the expected region is in the action's frame too
  const r = await act(page, { type: 'click_at', frame: 'unit', x: c.x / 1280, y: c.y / 800 }, { expect: { region: { x: b.x / 1280, y: b.y / 800, w: b.w / 1280, h: b.h / 800 } } })
  assert.equal((await state()).sound, true); assert.equal(r.verdict, 'verified')
  assert.ok(Math.abs(r.target.x - c.x) < 0.01 && Math.abs(r.target.y - c.y) < 0.01)
})

test('a drag moves the card to the cell under the drop point and the diff box covers both cells', async () => {
  await open()
  const card = await obj('card-note'), l = await layout()
  const from = centre(card), to = { x: l.canvas.x + 24 + 3 * 80 + 40, y: l.canvas.y + 330 + 1 * 80 + 40 }
  const r = await act(page, { type: 'drag', from, to })
  assert.deepEqual((await state()).card, { col: 3, row: 1 }); assert.equal(r.verdict, 'changed')
  assert.ok(r.diff.bbox.w > 64 * 2 && r.diff.bbox.h > 64 * 2 / 2, `bbox ${JSON.stringify(r.diff.bbox)}`)
})

test('a slider drag changes the value and the checkbox click redraws the tick', async () => {
  await open()
  const knob = await obj('slider-knob'), track = await obj('slider-track')
  await act(page, { type: 'drag', from: centre(knob), to: { x: track.x + track.w, y: centre(track).y } })
  assert.equal((await state()).volume, 100)
  const box = await obj('checkbox-loop')
  const r = await act(page, { type: 'click_at', ...centre(box) }, { expect: { region: { x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 } } })
  assert.equal((await state()).loop, true); assert.equal(r.verdict, 'verified')
})

test('a one-pixel-wide target still works at the 16 px settings icon', async () => {
  await open()
  const g = await obj('icon-settings')
  const r = await act(page, { type: 'click_at', ...centre(g) })
  assert.equal((await state()).settings, true); assert.equal(r.verdict, 'changed')
})

test('bad targets are refused before the mouse moves', async () => {
  await open()
  const vp = { w: 1280, h: 800, dpr: 2 }
  await assert.rejects(perform(page, { type: 'click_at', x: 2000, y: 10 }, vp), /outside the 1280x800 viewport/)
  await assert.rejects(perform(page, { type: 'click_at', frame: 'unit', x: 1.2, y: 0.5 }, vp), /between 0 and 1/)
  await assert.rejects(perform(page, { type: 'click_at', x: NaN, y: 5 }, vp), /numeric/)
  await assert.rejects(perform(page, { type: 'press' }, vp), /needs a key/)
  await assert.rejects(perform(page, { type: 'launch_missiles' }, vp), /unknown hand action/)
  assert.equal((await state()).status, 'idle')
})

test('runSteps stops at an error and keeps earlier results; a failed verdict does not stop it', async () => {
  await open()
  const b = await obj('btn-start'), l = await layout()
  const res = await runSteps(page, [
    { action: { type: 'click_at', x: l.canvas.x + 700, y: l.canvas.y + 500 }, expect: { none: true } },
    { action: { type: 'click_at', ...centre(b) }, expect: { none: true } },
    { action: { type: 'click_at', x: -5, y: 3 } },
    { action: { type: 'click_at', ...centre(b) } },
  ])
  assert.deepEqual(res.map(r => r.verdict), ['verified', 'unexpected_change', 'error'])
})

test('the same unchanged page in separate loads differs by nothing: the noise floor is zero', async () => {
  const shots = []
  for (let i = 0; i < 3; i++) { await open(); shots.push(await shot(page)) }
  const f = noiseFloor(shots)
  assert.equal(f.changed, 0)
  assert.equal(diff(shots[0], shots[1]).sizeMismatch, false)
})

test('a verified click replays the same in fresh browsers, three times', { timeout: 60000 }, async () => {
  const b = await obj('btn-start'), l = await layout()
  const steps = [
    { action: { type: 'click_at', ...centre(b) }, expect: { region: await statusStrip() } },
    { action: { type: 'click_at', x: l.canvas.x + 700, y: l.canvas.y + 500 }, expect: { none: true } },
  ]
  const r = await replay(url, steps, { runs: 3 })
  assert.equal(r.reliable, true); assert.deepEqual(r.verdicts, ['verified', 'verified'])
  assert.equal(r.runs.length, 3)
})
