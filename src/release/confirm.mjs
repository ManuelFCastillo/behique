// Turn the top changed fact between two builds into an exported Playwright test, then run it 3 times on each build.
//   node src/release/confirm.mjs <goodRef> <candidateRef> [--scenario share|scroll] [--port 8300] [--steps file] [--adapter name] [--runs 3] [--bisect]
// The test states the good build's value. It must PASS every run on the good build and FAIL every run on the candidate;
// each run starts from a freshly seeded build. Anything else (flaky, or passes on both) is not a confirmed regression.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runExported, writeExport } from '../export.mjs'
import { startBuild, stopAll } from './build.mjs'
import { compareBuilds, summaryLines } from './compare.mjs'
import { openCase } from './evidence.mjs'
import { SCENARIOS } from './scenarios.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
const [goodRef, candRef] = args.filter(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
if (!goodRef || !candRef) { console.error('usage: node src/release/confirm.mjs <goodRef> <candidateRef> [--port N] [--steps file] [--adapter name] [--runs N]'); process.exit(2) }
const port = +opt('port', 8300), runs = +opt('runs', 3)
const scenario = opt('scenario', null) // a named case (adapter + steps + description); otherwise --adapter and --steps
if (scenario && !SCENARIOS[scenario]) { console.error(`unknown scenario "${scenario}"; choose one of ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2) }
const sc = SCENARIOS[scenario] ?? null
const adapter = (await import(`./adapters/${sc?.adapter ?? opt('adapter', 'freshrss')}.mjs`)).default
const actions = JSON.parse(readFileSync(sc?.steps ?? opt('steps', 'bench/fixtures/freshrss/steps.json'), 'utf8'))

/**
 * A changed fact as a finding the exporter understands, or null if it cannot be turned into a test.
 * Markup facts are keyed by body/tag[n]/..., which is an XPath. A scroll fact becomes a RELATIVE test: how far the last
 * action moved the page, compared with how far it moved it on the old version (no absolute pixel positions).
 */
export function factToFinding(d, actions, start, baseline) {
  if (d.key === 'window@scrollY') {
    const before = baseline.stable[`${d.i - 1}|${d.key}`]
    if (d.i < 1 || typeof before !== 'number' || typeof d.was !== 'number') return null
    const moved = d.was - before, a = actions[d.i - 1]
    return {
      id: 'R1', start,
      title: `the page scrolls by ${moved} pixels after: ${a.type} ${a.selector ?? ''}`.slice(0, 140),
      expected: `the page scrolls by ${moved} pixels (the old version)`, actual: `the page ends ${Math.abs(d.now - d.was)} pixels ${d.now < d.was ? 'higher up' : 'lower down'} than the old version leaves it`,
      history: actions.slice(0, d.i), assert: { kind: 'scroll_delta', value: moved },
    }
  }
  const m = d.key.match(/^(.*?)(?:@([^/]+)|#text)$/)
  const selector = 'xpath=/html/' + m[1]
  const attr = m[2]
  const long = String(d.was).length >= 300 // facts cut values at 300 characters
  const assert = attr
    ? { kind: 'attr', selector, name: attr, op: long ? 'contains' : 'equals', value: d.was }
    : { kind: 'text', selector, op: 'contains', value: d.was }
  const what = attr ? `${attr} of ${m[1].split('/').slice(-2).join('/')}` : `text of ${m[1].split('/').slice(-2).join('/')}`
  return {
    id: 'R1', start,
    title: `${what} after step ${d.i} keeps the previous release's value`,
    expected: JSON.stringify(d.was), actual: JSON.stringify(d.now),
    history: actions.slice(0, d.i), assert,
  }
}

// Everything below is also written to an evidence case: an append-only log plus saved evidence files, with each
// conclusion recorded as a labelled claim (see evidence.mjs). The report page reads from it.
const caseId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_${goodRef}-vs-${candRef}`.replace(/[^\w.-]/g, '_')
const ev = openCase(join('out', 'evidence', caseId))
ev.event('case.opened', { goodRef, candRef, adapter: adapter.name, steps: actions, options: { bisect: args.includes('--bisect'), runs }, scenario: sc ? { name: scenario, label: sc.label, about: sc.about, upstream: sc.upstream } : null })
console.log(`evidence: ${caseId}`)
// A cancelled run stops its builds, closes its record honestly, and exits; it never leaves servers or an unfinished record.
process.on('SIGTERM', async () => { await stopAll(); try { ev.event('case.closed', { outcome: 'cancelled' }) } catch {} ; console.log('run cancelled'); process.exit(130) })

let cmp
try { cmp = await compareBuilds({ adapter, baseRef: goodRef, candRef, port, actions }) } catch (e) {
  const msg = String(e.message ?? e).split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 300)
  console.log(`a build failed to start, so the versions could not be compared: ${msg}`)
  ev.claim('verified_fact', `A build failed to start, so the two versions could not be compared: ${msg}`, { evidence: [ev.artifact('error.txt', String(e.stack ?? e).slice(0, 4000))] })
  ev.event('case.closed', { outcome: 'build failed' }); process.exit(3)
}
const { baseline, cand, control } = cmp
summaryLines(cmp, goodRef, candRef).forEach(l => console.log(l))
ev.event('builds.compared', { good: { ref: goodRef, sha: cmp.baseSha }, candidate: { ref: candRef, sha: cmp.candSha } })
const nVol = Object.keys(baseline.volatile).length, nAll = nVol + Object.keys(baseline.stable).length
const baseH = ev.artifact('baseline.json', { labels: baseline.labels, stable: Object.keys(baseline.stable).length, volatile: baseline.volatile }, 'application/json')
const diffH = ev.artifact('facts-diff.json', { control, candidate: cand }, 'application/json')
ev.claim('statistical', `${nVol} of ${nAll} recorded facts (${(100 * nVol / nAll).toFixed(1)}%) differed between two identical installs of ${goodRef}, so they are ignored when comparing.`, { evidence: [baseH] })
if (control.length) {
  console.log(`control run shows ${control.length} differences: masking is not trustworthy, stopping`)
  ev.event('case.closed', { outcome: 'masking not trustworthy' }); process.exit(1)
}
ev.claim('verified_fact', `A third recording of ${goodRef} showed 0 differences from the baseline, so the noise filter holds.`, { evidence: [diffH] })
if (!cand.some(d => d.kind === 'changed')) {
  const gone = cand.filter(d => d.kind === 'removed'), n = k => cand.filter(d => d.kind === k).length
  if (gone.length) { // nothing changed value, but things that existed before are missing now: never recommend shipping on that
    const eg = gone.slice(0, 3).map(d => d.key.split('/').slice(-2).join('/')).join(', ')
    console.log(`no value changed, but ${gone.length} recorded facts disappeared (${eg}); no test was written`)
    ev.claim('verified_fact', `No recorded value changed, but ${gone.length} fact${gone.length === 1 ? '' : 's'} present on ${goodRef} ${gone.length === 1 ? 'is' : 'are'} missing on ${candRef} (for example ${eg}). No test was written for a missing element.`, { evidence: [diffH] })
    ev.event('case.closed', { outcome: 'facts missing' }); process.exit(0)
  }
  console.log('no changed facts between the builds; nothing to turn into a test')
  ev.claim('verified_fact', `No recorded value differs between ${goodRef} and ${candRef} across ${actions.length} step${actions.length === 1 ? '' : 's'} (${n('added')} new and ${n('moved')} moved elements, 0 changed, 0 missing).`, { evidence: [diffH] })
  ev.event('case.closed', { outcome: 'no changed facts' }); process.exit(0)
}
const changed = cand.filter(d => d.kind === 'changed')
const short = k => k.split('/').slice(-2).join('/')
const cut = (v, n) => { const t = JSON.stringify(v); return t.length > n ? t.slice(0, n) + '...' : t } // shown shortened, never cut silently
ev.claim('verified_fact', `${candRef} differs from ${goodRef} in ${changed.length} recorded value${changed.length === 1 ? '' : 's'}: ${changed.slice(0, 4).map(d => `${short(d.key)} was ${cut(d.was, 90)}, now ${cut(d.now, 90)}`).join('; ')}.`, { evidence: [diffH] })

const probe = await startBuild({ adapter, ref: goodRef, port })
const origin = new URL(probe.base).origin, start = new URL(probe.base + '/').pathname
await probe.stop()
let top = null, finding = null // the first changed fact that can be written as a test
for (const d of changed) { finding = factToFinding(d, actions, start, baseline); if (finding) { top = d; break } }
if (!finding) { console.log('none of the changed facts can be written as a test'); ev.event('case.closed', { outcome: 'no testable change' }); process.exit(0) }
const dir = join('out', 'regression', `${goodRef}-vs-${candRef}`.replace(/[^\w.-]/g, '_'))
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
writeExport(dir, [finding])
const specH = ev.artifact(`${finding.id}.spec.js`, readFileSync(join(dir, finding.id + '.spec.js'), 'utf8'), 'text/javascript')
ev.event('test.exported', { id: finding.id, fact: top.key, good: finding.expected, candidate: finding.actual })
console.log(`test written: ${join(dir, finding.id + '.spec.js')}\n  fact: ${top.key.slice(-70)}\n  good: ${finding.expected.slice(0, 80)}\n  cand: ${finding.actual.slice(0, 80)}`)

const tally = {}, runLog = []
for (const ref of [goodRef, candRef]) {
  tally[ref] = []
  for (let n = 0; n < runs; n++) {
    const b = await startBuild({ adapter, ref, port })
    const r = runExported(dir, origin)
    await b.stop()
    const outcome = r.error ? 'error' : r.results[finding.id] === true ? 'passed' : 'failed'
    tally[ref].push(r.error ? `error: ${r.error}` : r.results[finding.id] === true)
    runLog.push({ ref, sha: b.sha, n: n + 1, outcome, ...(outcome === 'failed' ? { message: (r.errors?.[finding.id] ?? '').split('\n').slice(0, 6).join('\n') } : {}) })
    ev.event('test.run', { ref, sha: b.sha, n: n + 1, outcome })
    console.log(`  run ${ref} ${n + 1}/${runs}: ${outcome}`)
  }
}
const passes = ref => tally[ref].filter(x => x === true).length
const fails = ref => tally[ref].filter(x => x === false).length
console.log(`\n${goodRef} (good):      passed ${passes(goodRef)}/${runs}`)
console.log(`${candRef} (candidate): failed ${fails(candRef)}/${runs}`)
const confirmed = passes(goodRef) === runs && fails(candRef) === runs
console.log(confirmed ? '\nCONFIRMED: reproducible behaviour change, test passes on good and fails on candidate every time' : `\nNOT CONFIRMED: ${JSON.stringify(tally)}`)
const runsH = ev.artifact('test-runs.json', runLog, 'application/json')
if (confirmed) ev.claim('reproduced_failure', `The test ${finding.id} passed ${runs} of ${runs} runs on ${goodRef} and failed ${runs} of ${runs} runs on ${candRef}, each run on a freshly seeded build.`, { evidence: [specH, runsH] })
else ev.claim('statistical', `The test ${finding.id} passed ${passes(goodRef)} of ${runs} runs on ${goodRef} and failed ${fails(candRef)} of ${runs} on ${candRef}. That is not consistent enough to call a regression.`, { evidence: [runsH] })

let found = null // --bisect: only worth doing once the regression is confirmed
if (confirmed && args.includes('--bisect')) {
  const { bisect } = await import('./bisect.mjs')
  const blog = []
  found = await bisect({ adapter, goodRef, badRef: candRef, dir, id: finding.id, port, runs, log: l => { console.log(l); blog.push(l) }, onEvent: (type, data) => ev.event('bisect.' + type, data) })
  const bisH = ev.artifact('bisect.json', { result: found, log: blog }, 'application/json')
  ev.event('bisect.done', { conclusive: found.conclusive, verified: found.verified, steps: found.steps, seconds: found.seconds })
  if (found.conclusive && found.verified) {
    ev.claim('reproduced_failure', `The first change that makes the test fail is ${found.commit.slice(0, 7)}, "${found.subject}" (${found.author}, ${found.date}). The change just before it passed ${runs} of ${runs} runs and it failed ${runs} of ${runs} runs. Found by binary search over ${found.changes} changes in ${found.steps} steps.`, { evidence: [bisH, specH] })
    ev.claim('verified_fact', `That change touched ${found.files.length} file${found.files.length === 1 ? '' : 's'}: ${found.files.slice(0, 6).join(', ')}.`, { evidence: [bisH] })
  } else if (found.conclusive) {
    ev.claim('suspected_cause', `The search points at ${found.commit.slice(0, 7)}, "${found.subject}", but the verification runs were not clean, so this is a lead and not a result.`, { evidence: [bisH] })
  } else {
    ev.claim('suspected_cause', `The first bad change is one of ${found.range[1] - found.range[0] + 1} (changes #${found.range[0]} to #${found.range[1]}); the ones in between could not be tested.`, { evidence: [bisH] })
  }
}
ev.event('case.closed', { outcome: confirmed ? 'regression proven' : 'not confirmed', bisected: !!found })
console.log(`evidence log verified: ${ev.verify().ok}`)
writeFileSync(join(dir, 'result.json'), JSON.stringify({ goodRef, candRef, caseId, fact: top, tally, confirmed, bisect: found }, null, 1))
process.exit(confirmed ? 0 : 1)
