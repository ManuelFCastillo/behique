// Compare two builds of an app by the facts their pages show, using run-twice masking.
//   node src/release/diff-builds.mjs <baseRef> <candidateRef> [--port 8300] [--steps bench/fixtures/freshrss/steps.json]
// It records baseRef twice (to find volatile facts), candidateRef once, and baseRef a third time as a control:
// the control must show zero differences, otherwise the masking is not good enough to trust the candidate diff.
import { readFileSync } from 'node:fs'
import { compareBuilds, summaryLines } from './compare.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
const [baseRef, candRef] = args.filter(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
if (!baseRef || !candRef) { console.error('usage: node src/release/diff-builds.mjs <baseRef> <candidateRef> [--port N] [--steps file] [--adapter name]'); process.exit(2) }
const adapter = (await import(`./adapters/${opt('adapter', 'freshrss')}.mjs`)).default
const actions = JSON.parse(readFileSync(opt('steps', 'bench/fixtures/freshrss/steps.json'), 'utf8'))
const { baseline, cand, control, learned } = await compareBuilds({ adapter, baseRef, candRef, port: +opt('port', 8300), actions })

console.log(`steps recorded: ${baseline.labels.join(' | ')}`)
summaryLines({ baseline, cand, control, learned }, baseRef, candRef).forEach(l => console.log(l))
console.log('\nvolatile sample:'); Object.entries(baseline.volatile).slice(0, 5).forEach(([id, v]) => console.log(' ', id.slice(0, 90), JSON.stringify(v.a)?.slice(0, 30), '|', JSON.stringify(v.b)?.slice(0, 30)))
console.log('\nchanged facts (candidate):'); cand.filter(d => d.kind === 'changed').slice(0, 25).forEach(d => console.log(`  [${d.step.slice(0, 12)}] ${d.key.slice(-60)}\n      was ${JSON.stringify(d.was)?.slice(0, 90)}\n      now ${JSON.stringify(d.now)?.slice(0, 90)}`))
for (const k of ['added', 'removed']) {
  const ds = cand.filter(d => d.kind === k)
  if (ds.length) { console.log(`\n${k} facts (candidate), first ${args.includes('--all') ? ds.length : 8} of ${ds.length}:`); ds.slice(0, args.includes('--all') ? ds.length : 8).forEach(d => console.log(`  [${d.step.slice(0, 8)}] ${d.key.slice(-70)} = ${JSON.stringify(d.now ?? d.was)?.slice(0, 60)}`)) }
}
const moved = cand.filter(d => d.kind === 'moved')
if (moved.length) console.log(`\nmoved facts: ${moved.length} (same attribute and value, different position; not listed)`)
