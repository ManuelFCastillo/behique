// Phase 2 of docs/canvas-senses-plan.md: can vision + hands find planted bugs on a canvas?
//   node bench/canvas-find.mjs [--dry-run] [--reps 3] [--model meta|baseten] [--max-cost 3] [--replays 3] [--concurrency 5]
//
// Per rep: ONE model call looks at the clean app's screenshot and proposes controls (it is told nothing about bugs). Those
// same proposals are then run, by the hands and the code rules in src/senses/canvas-qa.mjs, on the clean app and on each
// planted-bug variant (bench/fixtures/canvas-app/bugs.json), each in fresh browsers. The fixture's own model
// (window.__layout) is used ONLY here, to score where the proposals landed and which finding belongs to which bug.
// Only the public fixture's screenshot is sent to the model. Costs use the unverified third-party price in src/llm.mjs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chat, estCost, ENV, PROVIDERS } from '../src/llm.mjs'
import { VIEWPORT, DPR, explore } from '../src/senses/canvas-qa.mjs'
import { shot } from '../src/senses/hands.mjs'
import { discover } from '../src/senses/vision.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'bench/fixtures/canvas-app')
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]) }
const DRY = process.argv.includes('--dry-run'), REPS = Number(arg('reps', 3)), MODEL = arg('model', 'meta'), MAX_COST = Number(arg('max-cost', 3))
const REPLAYS = Number(arg('replays', 3)), CONC = Number(arg('concurrency', 5)), REASONING = arg('reasoning', 'low')
const BUGS = JSON.parse(readFileSync(join(FIXTURE, 'bugs.json'), 'utf8'))
const VARIANTS = [{ id: 'clean', q: '' }, ...BUGS.map(b => ({ id: b.id, q: '?bug=' + b.id, bug: b }))]

const spend = { pt: 0, ct: 0, calls: 0, cost: 0 }
async function ask(text, png) {
  if (spend.cost >= MAX_COST) throw new Error(`cost cap reached ($${spend.cost.toFixed(3)} >= $${MAX_COST})`)
  const r = await chat(MODEL, [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }] }], { maxTokens: 8000, reasoning: REASONING })
  spend.pt += r.pt; spend.ct += r.ct; spend.calls++; spend.cost = estCost(spend.pt, spend.ct)
  return r
}
async function pool(jobs, n) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const k = i++; out[k] = await jobs[k]() } })); return out }

const html = readFileSync(join(FIXTURE, 'index.html'))
const serve = () => new Promise(r => { const s = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html) }); s.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() })) })
const inBox = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h

/** Which fixture object (initial layout) a CSS-pixel point is on, or null. A slider's track counts as the slider. */
function objectAt(p, truth) {
  const hit = truth.objects.filter(o => inBox(p, o.box)).sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0]
  if (hit) return hit.id === 'slider-track' ? 'slider-knob' : hit.id
  return inBox(p, truth.help) ? '#help' : null
}

async function truthLayout(base) {
  const browser = await chromium.launch()
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })).newPage()
    await page.goto(base); await page.waitForTimeout(300)
    const L = await page.evaluate(() => window.__layout())
    const help = await page.evaluate(() => { const r = document.getElementById('help').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
    return { objects: L.objects, help }
  } finally { await browser.close() }
}

function scoreDiscovery(controls, truth, vp) {
  const rows = controls.map(c => ({ label: c.label, kind: c.kind, object: objectAt({ x: c.point[0] * vp.width, y: c.point[1] * vp.height }, truth) }))
  const real = truth.objects.filter(o => o.id !== 'slider-track').map(o => o.id)
  const found = new Set(rows.map(r => r.object).filter(Boolean))
  return { n: rows.length, onSomething: rows.filter(r => r.object).length, invented: rows.filter(r => !r.object).length, duplicates: rows.length - new Set(rows.map(r => r.object ?? Math.random())).size, covered: real.filter(id => found.has(id)).length, of: real.length, missed: real.filter(id => !found.has(id)), rows }
}

async function main() {
  const calls = REPS, runsPerRep = VARIANTS.length * (1 + REPLAYS)
  console.log(`Phase 2 find: ${calls} model calls (one screenshot each, 2560x1600) on ${MODEL}, reasoning ${REASONING}; then ${REPS * VARIANTS.length} explorations (${VARIANTS.length} variants x ${REPS} reps), each ${1 + REPLAYS} fresh browser runs = ${REPS * runsPerRep} browser runs, free.`)
  console.log(`Projection (assumes about 5,000 input and 1,500 output tokens per call; real usage is logged): about $${(calls * estCost(5000, 1500)).toFixed(2)}. Cap $${MAX_COST}.`)
  if (DRY) { console.log('dry run: nothing sent, no browser started.'); return }
  if (!ENV[PROVIDERS[MODEL].keyEnv]) throw new Error(`${PROVIDERS[MODEL].keyEnv} is empty (put it in .env)`)
  const dir = join(ROOT, 'bench/canvas-runs', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-find-' + MODEL)
  mkdirSync(dir, { recursive: true })
  const fx = await serve()
  try {
    const truth = await truthLayout(fx.base)
    const browser = await chromium.launch()
    let png
    try {
      const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })).newPage()
      await page.goto(fx.base); await page.waitForTimeout(400); png = await shot(page)
    } finally { await browser.close() }
    writeFileSync(join(dir, 'screenshot.png'), png)
    const size = { W: png.readUInt32BE(16), H: png.readUInt32BE(20) }
    const found = await pool(Array.from({ length: REPS }, (_, rep) => async () => {
      const d = await discover(png, size, ask)
      const sc = scoreDiscovery(d.controls, truth, VIEWPORT)
      console.log(`rep ${rep} vision: ${sc.n} controls, ${sc.onSomething} on a real object, ${sc.invented} invented, covers ${sc.covered}/${sc.of}${sc.missed.length ? ' (missed ' + sc.missed.join(', ') + ')' : ''}, dropped ${d.dropped}${d.parseFailed ? ' PARSE-FAILED' : ''}, ${d.usage.ct} out tokens, finish ${d.usage.finish}`)
      return { rep, d, sc }
    }), 2)
    console.log(`model spend so far: ${spend.calls} calls, about $${spend.cost.toFixed(3)} (tokens in ${spend.pt}, out ${spend.ct})`)

    const jobs = []
    for (const f of found) for (const v of VARIANTS) jobs.push(async () => {
      const r = await explore(fx.base + v.q, f.d.controls, { replays: REPLAYS })
      const rows = r.findings.map(x => ({ label: x.control.label, kind: x.control.kind, object: objectAt(x.action.type === 'drag' ? x.action.from : x.action, truth), verdict: x.verdict, reproduced: `${x.reproduced}/${x.replays}`, changed: x.diff.changed, inRegion: x.diff.inRegion }))
      const own = v.bug ? rows.filter(x => x.object === v.bug.object) : []
      const out = { rep: f.rep, variant: v.id, detected: v.bug ? own.length > 0 : null, detectedReproduced: v.bug ? own.some(x => x.reproduced === `${REPLAYS}/${REPLAYS}`) : null, other: rows.filter(x => !own.includes(x)), skipped: r.skipped.map(s => `${s.control.label}:${s.reason}`), verdicts: r.verdicts, rows }
      r.findings.forEach((x, k) => { if (v.bug && rows[k].object === v.bug.object) for (const [n, b] of Object.entries(x.png)) writeFileSync(join(dir, `rep${f.rep}-${v.id}-${n}.png`), b) })
      console.log(`rep ${f.rep} ${v.id.padEnd(13)} ${v.bug ? (out.detected ? (out.detectedReproduced ? 'FOUND, reproduced' : 'FOUND, not reproduced') : 'MISSED') : 'clean'}; other findings: ${out.other.length ? out.other.map(x => `${x.label}[${x.verdict} ${x.reproduced}${x.object ? '' : ' no real object'}]`).join('; ') : 'none'}${out.skipped.length ? '; skipped ' + out.skipped.join(', ') : ''}`)
      return out
    })
    const results = await pool(jobs, CONC)

    const blind = new Set(BUGS.filter(b => b.detectable === false).map(b => b.id)), held = new Set(BUGS.filter(b => b.heldOut).map(b => b.id))
    const bugRows = results.filter(r => r.detected !== null && !blind.has(r.variant)), blindRows = results.filter(r => blind.has(r.variant)), clean = results.filter(r => r.variant === 'clean')
    const summary = {
      model: MODEL, reasoning: REASONING, reps: REPS, replays: REPLAYS, spend: { ...spend },
      discovery: found.map(f => { const { rows, ...s } = f.sc; return s }),
      bugsFound: `${bugRows.filter(r => r.detected).length}/${bugRows.length}`, bugsFoundReproduced: `${bugRows.filter(r => r.detectedReproduced).length}/${bugRows.length}`,
      byBug: Object.fromEntries(BUGS.map(b => [b.id, `${bugRows.filter(r => r.variant === b.id && r.detected).length}/${REPS}`])),
      heldOutFound: `${bugRows.filter(r => held.has(r.variant) && r.detected).length}/${bugRows.filter(r => held.has(r.variant)).length}`,
      knownBlindSpot: Object.fromEntries([...blind].map(id => [id, `flagged on its own object in ${blindRows.filter(r => r.variant === id && r.detected).length}/${REPS} runs`])),
      cleanRunsWithAFinding: `${clean.filter(r => r.rows.length).length}/${clean.length}`, cleanFindings: clean.flatMap(r => r.rows),
      otherFindingsOnBugRuns: [...bugRows, ...blindRows].reduce((n, r) => n + r.other.length, 0),
    }
    writeFileSync(join(dir, 'results.json'), JSON.stringify({ summary, found: found.map(f => ({ rep: f.rep, controls: f.d.controls, raw: f.d.raw, usage: f.d.usage, score: f.sc })), results }, null, 1))
    console.log('\nSUMMARY ' + JSON.stringify(summary, null, 1))
    console.log('saved to ' + dir)
  } finally { fx.close() }
}
main().catch(e => { console.error(e); process.exit(1) })
