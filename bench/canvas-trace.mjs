// Writes a saved trace for every variant of the canvas test app, for the demo's /watch page (replay mode). NO model calls:
// it reuses the controls a model already proposed in a bench/canvas-find.mjs run.
//   node bench/canvas-trace.mjs [--proposals bench/canvas-runs/<run>/results.json] [--variant stop-dead] [--replays 3]
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { traceVariant } from '../src/senses/trace.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1] }
const runs = readdirSync(join(ROOT, 'bench/canvas-runs')).filter(d => d.includes('-find-meta')).sort()
const PROPOSALS = arg('proposals', join(ROOT, 'bench/canvas-runs', runs.at(-1), 'results.json'))
const REPLAYS = Number(arg('replays', 3)), ONLY = arg('variant')
const OUT = join(ROOT, 'out/senses-traces')
const BUGS = JSON.parse(readFileSync(join(ROOT, 'bench/fixtures/canvas-app/bugs.json'), 'utf8'))
const controls = JSON.parse(readFileSync(PROPOSALS, 'utf8')).found[0].controls
const html = readFileSync(join(ROOT, 'bench/fixtures/canvas-app/index.html'))
mkdirSync(OUT, { recursive: true }); copyFileSync(PROPOSALS, join(OUT, 'proposals-source.json')); copyFileSync(join(dirname(PROPOSALS), 'screenshot.png'), join(OUT, 'screenshot.png')) // the one picture the model was shown
writeFileSync(join(OUT, 'proposals.json'), JSON.stringify(controls, null, 1))
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/`
console.log(`${controls.length} proposed controls from ${PROPOSALS}`)
for (const v of [{ id: 'clean', q: '' }, ...BUGS.map(b => ({ id: b.id, q: '?bug=' + b.id }))]) {
  if (ONLY && v.id !== ONLY) continue
  const t = await traceVariant({ url: base + v.q, controls, dir: join(OUT, v.id), variant: v.id, replays: REPLAYS })
  console.log(v.id.padEnd(13), `${t.steps.length} steps, findings: ${t.findings.map(i => t.steps[i].label).join(', ') || 'none'}; replays ${t.replays.map(r => `${r.agree}/${r.of}`).join(' ') || '-'}`)
}
server.close()
