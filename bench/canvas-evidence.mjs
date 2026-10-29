// Records the saved canvas traces (node bench/canvas-trace.mjs) as evidence cases, so they appear on the demo's /report page
// next to the release checks. No browser and no model calls: it only reads the traces and the proposals a model made earlier.
//   node bench/canvas-evidence.mjs [--variant stop-dead] [--again]      (a variant that already has a case is skipped unless --again)
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDERS } from '../src/llm.mjs'
import { listCases, openCase, summarize } from '../src/release/evidence.mjs'
import { recordCanvasCase } from '../src/senses/canvas-evidence.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1] }
const TRACES = join(ROOT, 'out/senses-traces'), EVIDENCE = join(ROOT, 'out/evidence')
const BUGS = JSON.parse(readFileSync(join(ROOT, 'bench/fixtures/canvas-app/bugs.json'), 'utf8'))
const source = JSON.parse(readFileSync(join(TRACES, 'proposals-source.json'), 'utf8'))
const model = PROVIDERS[source.summary.model]?.model ?? source.summary.model
const provenance = { source: 'bench/canvas-find.mjs run', provider: source.summary.model, reasoning: source.summary.reasoning, note: 'proposed once from a clean screenshot; the same proposals were used on every version' }
const have = new Set(listCases(EVIDENCE).map(id => summarize(openCase(join(EVIDENCE, id)).read()).opened?.scenario?.name).filter(Boolean))
for (const id of ['clean', ...BUGS.map(b => b.id)]) {
  if (arg('variant') && arg('variant') !== id) continue
  if (have.has(`canvas-${id}`) && !process.argv.includes('--again')) { console.log(`${id.padEnd(13)} already has a case, skipped`); continue }
  const candDir = join(TRACES, id === 'clean' ? 'clean-again' : id) // the clean case compares the unchanged app with a SEPARATE second run of it, never with itself
  if (!existsSync(join(candDir, 'trace.json'))) { console.log(`${id.padEnd(13)} no trace yet`); continue }
  const r = recordCanvasCase({ evidenceRoot: EVIDENCE, goodDir: join(TRACES, 'clean'), candDir, floorDir: join(TRACES, 'clean-floor'), variantId: id, bug: BUGS.find(b => b.id === id) ?? null, screenshot: join(TRACES, 'screenshot.png'), proposals: join(TRACES, 'proposals.json'), model, provenance })
  console.log(`${id.padEnd(13)} ${r.caseId}  ${JSON.stringify(r.counts)}  record intact: ${r.ok}`)
}
