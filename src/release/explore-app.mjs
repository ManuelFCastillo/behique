// Let the explorer loose on one build of an app and report whether it finds a flow on its own.
//   node src/release/explore-app.mjs [ref] [--model meta|baseten] [--max-cost 0.30] [--max-steps 20] [--adapter freshrss] [--hint "text"] [--dry-run]
// PAID: this makes up to --max-steps model calls. It prints the projected spend first; --dry-run stops there.
// By default the explorer is given NO hint about the app or about sharing. --hint adds one sentence to its brief; a run
// with a hint is labelled HINT USED in the output and in the saved result, and is not comparable to a no-hint run. Self-check is off (it needs a second copy of the app),
// so anything it reports as a bug here is unverified and is not counted. The question is only: did it find the flow?
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { explore } from '../explorer.mjs'
import { ENV, PROVIDERS, estCost } from '../llm.mjs'
import { startBuild } from './build.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
const ref = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) ?? '1.29.1'
const model = opt('model', 'meta')
const hint = opt('hint', null)
const caps = { maxSteps: +opt('max-steps', 20), maxTokens: 150000, maxCostUsd: +opt('max-cost', 0.30) }
const adapter = (await import(`./adapters/${opt('adapter', 'freshrss')}.mjs`)).default
if (!PROVIDERS[model]) { console.error('model must be one of ' + Object.keys(PROVIDERS).join(', ')); process.exit(2) }

// Projection, from the two measured runs on this app (2026-10-29): $0.0097 a step (20 steps, $0.193) and $0.0073 a step
// (30 steps, $0.220). The range is those two figures.
const PER_STEP_LOW = 0.0073, PER_STEP_HIGH = 0.0097
const low = PER_STEP_LOW * caps.maxSteps, high = PER_STEP_HIGH * caps.maxSteps
const PER_STEP = PER_STEP_HIGH
console.log(`model: ${PROVIDERS[model].model} (${model}); explores ${adapter.name} ${ref}, up to ${caps.maxSteps} steps, ${hint ? `HINT USED: "${hint}"` : 'no hints'}`)
console.log(`projected spend: about $${low.toFixed(2)} to $${high.toFixed(2)}`)
console.log(`  basis: the two earlier runs on this app cost $${PER_STEP_LOW} and $${PER_STEP_HIGH} a step`)
console.log(`  hard stop: the run ends before any step once the estimate passes $${caps.maxCostUsd.toFixed(2)}, so the most it can reach is about $${(caps.maxCostUsd + PER_STEP * 2).toFixed(2)}`)
if (args.includes('--dry-run')) { console.log('dry run: nothing was sent'); process.exit(0) }
if (!ENV[PROVIDERS[model].keyEnv]) { console.error(`no API key set for ${model}`); process.exit(2) }

const b = await startBuild({ adapter, ref, port: 8300 })
const dir = join('out', 'explorer', `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_${adapter.name}-${ref}`)
let r
try {
  r = await explore({
    baseUrl: b.base, model, caps, selfCheck: false, keepHistory: true, viewport: { width: 1280, height: 900 },
    brief: 'App under test: a web application. You have no other documentation.' + (hint ? ' ' + hint : ''),
    onStep: e => console.log(`step ${String(e.step).padStart(2)}: ${(e.actions.join('  |  ') || '(no action)').slice(0, 150)}${e.bugs ? `   [reported ${e.bugs} bug]` : ''}`),
  })
} finally { await b.stop() }

// Did it find the flow? Read the actions that actually succeeded.
const h = r.history, sel = a => String(a.selector ?? '')
const share = h.findIndex(a => a.type === 'click' && /share/i.test(sel(a)))
const clip = share < 0 ? -1 : h.findIndex((a, i) => i > share && a.type === 'click' && /clipboard/i.test(sel(a)))
if (hint) console.log(`\n*** A HINT WAS USED in this run: "${hint}" ***`)
console.log(`\nran ${r.steps.length} steps, ${h.length} actions succeeded, ${r.capped ? 'stopped by cap: ' + r.capped : r.finished ? 'the model said it was done' : 'ended'}`)
console.log(`spend: about $${r.cost.toFixed(4)} estimated (${r.pt} tokens in, ${r.ct} out)`)
const verdict = clip >= 0 ? 'FOUND' : share >= 0 ? 'PARTIAL' : 'NOT FOUND'
console.log(verdict === 'FOUND' ? `\nSHARE FLOW: FOUND. It opened the Share menu (action ${share + 1}) and used Clipboard (action ${clip + 1}).`
  : verdict === 'PARTIAL' ? `\nSHARE FLOW: PARTIAL. It opened the Share menu (action ${share + 1}) but never used the Clipboard item.`
  : `\nSHARE FLOW: NOT FOUND. It never opened the Share menu in ${h.length} actions.`)
console.log('\nactions that succeeded:'); h.forEach((a, i) => console.log(`  ${i + 1}. ${a.type} ${sel(a) || a.path || ''}`.slice(0, 140)))
if (r.findings.length) console.log(`\nit also reported ${r.findings.length} possible bug(s): UNVERIFIED (self-check off), not counted:\n` + r.findings.map(f => '  - ' + f.title).join('\n'))

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'result.json'), JSON.stringify({ ref, model, caps, hint: hint ?? null, hintUsed: Boolean(hint), verdict, shareAt: share + 1 || null, clipboardAt: clip + 1 || null, costUsd: r.cost, tokens: { in: r.pt, out: r.ct }, capped: r.capped, finished: r.finished, steps: r.steps.map(s => ({ step: s.step, notes: s.notes, actions: s.actions, results: s.results, pt: s.pt, ct: s.ct })), findings: r.findings.map(f => ({ title: f.title, expected: f.expected, actual: f.actual })) }, null, 1))
writeFileSync(join(dir, 'steps.json'), JSON.stringify(h, null, 1))
if (share >= 0) writeFileSync(join(dir, 'steps-to-share.json'), JSON.stringify(h.slice(0, share + 1), null, 1))
console.log(`\nsaved: ${dir}`)
process.exit(verdict === 'FOUND' ? 0 : 1)
