// Phase 3 of docs/canvas-senses-plan.md: the canvas senses on a REAL app, Music Blocks, two versions side by side.
//   node bench/mb-senses.mjs [--dry-run] [--reps 2] [--model meta|baseten] [--max-cost 1.5] [--concurrency 2]
//         [--good http://127.0.0.1:8814/] [--cand http://127.0.0.1:8815/]     (start them with ~/dev/behique-apps/mb-serve.mjs)
//
// Per version: load, wait until the page stops changing, close the welcome tour, take ONE settled screenshot, and ask the model
// to list the controls it sees (`reps` times). Then every proposed control is clicked in its own fresh page, twice (run A
// and run B), with the hands; each click gets a verdict from the pixels. Run B against run A on the SAME version is the noise
// measurement at the verdict level (A/A). Controls are then matched across versions and the differences listed.
// Only public apps are sent to the model: Music Blocks is open source and served locally. External requests are blocked.
// Nothing here is a bug finding: a difference between versions is a CANDIDATE for a person to judge.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chat, estCost, ENV, PROVIDERS } from '../src/llm.mjs'
import { act, settle, shot } from '../src/senses/hands.mjs'
import { diff, diffImage, emptiness, scaleBox } from '../src/senses/pixels.mjs'
import { discover } from '../src/senses/vision.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]) }
const DRY = process.argv.includes('--dry-run'), REPS = Number(arg('reps', 2)), MODEL = arg('model', 'meta'), MAX_COST = Number(arg('max-cost', 1.5)), CONC = Number(arg('concurrency', 2)), REASONING = arg('reasoning', 'low')
const VERSIONS = { good: arg('good', 'http://127.0.0.1:8814/'), cand: arg('cand', 'http://127.0.0.1:8815/') }
const VIEWPORT = { width: 1280, height: 800 }, DPR = 2
const TOUR_CLOSE = [220, 155] // the welcome tour's X in both versions (app-specific setup, found by looking)
const PROBE_KINDS = new Set(['button', 'icon', 'toggle', 'checkbox', 'swatch']) // sliders and draggable objects are listed but not clicked here

const spend = { pt: 0, ct: 0, calls: 0, cost: 0 }
async function ask(text, png) {
  if (spend.cost >= MAX_COST) throw new Error(`cost cap reached ($${spend.cost.toFixed(3)} >= $${MAX_COST})`)
  const r = await chat(MODEL, [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }] }], { maxTokens: 8000, reasoning: REASONING })
  spend.pt += r.pt; spend.ct += r.ct; spend.calls++; spend.cost = estCost(spend.pt, spend.ct)
  return r
}
async function pool(jobs, n) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const k = i++; out[k] = await jobs[k]() } })); return out }
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const tokens = s => new Set(norm(s).split(' ').filter(w => w.length > 1 && !['the', 'icon', 'button', 'of', 'a'].includes(w)))
const overlap = (a, b) => { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.max(A.size, B.size) }

/** A fresh page, settled, welcome tour closed, settled again. External hosts are blocked. */
async function prepare(browser, base) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })
  await ctx.route(url => !/^(127\.0\.0\.1|localhost)$/.test(new URL(url).hostname) && !url.protocol.startsWith('data') && url.protocol !== 'blob:', r => r.abort())
  const page = await ctx.newPage()
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 120)))
  await page.goto(base, { waitUntil: 'load' })
  const s1 = await settle(page, { stableMs: 1500, pollMs: 300, maxMs: 40000 })
  await page.mouse.click(...TOUR_CLOSE)
  const s2 = await settle(page, { stableMs: 1500, pollMs: 300, maxMs: 20000 })
  return { ctx, page, errors, settled: s1.settled && s2.settled, png: s2.png }
}

/** What is under a CSS point, for scoring proposals: an interactive DOM element, a canvas, or something else. */
const domAt = (page, x, y) => page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y); if (!el) return null
  const c = el.closest('button,a,[role=button],li,[onclick]') ?? el
  return { tag: el.tagName, interactive: Boolean(el.closest('button,a,[role=button],input,select,[onclick]')), id: c.id || null, name: (c.getAttribute('aria-label') || c.getAttribute('title') || c.id || (c.textContent || '').trim().slice(0, 24) || null) }
}, [x, y])

async function probe(browser, base, c) {
  const { ctx, page, settled: ready } = await prepare(browser, base)
  try {
    const p = { x: c.point[0] * VIEWPORT.width, y: c.point[1] * VIEWPORT.height }
    const dom = await domAt(page, p.x, p.y)
    const guard = async (pg, a, vp) => emptiness(await shot(pg), scaleBox({ x: a.x - 32, y: a.y - 32, w: 64, h: 64 }, vp.dpr)) >= 0.995 ? 'skipped_blank' : null
    const r = await act(page, { type: 'click_at', ...p }, { guard, settling: { stableMs: 1200, pollMs: 300, maxMs: 15000 } })
    return { dom, ready, verdict: r.verdict, settled: r.settled ?? null, changed: r.diff?.changed ?? null, bbox: r.diff?.bbox ?? null, pageErrors: r.pageErrors ?? [], png: r.skipped ? null : { before: r.before, after: r.after, diff: r.diffPng } }
  } finally { await ctx.close() }
}

async function main() {
  const lists = REPS, probes = 0
  console.log(`Phase 3 Music Blocks: ${lists * 2} model calls (${REPS} per version, one settled 2560x1600 screenshot each) on ${MODEL}, reasoning ${REASONING}; then every proposed click-type control is probed in fresh pages twice per version (about 20 controls x 2 versions x 2 runs = 80 probes, each about 15 s, concurrency ${CONC}), free.`)
  console.log(`Projection (about 6,000 input and 2,000 output tokens per call; real usage is logged): about $${(lists * 2 * estCost(6000, 2000)).toFixed(2)}. Cap $${MAX_COST}.`)
  if (DRY) { console.log('dry run: nothing sent, no browser started.'); return }
  if (!ENV[PROVIDERS[MODEL].keyEnv]) throw new Error(`${PROVIDERS[MODEL].keyEnv} is empty (put it in .env)`)
  const dir = join(ROOT, 'bench/canvas-runs', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-mb-' + MODEL)
  mkdirSync(dir, { recursive: true })
  const browser = await chromium.launch()
  const out = { model: MODEL, reasoning: REASONING, versions: VERSIONS, side: {} }
  try {
    // 1. look: settled screenshot per version, REPS model calls each
    for (const [side, base] of Object.entries(VERSIONS)) {
      const { ctx, png, settled, errors } = await prepare(browser, base)
      await ctx.close()
      writeFileSync(join(dir, `${side}-screenshot.png`), png)
      const size = { W: png.readUInt32BE(16), H: png.readUInt32BE(20) }
      const reps = await pool(Array.from({ length: REPS }, (_, rep) => async () => discover(png, size, ask)), 2)
      const first = reps[0].controls
      const keep = c => PROBE_KINDS.has(c.kind)
      out.side[side] = { base, settledBeforeShot: settled, pageErrors: errors, reps: reps.map(d => ({ n: d.controls.length, dropped: d.dropped, parseFailed: d.parseFailed, usage: d.usage, controls: d.controls })), probeSet: first.filter(keep), notProbed: first.filter(c => !keep(c)).map(c => `${c.label}:${c.kind}`) }
      console.log(`${side} (${base}): load settled ${settled}; model listed ${reps.map(d => d.controls.length).join(', ')} controls over ${REPS} calls; probing ${out.side[side].probeSet.length}, not probing ${out.side[side].notProbed.length}; spend so far $${spend.cost.toFixed(3)}`)
    }
    out.spend = { ...spend }
    // 2. act: every control, fresh page, run A and run B, per version
    const jobs = []
    for (const side of Object.keys(VERSIONS)) for (const [i, c] of out.side[side].probeSet.entries()) for (const run of ['A', 'B']) jobs.push(async () => {
      let r; try { r = await probe(browser, VERSIONS[side], c) } catch (e) { r = { verdict: 'error', error: String(e.message).slice(0, 160) } }
      const row = { side, i, run, label: c.label, kind: c.kind, point: c.point, ...r, png: undefined }
      if (r.png && run === 'A') for (const [n, b] of Object.entries(r.png)) writeFileSync(join(dir, `${side}-${String(i).padStart(2, '0')}-${norm(c.label).replace(/ /g, '-').slice(0, 20)}-${n}.png`), b)
      if (r.png && run === 'B') (out.afterB ??= {})[`${side}:${i}`] = r.png.after
      if (r.png && run === 'A') (out.afterA ??= {})[`${side}:${i}`] = r.png.after
      console.log(`${side} #${i} ${run} ${c.label.slice(0, 28).padEnd(28)} ${String(r.verdict).padEnd(14)} changed ${r.changed ?? '-'}  dom ${r.dom ? (r.dom.interactive ? 'interactive ' : r.dom.tag + ' ') + (r.dom.name ?? '') : '-'}`)
      return row
    })
    const rows = await pool(jobs, CONC)
    // 3. noise at the verdict level: run A against run B on the same version
    const noise = {}
    for (const side of Object.keys(VERSIONS)) {
      const a = rows.filter(r => r.side === side && r.run === 'A'), b = rows.filter(r => r.side === side && r.run === 'B')
      const pairs = a.map(ra => ({ ra, rb: b.find(r => r.i === ra.i) })).filter(p => p.rb)
      const verdictDiffers = pairs.filter(p => p.ra.verdict !== p.rb.verdict)
      const pix = pairs.map(p => { const x = out.afterA?.[`${side}:${p.ra.i}`], y = out.afterB?.[`${side}:${p.ra.i}`]; return x && y ? { label: p.ra.label, changed: diff(x, y, { tolerance: 8 }).changed } : null }).filter(Boolean)
      noise[side] = { controls: pairs.length, verdictDiffers: verdictDiffers.map(p => `${p.ra.label}: ${p.ra.verdict} vs ${p.rb.verdict}`), afterPixelsDifferBetweenRuns: pix.filter(p => p.changed > 0).map(p => `${p.label}: ${p.changed}`), afterPixelsIdentical: pix.filter(p => p.changed === 0).length, of: pix.length }
    }
    out.noise = noise
    // 4. compare versions: match by what the page says is under the point, else by label words
    // a control whose two runs disagree, or whose page had not finished loading, is noise: kept out of the comparison and listed
    const unstable = new Set(rows.filter(r => r.ready === false || r.verdict === 'error' || rows.some(o => o.side === r.side && o.i === r.i && o.run !== r.run && o.verdict !== r.verdict)).map(r => `${r.side}:${r.i}`))
    out.unstable = [...unstable]
    const A = rows.filter(r => r.side === 'good' && r.run === 'A' && !unstable.has(`good:${r.i}`)), B = rows.filter(r => r.side === 'cand' && r.run === 'A' && !unstable.has(`cand:${r.i}`))
    const used = new Set(), matched = [], goodOnly = []
    for (const g of A) {
      let best = null, bs = 0
      for (const c of B) {
        if (used.has(c.i)) continue
        const dom = g.dom?.name && c.dom?.name && norm(g.dom.name) === norm(c.dom.name) ? 1 : 0
        const s = Math.max(dom, overlap(g.label, c.label))
        if (s > bs) { bs = s; best = c }
      }
      if (best && bs >= 0.5) { used.add(best.i); matched.push({ good: g, cand: best, score: bs }) } else goodOnly.push(g)
    }
    const candOnly = B.filter(c => !used.has(c.i))
    const moved = matched.filter(m => Math.hypot((m.good.point[0] - m.cand.point[0]) * VIEWPORT.width, (m.good.point[1] - m.cand.point[1]) * VIEWPORT.height) > 20)
    const behaviour = matched.filter(m => (m.good.verdict === 'changed') !== (m.cand.verdict === 'changed'))
    const short = r => ({ label: r.label, kind: r.kind, verdict: r.verdict, changed: r.changed, dom: r.dom?.name ?? null })
    out.compare = { matched: matched.length, onlyInGood: goodOnly.map(short), onlyInCand: candOnly.map(short), moved: moved.map(m => ({ label: m.good.label, from: m.good.point, to: m.cand.point })), behaviourDiffers: behaviour.map(m => ({ good: short(m.good), cand: short(m.cand) })) }
    out.rows = rows
    writeFileSync(join(dir, 'results.json'), JSON.stringify(out, (k, v) => (k === 'afterA' || k === 'afterB') ? undefined : v, 1))
    console.log('\nNOISE ' + JSON.stringify(out.noise, null, 1))
    console.log('\nCOMPARE ' + JSON.stringify(out.compare, null, 1))
    console.log(`\nmodel spend: ${spend.calls} calls, about $${spend.cost.toFixed(3)}\nsaved to ${dir}`)
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exit(1) })
