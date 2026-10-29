// Phase 0 of docs/canvas-senses-plan.md: can a vision model point at things on a canvas, and how well?
// Ground truth comes from the canvas fixture (bench/fixtures/canvas-app) through window.__layout(), which only this
// harness uses. Every scored call sends ONE screenshot of the public fixture to the model and nothing else.
//
//   node bench/canvas-bench.mjs --exp frames [--dry-run] [--max-cost 1.5] [--reps 1] [--frame px|k1000|unit] [--reasoning low]
//   experiments: frames | stability | notfound | tokens | small | state
//
// Costs use the same unverified third-party price as the rest of the project (src/llm.mjs); real usage tokens are logged.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chat, estCost, ENV, PROVIDERS } from '../src/llm.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_HTML = join(ROOT, 'bench/fixtures/canvas-app/index.html')
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]) }
const EXP = arg('exp', 'frames'), DRY = process.argv.includes('--dry-run'), MAX_COST = Number(arg('max-cost', 1.5)), REPS = Number(arg('reps', 1))
const MODEL = arg('model', 'meta'), REASONING = arg('reasoning', null), CONCURRENCY = Number(arg('concurrency', 2))

export const CONFIGS = [
  { id: 'c820', w: 820, h: 900, dpr: 1 },
  { id: 'c1280', w: 1280, h: 800, dpr: 1 },
  { id: 'c1920', w: 1920, h: 1080, dpr: 1 },
  { id: 'c1280x2', w: 1280, h: 800, dpr: 2 },
]
const CFG = CONFIGS.find(c => c.id === arg('cfg', 'c1280')) // screenshot size for stability, notfound and state
export const FRAMES = {
  px: 'All coordinates are in PIXELS of this image (the image exactly as you receive it), as numbers.',
  k1000: 'All coordinates are integers from 0 to 1000: x is the fraction of the image width times 1000, y is the fraction of the image height times 1000. (0,0) is the top-left corner, (1000,1000) the bottom-right.',
  unit: 'All coordinates are decimals from 0 to 1: x is the fraction of the image width, y is the fraction of the image height. (0,0) is the top-left corner, (1,1) the bottom-right.',
}
// what we ask for (description is all the model gets) -> which fixture object (or DOM element) is the truth
const SWATCH_NAMES = ['red', 'green', 'blue', 'amber', 'violet', 'teal']
export const PRESENT = [
  { key: 'start', ask: 'the "Start" button', truth: 'btn-start' },
  { key: 'stop', ask: 'the "Stop" button', truth: 'btn-stop' },
  { key: 'reset', ask: 'the "Reset" button', truth: 'btn-reset' },
  { key: 'sound', ask: 'the "Sound" toggle switch (the pill-shaped switch itself, not its label)', truth: 'toggle-sound' },
  { key: 'knob', ask: 'the round knob of the "Volume" slider', truth: 'slider-knob', small: true },
  { key: 'loop', ask: 'the small "Loop" checkbox square (not its label)', truth: 'checkbox-loop', small: true },
  { key: 'gear', ask: 'the small settings gear icon at the top right of the white canvas', truth: 'icon-settings', small: true },
  ...SWATCH_NAMES.map(n => ({ key: 'sw-' + n, ask: `the ${n} colour swatch (a rounded square)`, truth: 'swatch-' + n })),
  { key: 'card', ask: 'the yellow "Note" card', truth: 'card-note' },
  { key: 'help', ask: 'the "Help" button in the page header, above the canvas', truth: '#help' },
]
export const ABSENT = [
  { key: 'x-delete', ask: 'the "Delete" button' }, { key: 'x-save', ask: 'the "Save" icon (a floppy disk)' },
  { key: 'x-undo', ask: 'the "Undo" button' }, { key: 'x-search', ask: 'a search text box' },
  { key: 'x-progress', ask: 'a progress bar' }, { key: 'x-mute', ask: 'a checkbox labelled "Mute"' },
  { key: 'x-pause', ask: 'the "Pause" button' }, { key: 'x-menu', ask: 'a dropdown menu' },
]

// ---------- fixture + capture ----------
function serve() {
  const html = readFileSync(FIXTURE_HTML)
  return new Promise(resolve => {
    const s = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html) })
    s.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }))
  })
}
const pngSize = b => ({ W: b.readUInt32BE(16), H: b.readUInt32BE(20) })

/** One screenshot (full page, like Session.observe) plus the truth boxes in IMAGE pixels. */
async function capture(browser, base, { w, h, dpr }, { query = '', before = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })
  const page = await ctx.newPage()
  await page.goto(base + '/' + query)
  const L = await page.evaluate(() => window.__layout())
  const center = id => { const o = L.objects.find(o => o.id === id).box; return [o.x + o.w / 2, o.y + o.h / 2] }
  if (before) await before({ page, center, L })
  const L2 = await page.evaluate(() => window.__layout())
  const helpBox = await page.evaluate(() => { const r = document.getElementById('help').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } })
  const state = await page.evaluate(() => window.__state())
  const png = await page.screenshot({ fullPage: true })
  const truth = {}
  for (const o of L2.objects) truth[o.id] = o.box
  truth['#help'] = helpBox
  const markerBox = await page.evaluate(() => { const m = document.getElementById('marker'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } })
  if (markerBox) truth['#marker'] = markerBox
  for (const k of Object.keys(truth)) truth[k] = { x: truth[k].x * dpr, y: truth[k].y * dpr, w: truth[k].w * dpr, h: truth[k].h * dpr }
  await ctx.close()
  return { png, ...pngSize(png), dpr, truth, state, cfg: { w, h, dpr } }
}

// ---------- prompt + parse + score ----------
function locatePrompt({ W, H }, frame, items) {
  return [
    `You are shown a screenshot of a web page. It is ${W} pixels wide and ${H} pixels tall. The origin (0,0) is its top-left corner.`,
    'Locate each object listed below. For each one give the CENTER point and the BOUNDING BOX of the object.',
    FRAMES[frame],
    'Reply with ONE JSON object and nothing else, in this shape:',
    '{"targets":[{"key":"<key from the list>","found":true,"point":[x,y],"box":[x1,y1,x2,y2],"confidence":0.0}]}',
    '"confidence" is your own estimate from 0 to 1 that the point is on the object. If an object is not visible in the screenshot, return {"key":"...","found":false} with no point and no box. Never guess a position for something you cannot see.',
    'Objects:', ...items.map(t => `- ${t.key}: ${t.ask}`),
  ].join('\n')
}
function parseJson(text) {
  const t = String(text ?? ''), fence = t.match(/```(?:json)?\s*([\s\S]*?)```/), src = fence ? fence[1] : t, start = src.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true; else if (c === '{') depth++
    else if (c === '}' && --depth === 0) { try { return JSON.parse(src.slice(start, i + 1)) } catch { return null } }
  }
  return null
}
const toPx = (v, frame, W, H) => frame === 'px' ? v : frame === 'k1000' ? [v[0] * W / 1000, v[1] * H / 1000] : [v[0] * W, v[1] * H]
const boxToPx = (b, frame, W, H) => { const p1 = toPx([b[0], b[1]], frame, W, H), p2 = toPx([b[2], b[3]], frame, W, H); return [p1[0], p1[1], p2[0], p2[1]] }
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
const num = v => Array.isArray(v) && v.length >= 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))

/** Score one answer against the truth. errCss is the distance from the returned point to the object's center, in CSS px. */
function scoreAnswer(parsed, frame, cap, items) {
  const byKey = new Map((parsed?.targets ?? []).map(t => [t?.key, t]))
  return items.map(it => {
    const t = byKey.get(it.key), res = { key: it.key, present: Boolean(it.truth), answered: Boolean(t), found: t?.found === true, conf: typeof t?.confidence === 'number' ? t.confidence : null }
    if (!it.truth) return res
    const b = cap.truth[it.truth]
    if (!res.found || !num(t.point)) return res
    const [px, py] = toPx(t.point, frame, cap.W, cap.H), cx = b.x + b.w / 2, cy = b.y + b.h / 2
    res.px = [Math.round(px), Math.round(py)]; res.errCss = Math.hypot(px - cx, py - cy) / cap.dpr
    res.hit = px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h
    res.ratio = [px / cx, py / cy]
    if (Array.isArray(t.box) && t.box.length === 4 && t.box.every(Number.isFinite)) {
      const [x1, y1, x2, y2] = boxToPx(t.box, frame, cap.W, cap.H), ix = Math.max(0, Math.min(x2, b.x + b.w) - Math.max(x1, b.x)), iy = Math.max(0, Math.min(y2, b.y + b.h) - Math.max(y1, b.y))
      const inter = ix * iy, uni = (x2 - x1) * (y2 - y1) + b.w * b.h - inter
      res.iou = uni > 0 ? inter / uni : 0
    }
    return res
  })
}
function summarize(rows) {
  const present = rows.filter(r => r.present), absent = rows.filter(r => !r.present)
  const f = present.filter(r => r.found && r.px)
  return {
    n: present.length, foundRate: present.length ? f.length / present.length : null,
    hitRate: present.length ? present.filter(r => r.hit).length / present.length : null,
    within15: present.length ? present.filter(r => r.errCss != null && r.errCss <= 15).length / present.length : null,
    medianErrCss: median(f.map(r => r.errCss)), meanIou: f.length ? f.filter(r => r.iou != null).reduce((s, r) => s + r.iou, 0) / Math.max(1, f.filter(r => r.iou != null).length) : null,
    absentN: absent.length, falsePositives: absent.filter(r => r.found).length,
  }
}

// ---------- model call with cost accounting ----------
const spend = { pt: 0, ct: 0, calls: 0, cost: 0 }
async function ask(png, text, extra = {}) {
  if (spend.cost >= MAX_COST) throw new Error(`cost cap reached ($${spend.cost.toFixed(3)} >= $${MAX_COST})`)
  const content = [{ type: 'text', text }]
  for (const p of [].concat(png ?? [])) content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + p.toString('base64') } })
  const r = await chat(MODEL, [{ role: 'user', content }], { maxTokens: 8000, reasoning: REASONING && REASONING !== true ? REASONING : null, ...extra })
  spend.pt += r.pt; spend.ct += r.ct; spend.calls++; spend.cost = estCost(spend.pt, spend.ct)
  return r
}
async function pool(jobs, n) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const k = i++; out[k] = await jobs[k]() } })); return out }

// ---------- experiments ----------
const RUN_DIR = join(ROOT, 'bench/canvas-runs', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + EXP)
const log = []
const save = (name, data) => { mkdirSync(RUN_DIR, { recursive: true }); writeFileSync(join(RUN_DIR, name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 1)) }

async function locateCall(cap, frame, items, label, rep = 0) {
  const text = locatePrompt(cap, frame, items)
  const r = await ask(cap.png, text)
  const parsed = parseJson(r.text), rows = scoreAnswer(parsed, frame, cap, items)
  const entry = { exp: EXP, label, frame, rep, size: `${cap.W}x${cap.H}`, dpr: cap.dpr, pt: r.pt, ct: r.ct, rt: r.rt, ms: r.ms, finish: r.finish, parsed: Boolean(parsed), rows, summary: { ...summarize(rows), truncated: r.finish === 'length', parseFailed: !parsed, ct: r.ct, rt: r.rt }, raw: r.text }
  log.push(entry); return entry
}
const fmt = s => `hit ${(s.hitRate * 100).toFixed(0)}%  within15px ${(s.within15 * 100).toFixed(0)}%  found ${(s.foundRate * 100).toFixed(0)}%  medianErr ${s.medianErrCss == null ? 'n/a' : s.medianErrCss.toFixed(1)}px  IoU ${s.meanIou == null ? 'n/a' : s.meanIou.toFixed(2)}  falsePos ${s.falsePositives}/${s.absentN}  out ${s.ct ?? '?'}tok (reasoning ${s.rt ?? '?'})${s.truncated ? '  TRUNCATED' : ''}${s.parseFailed ? '  PARSE-FAILED' : ''}`

async function main() {
  const planned = { frames: CONFIGS.length * Object.keys(FRAMES).length * REPS, stability: 5 * REPS, notfound: 3 + ABSENT.length, tokens: CONFIGS.length + 3, diff2: 8, mb: 2 * REPS, mbblocks: 4 * REPS, tall: 12, small: 3 * 2 * 2 + 2, state: 12 }[EXP]
  const proj = planned * estCost(3500, 1100)
  console.log(`experiment ${EXP}: ${planned} model calls planned. Projection (assumes about 3,500 input and 1,100 output tokens per call; image token cost is UNKNOWN until the tokens experiment): about $${proj.toFixed(2)}. Cap $${MAX_COST}.`)
  if (DRY) { console.log('dry run: nothing sent.'); return }
  if (!ENV[PROVIDERS[MODEL].keyEnv]) throw new Error(`${PROVIDERS[MODEL].keyEnv} is empty (put it in .env)`)
  const fx = await serve(), browser = await chromium.launch()
  try {
    if (EXP === 'frames') {
      const jobs = []
      for (const cfg of CONFIGS) { const cap = await capture(browser, fx.base, cfg); save(`${cfg.id}.png`, cap.png); for (const frame of Object.keys(FRAMES)) for (let rep = 0; rep < REPS; rep++) jobs.push(() => locateCall(cap, frame, PRESENT, cfg.id, rep).then(e => console.log(`${cfg.id} ${frame.padEnd(5)} ${e.size}: ${fmt(e.summary)}`))) }
      await pool(jobs, CONCURRENCY)
    } else if (EXP === 'stability') {
      const frame = arg('frame', 'unit'), cap = await capture(browser, fx.base, CFG); save('shot.png', cap.png)
      await pool(Array.from({ length: 5 * REPS }, (_, rep) => () => locateCall(cap, frame, PRESENT, 'c1280', rep).then(e => console.log(`rep ${rep}: ${fmt(e.summary)}`))), CONCURRENCY)
    } else if (EXP === 'notfound') {
      const frame = arg('frame', 'unit'), cap = await capture(browser, fx.base, CFG); save('shot.png', cap.png)
      const jobs = [0, 1, 2].map(rep => () => locateCall(cap, frame, [...PRESENT, ...ABSENT], 'mixed', rep).then(e => console.log(`mixed rep ${rep}: ${fmt(e.summary)}`)))
      for (const a of ABSENT) jobs.push(() => locateCall(cap, frame, [a], 'single-absent').then(e => console.log(`single ${a.key}: invented=${e.rows[0].found}`)))
      await pool(jobs, CONCURRENCY)
    } else if (EXP === 'tokens') {
      const t = x => ask(x.png, 'Reply with the single word OK.').then(r => { const e = { label: x.label, size: x.size, pt: r.pt, ct: r.ct }; log.push(e); console.log(`${x.label.padEnd(14)} ${String(x.size).padEnd(10)} prompt_tokens ${r.pt}`) })
      const base = await ask(null, 'Reply with the single word OK.'); log.push({ label: 'text-only', pt: base.pt, ct: base.ct }); console.log(`text-only      prompt_tokens ${base.pt}`)
      for (const cfg of CONFIGS) { const cap = await capture(browser, fx.base, cfg); await t({ png: cap.png, label: cfg.id, size: `${cap.W}x${cap.H}` }) }
      const tall = await capture(browser, fx.base, CONFIGS[0], { query: '?pad=3000' }); save('tall.png', tall.png); await t({ png: tall.png, label: 'tall-820', size: `${tall.W}x${tall.H}` })
      const q = await ask(tall.png, `This screenshot is ${tall.W} pixels wide and ${tall.H} pixels tall. Find the text "BOTTOM MARKER". Reply with only JSON: {"found":true|false,"point":[x,y]} with x,y in pixels of this image.`)
      log.push({ label: 'tall-marker', raw: q.text, imageH: tall.H }); console.log(`tall marker answer: ${q.text.slice(0, 120)} (image is ${tall.W}x${tall.H}; marker is near the bottom)`)
    } else if (EXP === 'mb') {
      // Real app: Music Blocks toolbar icons, truth from their DOM boxes. --mb 3.7.1=http://127.0.0.1:8804,3.8.0=http://127.0.0.1:8803
      const ICONS = [
        { key: 'play', dom: 'play_circle_filled', ask: 'the white circular Play button with a triangle, at the far left of the blue top toolbar' },
        { key: 'stop', dom: 'stop', ask: 'the white square Stop button in the blue top toolbar' },
        { key: 'fullscreen', dom: 'fullscreen', ask: 'the fullscreen icon (four corner brackets) in the top toolbar' },
        { key: 'new', dom: 'note_add', ask: 'the "new project" icon (a document with a plus sign) in the top toolbar' },
        { key: 'folder', dom: 'folder', ask: 'the folder icon in the top toolbar' },
        { key: 'save', dom: 'save_alt', ask: 'the save icon (a tray with a downward arrow) in the top toolbar' },
        { key: 'globe', dom: 'public', ask: 'the globe icon in the top toolbar' },
        { key: 'menu', dom: 'menu', ask: 'the menu icon (three horizontal lines) in the top toolbar' },
        { key: 'help', dom: 'help', ask: 'the white circular question mark Help icon at the far right of the top toolbar' },
      ]
      for (const spec of String(arg('mb', '')).split(',').filter(Boolean)) {
        const [ver, url] = spec.split('=')
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }), page = await ctx.newPage()
        await page.goto(url + '/', { waitUntil: 'load' }); await page.waitForTimeout(6000)
        for (const closer of [page.getByRole('button', { name: 'Close window' }), page.locator('button:has-text("×")')]) { try { await closer.first().click({ timeout: 2500 }); break } catch {} }
        await page.waitForTimeout(1500)
        const boxes = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('nav li')].filter(e => e.getBoundingClientRect().width > 0 && e.textContent.trim()).map(e => { const r = e.getBoundingClientRect(); return [e.textContent.trim().split(/\s+/)[0], { x: r.x, y: r.y, w: r.width, h: r.height }] })))
        const png = await page.screenshot({ fullPage: false }); save(`mb-${ver}.png`, png)
        const cap = { png, ...pngSize(png), dpr: 2, truth: Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, { x: b.x * 2, y: b.y * 2, w: b.w * 2, h: b.h * 2 }])) }
        const items = ICONS.map(i => ({ key: i.key, ask: i.ask, truth: cap.truth[i.dom] ? i.dom : undefined }))
        const present = items.filter(i => i.truth).map(i => i.key), absent = items.filter(i => !i.truth).map(i => i.key)
        console.log(`v${ver}: toolbar icons in the DOM: ${Object.keys(boxes).join(', ')} | asked for absent: ${absent.join(', ') || 'none'}`)
        for (let rep = 0; rep < REPS; rep++) { const e = await locateCall(cap, arg('frame', 'unit'), items, 'mb-' + ver, rep); console.log(`v${ver} rep ${rep}: ${fmt(e.summary)}  invented: ${e.rows.filter(r => !r.present && r.found).map(r => r.key).join(',') || 'none'}`) }
        await ctx.close()
      }
    } else if (EXP === 'mbblocks') {
      // Real canvas content: load examples/pi.tb into Music Blocks, take block boxes from the app's own model (verified against an overlay once).
      const BLOCKS = [
        { key: 'emptyheap', name: 'emptyHeap', ask: 'the brown "empty heap" block, near the top of the left-hand stack of blocks' },
        { key: 'loadheap', name: 'loadHeap', ask: 'the grey "load heap" block in the left-hand stack' },
        { key: 'openfile', name: 'loadFile', ask: 'the red "open file" block attached to the right of "load heap"' },
        { key: 'storein', name: 'storein', ask: 'the orange-yellow "store in" block in the left-hand stack (its left part, with the label "store in")' },
        { key: 'counter', name: 'text', ask: 'the red block that says "counter", in the left-hand stack' },
        { key: 'zero', name: 'number', ask: 'the pink block that contains the number 0, in the left-hand stack' },
        { key: 'action', name: 'nameddo', ask: 'the yellow "action" block at the bottom of the left-hand stack' },
        { key: 'x-delete', ask: 'a "Delete" button' }, { key: 'x-pause', ask: 'a "Pause" icon' },
      ]
      for (const spec of String(arg('mb', '')).split(',').filter(Boolean)) {
        const [ver, url] = spec.split('=')
        for (const dpr of [1, 2]) {
          const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr }), page = await ctx.newPage()
          await page.goto(url + '/', { waitUntil: 'load' }); await page.waitForTimeout(6000)
          for (const closer of [page.getByRole('button', { name: 'Close window' }), page.locator('button:has-text("×")')]) { try { await closer.first().click({ timeout: 2500 }); break } catch {} }
          await page.waitForTimeout(800)
          const boxes = await page.evaluate(async () => {
            const a = window.ActivityContext?.getActivity?.() ?? window.activity
            a.blocks.loadNewBlocks(JSON.parse(await (await fetch('/examples/pi.tb')).text()))
            await new Promise(r => setTimeout(r, 2500))
            const canvas = document.getElementById('canvas'), ratio = canvas.width / canvas.getBoundingClientRect().width, out = {}
            for (const b of a.blocks.blockList) {
              if (b.trash || !b.container?.visible) continue
              const p = b.container.localToGlobal(0, 0)
              if (p.x < 100 || p.x > 420) continue
              const label = (b.value ?? '') + ''
              const k = b.name + (b.name === 'text' || b.name === 'number' ? ':' + label : '')
              out[k] = { x: p.x / ratio, y: p.y / ratio, w: b.width / ratio, h: b.height / ratio }
            }
            return out
          })
          const png = await page.screenshot({ fullPage: false }); save(`mbblocks-${ver}-x${dpr}.png`, png)
          const truth = {}, items = BLOCKS.map(b => {
            const k = b.name === 'text' ? 'text:counter' : b.name === 'number' ? 'number:0' : b.name
            if (b.name && boxes[k]) { truth[b.key] = { x: boxes[k].x * dpr, y: boxes[k].y * dpr, w: boxes[k].w * dpr, h: boxes[k].h * dpr }; return { key: b.key, ask: b.ask, truth: b.key } }
            return { key: b.key, ask: b.ask, truth: undefined, missingInModel: Boolean(b.name) }
          })
          const cap = { png, ...pngSize(png), dpr, truth }
          console.log(`v${ver} dpr${dpr} image ${cap.W}x${cap.H}: truth for ${items.filter(i => i.truth).map(i => i.key).join(',')}${items.some(i => i.missingInModel) ? ' | MISSING in model: ' + items.filter(i => i.missingInModel).map(i => i.key).join(',') : ''}`)
          for (let rep = 0; rep < REPS; rep++) { const e = await locateCall(cap, arg('frame', 'unit'), items.filter(i => !i.missingInModel), `mbblocks-${ver}-x${dpr}`, rep); console.log(`  rep ${rep}: ${fmt(e.summary)}  misses: ${e.rows.filter(r => r.present && !r.hit).map(r => r.key + (r.errCss != null ? '(' + r.errCss.toFixed(0) + 'px)' : '(not found)')).join(' ') || 'none'}  invented: ${e.rows.filter(r => !r.present && r.found).map(r => r.key).join(',') || 'none'}`) }
          await ctx.close()
        }
      }
    } else if (EXP === 'diff2') {
      // Two screenshots in one request: can the model list what changed? Four real changes (sound toggle, loop checkbox, amber swatch, status text) versus an identical pair.
      const cfg = CONFIGS[3], A = await capture(browser, fx.base, cfg)
      const B = await capture(browser, fx.base, cfg, { before: async ({ page, center }) => { for (const id of ['toggle-sound', 'checkbox-loop', 'swatch-amber', 'btn-start']) { const [x, y] = center(id); await page.mouse.click(x, y) } } })
      save('A.png', A.png); save('B.png', B.png)
      const prompt = 'Two screenshots of the same page follow: first image A (before), then image B (after). List EVERY visible difference between A and B. Reply with ONE JSON object only: {"differences":[{"what":"<short description of what changed>","point":[x,y]}]} with point as decimals 0 to 1 (fraction of image width and height, origin top-left) in image B. If the images are identical, reply {"differences":[]}.'
      const KEYS = { toggle: /sound|toggle|switch/i, loop: /loop|checkbox|check/i, swatch: /amber|swatch|colou?r|yellow|orange/i, status: /status|playing|idle/i }
      const jobs = []
      for (let rep = 0; rep < 5; rep++) jobs.push(async () => { const r = await ask([A.png, B.png], prompt), p = parseJson(r.text), d = (p?.differences ?? []).map(x => String(x.what)), got = Object.fromEntries(Object.entries(KEYS).map(([k, re]) => [k, d.some(t => re.test(t))])); const matched = new Set(); d.forEach((t, i) => { if (Object.values(KEYS).some(re => re.test(t))) matched.add(i) }); log.push({ label: 'diff2-changed', rep, got, listed: d.length, extra: d.length - matched.size, answer: d, pt: r.pt, ct: r.ct }); console.log(`changed pair rep ${rep}: found ${JSON.stringify(got)}  listed ${d.length}, not matching any real change: ${d.length - matched.size}`) })
      for (let rep = 0; rep < 3; rep++) jobs.push(async () => { const r = await ask([A.png, A.png], prompt), p = parseJson(r.text), d = p?.differences ?? []; log.push({ label: 'diff2-identical', rep, listed: d.length, answer: d, pt: r.pt, ct: r.ct }); console.log(`identical pair rep ${rep}: listed ${d.length} difference(s)${d.length ? ': ' + JSON.stringify(d).slice(0, 120) : ''}`) })
      await pool(jobs, CONCURRENCY)
    } else if (EXP === 'tall') {
      // Does the model keep our pixel frame on a tall page, or does it resize first? Marker truth comes from the DOM.
      const item = { key: 'marker', ask: 'the large bold text "BOTTOM MARKER"', truth: '#marker' }
      for (const pad of [800, 1500, 3000]) {
        const cap = await capture(browser, fx.base, CONFIGS[0], { query: `?pad=${pad}` }); save(`tall-${pad}.png`, cap.png)
        const m = cap.truth['#marker'], cy = Math.round(m.y + m.h / 2)
        for (const frame of Object.keys(FRAMES)) {
          const e = await locateCall(cap, frame, [item], `tall-${pad}`); const r = e.rows[0]
          console.log(`pad ${pad} image ${cap.W}x${cap.H} marker center y=${cy} frame ${frame.padEnd(5)} -> ${r.px ? `px y=${r.px[1]} (ratio ${r.ratio[1].toFixed(2)}) err ${r.errCss.toFixed(0)}px` : 'not found'}`)
        }
        const d = await ask(cap.png, 'How many pixels wide and tall is this image, as you received it? Reply with ONE JSON object only: {"width":<n>,"height":<n>}')
        log.push({ label: 'perceived-size', pad, truthW: cap.W, truthH: cap.H, raw: d.text }); console.log(`pad ${pad}: model says its image is ${d.text.replace(/\s+/g, ' ').slice(0, 60)} (real ${cap.W}x${cap.H})`)
      }
    } else if (EXP === 'small') {
      const frame = arg('frame', 'unit'), cap = await capture(browser, fx.base, CONFIGS[2]); save('shot.png', cap.png)
      const small = PRESENT.filter(p => p.small)
      const full = await pool(Array.from({ length: 2 }, (_, rep) => () => locateCall(cap, frame, small, 'full-image', rep)), CONCURRENCY); full.forEach(e => console.log(`full-image: ${fmt(e.summary)}`))
      // crops: a 480x300 region around each small target, sent as its own image; coordinates are mapped back in code
      const ctxp = await browser.newContext({ viewport: { width: 1920, height: 1080 } }), page = await ctxp.newPage(); await page.goto(fx.base + '/')
      const rows = []
      for (const it of small) {
        const b = cap.truth[it.truth], cx = Math.round(b.x + b.w / 2), cy = Math.round(b.y + b.h / 2), cw = 480, ch = 300
        const left = Math.max(0, Math.min(cap.W - cw, cx - cw / 2)), top = Math.max(0, Math.min(cap.H - ch, cy - ch / 2))
        const png = await page.screenshot({ clip: { x: left, y: top, width: cw, height: ch } }); save(`crop-${it.key}.png`, png)
        for (let rep = 0; rep < 2; rep++) {
          const sub = { W: cw, H: ch, dpr: 1, png, truth: { [it.truth]: { x: b.x - left, y: b.y - top, w: b.w, h: b.h } } }
          const r = await ask(png, locatePrompt(sub, frame, [it])), parsed = parseJson(r.text)
          const row = scoreAnswer(parsed, frame, sub, [it])[0]; rows.push(row); log.push({ label: 'crop', key: it.key, rep, pt: r.pt, ct: r.ct, row, raw: r.text })
        }
      }
      console.log(`crop (480x300 around target): ${fmt(summarize(rows))}`)
    } else if (EXP === 'state') {
      const jobs = [], combos = []
      for (let i = 0; i < 12; i++) combos.push({ sound: i % 2 === 0, loop: i % 3 === 0, colour: [null, 'red', 'green', 'blue', 'amber', 'violet', 'teal'][i % 7], status: ['idle', 'playing', 'stopped'][i % 3] })
      for (const [i, c] of combos.entries()) jobs.push(async () => {
        const cap = await capture(browser, fx.base, CFG, { before: async ({ page, center }) => {
          const click = async id => { const [x, y] = center(id); await page.mouse.click(x, y) }
          if (c.sound) await click('toggle-sound'); if (c.loop) await click('checkbox-loop'); if (c.colour) await click('swatch-' + c.colour)
          if (c.status === 'playing') await click('btn-start'); if (c.status === 'stopped') await click('btn-stop')
        } })
        const r = await ask(cap.png, 'Look at the canvas in this screenshot. Reply with ONE JSON object only: {"sound_toggle":"on"|"off","loop_checked":true|false,"selected_colour":"red|green|blue|amber|violet|teal|none","status_text":"<the exact text of the status line at the bottom of the canvas>"}')
        const a = parseJson(r.text) ?? {}
        const ok = { sound: a.sound_toggle === (cap.state.sound ? 'on' : 'off'), loop: a.loop_checked === cap.state.loop, colour: a.selected_colour === (cap.state.colour ?? 'none'), status: String(a.status_text ?? '').trim() === 'Status: ' + cap.state.status }
        log.push({ label: 'state', i, truth: cap.state, answer: a, ok, pt: r.pt, ct: r.ct }); console.log(`state ${i}: ${JSON.stringify(ok)}`)
      })
      await pool(jobs, CONCURRENCY)
      const ok = log.filter(l => l.label === 'state'); const rate = k => (ok.filter(l => l.ok[k]).length / ok.length * 100).toFixed(0)
      console.log(`state reading: sound ${rate('sound')}%  loop ${rate('loop')}%  colour ${rate('colour')}%  status text ${rate('status')}%  (n=${ok.length})`)
    }
  } finally { await browser.close(); fx.close() }
  save('results.json', { exp: EXP, model: PROVIDERS[MODEL].model, reasoning: REASONING, spend: { ...spend, note: 'estimated with the project\'s unverified price table' }, log })
  console.log(`done: ${spend.calls} calls, ${spend.pt} prompt tokens, ${spend.ct} completion tokens, est $${spend.cost.toFixed(3)}. Saved to ${RUN_DIR}`)
}
main().catch(e => { console.error('ERROR', e.message); if (log.length) save('partial.json', { spend, log }); process.exit(1) })
