// Records the dashboard while a real crawl run happens, for the demo tour's time-lapse: the New run dialog is filled and started on
// screen, then the page sits on the run until the verdict is up. Writes a raw webm and a JSON with the moments to cut at.
//   node demo/tour-run.mjs <app> <goodRef> <candRef> [out/demo/run-raw.webm]     needs the demo server on 8790 and a sandbox host
import { chromium } from 'playwright'
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [app, goodRef, candRef, out = 'out/demo/run-raw.webm'] = process.argv.slice(2)
if (!candRef) { console.error('usage: node demo/tour-run.mjs <app> <goodRef> <candRef> [out.webm]'); process.exit(2) }
const base = process.env.BEHIQUE_URL ?? 'http://127.0.0.1:8790'
const W = 1280, H = 800
mkdirSync(dirname(out), { recursive: true })
const vidDir = join(dirname(out), 'run-raw-dir'); rmSync(vidDir, { recursive: true, force: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: vidDir, size: { width: W, height: H } } })
const page = await ctx.newPage()
const t0 = Date.now(), at = () => (Date.now() - t0) / 1000
const marks = {}
await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '#rdBar{display:none !important}'; document.head.appendChild(s) }) }) // the layout picker is for design review, not for the film
await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.click('#replayBtn'); await page.waitForSelector('#runOverlay.open'); marks.dialog = at()
await page.selectOption('#runApp', app); await page.waitForTimeout(400)
await page.selectOption('#runType', 'crawl').catch(() => {}); await page.waitForTimeout(400)
await page.fill('#runGood', ''); await page.type('#runGood', goodRef, { delay: 70 })
await page.fill('#runCand', ''); await page.type('#runCand', candRef, { delay: 70 })
await page.waitForTimeout(900)
marks.start = at(); await page.click('#runStart')
// the run: poll the server until it is over, the page keeps showing its own progress
let cur
for (let i = 0; i < 5400; i++) { // the longest measured run with a bisect is about 40 minutes
  await page.waitForTimeout(1000)
  cur = await fetch(`${base}/api/ui/runs/current`).then(r => r.json()).catch(() => null)
  if (i === 2) marks.running = at()
  if (cur && cur.running === false && i > 3) break
}
marks.done = at()
await page.waitForTimeout(6000); marks.end = at()
await ctx.close(); await browser.close()
const webm = readdirSync(vidDir).find(f => f.endsWith('.webm'))
renameSync(join(vidDir, webm), out); rmSync(vidDir, { recursive: true, force: true })
writeFileSync(out.replace(/\.webm$/, '.json'), JSON.stringify({ app, goodRef, candRef, caseId: cur?.caseId ?? null, status: cur?.status ?? null, marks }, null, 2))
console.log('wrote', out, JSON.stringify({ caseId: cur?.caseId, status: cur?.status, marks }))
