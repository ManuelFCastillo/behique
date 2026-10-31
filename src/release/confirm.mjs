// Turn the top changed fact between two builds into an exported Playwright test, then run it 3 times on each build.
//   node src/release/confirm.mjs <goodRef> <candidateRef> [--scenario share|scroll] [--port 8300] [--steps file] [--adapter name] [--app name --steps file] [--read-only] [--runs 3] [--max-findings 3] [--bisect]
// Each changed fact (earliest step per fact, at most --max-findings) becomes a test that states the good build's value. A test must PASS
// every run on the good build and FAIL every run on the candidate; every run of every test starts from its own freshly seeded build, so tests
// cannot change each other's state. Anything else (flaky, or passes on both) is not a confirmed regression. --bisect searches for the
// first bad change of the first confirmed test only.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runExportedAsync, writeExport } from '../export.mjs'
import { firstConfirmed, judgeFindings, selectFindings, summarize } from './findings.mjs'
import { captureShots, recordShots } from './shots.mjs'
import { setTiming, startBuild, stopAll } from './build.mjs'
import { poolSize, runPool, slotPort } from './pool.mjs'
import { sandboxConfigFromEnv } from './sandbox/backend.mjs'
import { createTiming, timingLine } from './timing.mjs'
import { compareBuilds, summaryLines } from './compare.mjs'
import { openCase } from './evidence.mjs'
import { SCENARIOS } from './scenarios.mjs'
import { listProfileNames, loadProfile, profileToAdapter } from './onboard/profile.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
const [goodRef, candRef] = args.filter(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
if (!goodRef || !candRef) { console.error('usage: node src/release/confirm.mjs <goodRef> <candidateRef> [--port N] [--steps file] [--adapter name] [--runs N]'); process.exit(2) }
const port = +opt('port', 8300), runs = +opt('runs', 3), maxFindings = +opt('max-findings', 3)
const readOnly = args.includes('--read-only') // crawled steps: every request but GET and HEAD is blocked, in the recording and in each test
const scenario = opt('scenario', null) // a named case (adapter + steps + description); otherwise --adapter and --steps
if (scenario && !SCENARIOS[scenario]) { console.error(`unknown scenario "${scenario}"; choose one of ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2) }
const sc = SCENARIOS[scenario] ?? null
const appName = opt('app', null) // an app Behique set up itself (a saved profile): needs --steps, for example from the crawl
if (appName && !listProfileNames().includes(appName)) { console.error(`unknown app "${String(appName).slice(0, 30)}"; saved apps: ${listProfileNames().join(', ') || 'none'}`); process.exit(2) }
if (appName && !sc && !args.includes('--steps')) { console.error('an app needs its click steps: pass --steps <file> (the crawl writes one: node src/release/crawl/cli.mjs <app>)'); process.exit(2) }
const adapter = appName ? profileToAdapter(loadProfile(appName)) : (await import(`./adapters/${sc?.adapter ?? opt('adapter', 'freshrss')}.mjs`)).default
const actions = JSON.parse(readFileSync(sc?.steps ?? opt('steps', 'bench/fixtures/freshrss/steps.json'), 'utf8'))

// Everything below is also written to an evidence case: an append-only log plus saved evidence files, with each
// conclusion recorded as a labelled claim (see evidence.mjs). The report page reads from it.
const caseId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_${goodRef}-vs-${candRef}`.replace(/[^\w.-]/g, '_')
const ev = openCase(join('out', 'evidence', caseId))
ev.event('case.opened', { goodRef, candRef, adapter: adapter.name, ...(appName ? { app: appName } : {}), steps: actions, options: { bisect: args.includes('--bisect'), runs }, scenario: sc ? { name: scenario, label: sc.label, about: sc.about, upstream: sc.upstream } : null })
console.log(`evidence: ${caseId}`)
const timing = createTiming(); setTiming(timing) // where the time goes, by phase; written to the record and printed as one line at the end
const close = data => { const s = timing.summary(); console.log(timingLine(s)); ev.event('check.timing', s); ev.event('case.closed', data) }
// A cancelled run stops its builds, closes its record honestly, and exits; it never leaves servers or an unfinished record.
process.on('SIGTERM', async () => { await stopAll(); try { close({ outcome: 'cancelled' }) } catch {} ; console.log('run cancelled'); process.exit(130) })

let cmp
try { cmp = await compareBuilds({ adapter, baseRef: goodRef, candRef, port, actions, readOnly }) } catch (e) {
  const msg = String(e.message ?? e).split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 300)
  console.log(`a build failed to start, so the versions could not be compared: ${msg}`)
  ev.claim('verified_fact', `A build failed to start, so the two versions could not be compared: ${msg}`, { evidence: [ev.artifact('error.txt', String(e.stack ?? e).slice(0, 4000))] })
  close({ outcome: 'build failed' }); process.exit(3)
}
const { baseline, cand, control } = cmp
summaryLines(cmp, goodRef, candRef).forEach(l => console.log(l))
ev.event('builds.compared', { good: { ref: goodRef, sha: cmp.baseSha }, candidate: { ref: candRef, sha: cmp.candSha } })
const nVolAll = Object.keys(baseline.volatile).length, nLearned = cmp.learned?.added ?? 0, nVol = nVolAll - nLearned, nAll = nVolAll + Object.keys(baseline.stable).length
const baseH = ev.artifact('baseline.json', { labels: baseline.labels, stable: Object.keys(baseline.stable).length, volatile: baseline.volatile }, 'application/json')
const diffH = ev.artifact('facts-diff.json', { control, candidate: cand }, 'application/json')
ev.claim('statistical', `${nVol} of ${nAll} recorded facts (${(100 * nVol / nAll).toFixed(1)}%) differed between two identical installs of ${goodRef}, so they are ignored when comparing.${nLearned ? ` A control recording then disagreed on ${nLearned} more, so those are ignored too (found over ${cmp.learned.rounds} extra recording${cmp.learned.rounds === 1 ? '' : 's'}).` : ''}`, { evidence: [baseH] })
if (control.length) {
  console.log(`control run shows ${control.length} differences: masking is not trustworthy, stopping`)
  close({ outcome: 'masking not trustworthy' }); process.exit(1)
}
ev.claim('verified_fact', `${nLearned ? 'A further recording' : 'A third recording'} of ${goodRef} showed 0 differences from the baseline, so the noise filter holds.`, { evidence: [diffH] })
if (!cand.some(d => d.kind === 'changed')) {
  const gone = cand.filter(d => d.kind === 'removed'), n = k => cand.filter(d => d.kind === k).length
  if (gone.length) { // nothing changed value, but things that existed before are missing now: never recommend shipping on that
    const eg = gone.slice(0, 3).map(d => d.key.split('/').slice(-2).join('/')).join(', ')
    console.log(`no value changed, but ${gone.length} recorded facts disappeared (${eg}); no test was written`)
    ev.claim('verified_fact', `No recorded value changed, but ${gone.length} fact${gone.length === 1 ? '' : 's'} present on ${goodRef} ${gone.length === 1 ? 'is' : 'are'} missing on ${candRef} (for example ${eg}). No test was written for a missing element.`, { evidence: [diffH] })
    close({ outcome: 'facts missing' }); process.exit(0)
  }
  console.log('no changed facts between the builds; nothing to turn into a test')
  ev.claim('verified_fact', `No recorded value differs between ${goodRef} and ${candRef} across ${actions.length} step${actions.length === 1 ? '' : 's'} (${n('added')} new and ${n('moved')} moved elements, 0 changed, 0 missing).`, { evidence: [diffH] })
  close({ outcome: 'no changed facts' }); process.exit(0)
}
const changed = cand.filter(d => d.kind === 'changed')
const short = k => k.split('/').slice(-2).join('/')
const cut = (v, n) => { const t = JSON.stringify(v); return t.length > n ? t.slice(0, n) + '...' : t } // shown shortened, never cut silently
ev.claim('verified_fact', `${candRef} differs from ${goodRef} in ${changed.length} recorded value${changed.length === 1 ? '' : 's'}: ${changed.slice(0, 4).map(d => `${short(d.key)} was ${cut(d.was, 90)}, now ${cut(d.now, 90)}`).join('; ')}.`, { evidence: [diffH] })

const probe = await startBuild({ adapter, ref: goodRef, port })
const origin = new URL(probe.base).origin, start = new URL(probe.base + '/').pathname
await probe.stop()
const { findings, skipped } = selectFindings(changed, actions, start, baseline, { max: maxFindings })
if (readOnly) for (const f of findings) f.readOnly = true
if (!findings.length) { console.log('none of the changed facts can be written as a test'); close({ outcome: 'no testable change' }); process.exit(0) }
const dir = join('out', 'regression', `${goodRef}-vs-${candRef}`.replace(/[^\w.-]/g, '_'))
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
writeExport(dir, findings)
const specH = {}
for (const f of findings) {
  specH[f.id] = ev.artifact(`${f.id}.spec.js`, readFileSync(join(dir, f.id + '.spec.js'), 'utf8'), 'text/javascript')
  ev.event('test.exported', { id: f.id, fact: f.fact.key, good: f.expected, candidate: f.actual })
  console.log(`test written: ${join(dir, f.id + '.spec.js')}\n  fact: ${f.fact.key.slice(-70)}\n  good: ${f.expected.slice(0, 80)}\n  cand: ${f.actual.slice(0, 80)}`)
}
if (skipped.length) console.log(`${skipped.length} other changed fact${skipped.length === 1 ? '' : 's'} not tested separately (${[...new Set(skipped.map(k => k.why.replace(/ \d+/, ' N')))].join('; ')})`)

// Every run of every test gets its own freshly seeded build, so one test cannot change the state another sees. In a sandbox several
// builds run at once (BEHIQUE_POOL, default 3), each on its own port; on this machine builds share the port, so they run one at a time.
timing.setPhase('tests')
const sandboxCfg = sandboxConfigFromEnv(process.env)
const pool = poolSize({ setting: Number(process.env.BEHIQUE_POOL), sandbox: Boolean(sandboxCfg), perBuildMemoryMb: sandboxCfg?.limits?.memoryMb, freeMemoryMb: Number(process.env.BEHIQUE_POOL_MEMORY_MB) || undefined })
if (pool > 1) console.log(`running ${pool} builds at once`)
const originFor = b => new URL(b.base).origin
const onBuild = async (ref, slot, work) => { // one fresh build on the slot's port, then `work`, then the build is stopped whatever happened
  const p = slotPort(port, slot) ?? port
  const b = await startBuild({ adapter, ref, port: p })
  try { return { sha: b.sha, value: await work(b) } } finally { await b.stop() }
}
const runsOf = { [goodRef]: {}, [candRef]: {} }, runLog = []
const jobs = []
for (const ref of [goodRef, candRef]) for (const f of findings) { runsOf[ref][f.id] = []; for (let n = 0; n < runs; n++) jobs.push({ ref, f, n }) }
const ran = await runPool(jobs, ({ ref, f }, slot) => onBuild(ref, slot, b => runExportedAsync(dir, originFor(b), { only: f.id })), { size: pool })
for (let i = 0; i < jobs.length; i++) { // recorded in job order, so the log reads the same whatever ran first
  const { ref, f, n } = jobs[i], got = ran[i]
  const r = got.ok ? got.value.value : { error: got.error, results: {} }
  const sha = got.ok ? got.value.sha : null
  const outcome = r.error ? 'error' : r.results[f.id] === true ? 'passed' : 'failed'
  runsOf[ref][f.id].push(r)
  runLog.push({ id: f.id, ref, sha, n: n + 1, outcome, ...(outcome === 'failed' ? { message: (r.errors?.[f.id] ?? '').split('\n').slice(0, 6).join('\n') } : {}), ...(outcome === 'error' ? { message: String(r.error).slice(0, 300) } : {}) })
  ev.event('test.run', { id: f.id, ref, sha, n: n + 1, outcome })
  console.log(`  run ${f.id} ${ref} ${n + 1}/${runs}: ${outcome}`)
}
const judged = findings.map(f => judgeFindings([f], runsOf[goodRef][f.id], runsOf[candRef][f.id])[0])
const runsH = ev.artifact('test-runs.json', runLog, 'application/json')
for (const j of judged) {
  ev.event('test.judged', { id: j.id, verdict: j.verdict, goodPassed: j.goodPassed, candFailed: j.candFailed, runs })
  console.log(`\n${j.id}: ${goodRef} (good) passed ${j.goodPassed}/${runs}, ${candRef} (candidate) failed ${j.candFailed}/${runs}: ${j.verdict}`)
  if (j.verdict === 'confirmed') ev.claim('reproduced_failure', `The test ${j.id} passed ${runs} of ${runs} runs on ${goodRef} and failed ${runs} of ${runs} runs on ${candRef}, each run on a freshly seeded build.`, { evidence: [specH[j.id], runsH] })
  else ev.claim('statistical', `The test ${j.id} passed ${j.goodPassed} of ${runs} runs on ${goodRef} and failed ${j.candFailed} of ${runs} on ${candRef}. That is not consistent enough to call a regression.`, { evidence: [runsH] })
}
console.log(`\n${summarize(judged, skipped)}`)
const first = firstConfirmed(judged)
const confirmed = Boolean(first)
console.log(confirmed ? '\nCONFIRMED: reproducible behaviour change, test passes on good and fails on candidate every time' : `\nNOT CONFIRMED: ${JSON.stringify(judged)}`)

// Pictures for a person: the page at the step where each confirmed change shows up, on the good version (twice, so the
// difference between two runs of the SAME version is the noise floor) and on the candidate. They are a lead for the eye, never the proof:
// a change that lives in an attribute looks identical in a picture, and the claim says exactly that.
const shotSteps = [...new Set(judged.filter(j => j.verdict === 'confirmed').map(j => findings.find(f => f.id === j.id).fact.i))].sort((a, b) => a - b)
if (shotSteps.length) {
  timing.setPhase('shots')
  try {
    // A crawled step list holds several flows, each starting over with `goto /`: a screenshot replays only the flow its step is in,
    // like the test does, in a fresh browser on a fresh build.
    const flowStart = i => { for (let g = i - 1; g >= 0; g--) if (actions[g]?.type === 'goto' && actions[g].path === '/') return g + 1; return 0 }
    const groups = new Map()
    for (const step of shotSteps) groups.set(flowStart(step), [...(groups.get(flowStart(step)) ?? []), step])
    // one build per (version, flow): good twice and the candidate once, through the same pool as the test runs
    const shotJobs = []
    for (const which of ['goodA', 'goodB', 'cand']) for (const [from, steps] of groups) shotJobs.push({ which, ref: which === 'cand' ? candRef : goodRef, from, steps })
    const taken = await runPool(shotJobs, ({ ref, from, steps }, slot) => onBuild(ref, slot, b => captureShots(b.base, actions.slice(from), steps.map(x => x - from), { readOnly })), { size: pool })
    const shots = { goodA: {}, goodB: {}, cand: {} }
    taken.forEach((t, i) => { if (!t.ok) throw new Error(t.error); for (const [k, png] of Object.entries(t.value.value)) shots[shotJobs[i].which][+k + shotJobs[i].from] = png })
    const goodA = shots.goodA, goodB = shots.goodB, candShots = shots.cand
    for (const step of shotSteps) {
      const forSteps = judged.filter(j => j.verdict === 'confirmed' && findings.find(f => f.id === j.id).fact.i === step).map(j => j.id)
      const r = recordShots({ ev, step, label: baseline.labels[step], goodRef, candRef, goodPng: goodA[step], candPng: candShots[step], floorPng: goodB[step] })
      ev.event('shots.recorded', { step, label: baseline.labels[step], findings: forSteps, above: r.above, text: r.text, good: r.hashes[0], candidate: r.hashes[1], diff: r.hashes[2] })
      console.log(`screenshot after step ${step}: ${r.above ? 'the pictures differ' : 'the pictures look the same'}`)
    }
  } catch (e) { // pictures are extra evidence: a failure here must not change the result of the check
    const msg = String(e.message ?? e).split('\n')[0].slice(0, 200)
    ev.event('shots.failed', { reason: msg })
    console.log(`screenshots unavailable: ${msg}`)
  }
}

let found = null // --bisect: only worth doing once a regression is confirmed, and only for the first confirmed test
if (confirmed && args.includes('--bisect')) {
  timing.setPhase('bisect')
  const { bisect } = await import('./bisect.mjs')
  const blog = []
  found = await bisect({ adapter, goodRef, badRef: candRef, dir, id: first.id, port, runs, log: l => { console.log(l); blog.push(l) }, onEvent: (type, data) => ev.event('bisect.' + type, data) })
  const bisH = ev.artifact('bisect.json', { result: found, log: blog }, 'application/json')
  ev.event('bisect.done', { conclusive: found.conclusive, verified: found.verified, steps: found.steps, seconds: found.seconds })
  if (found.conclusive && found.verified) {
    ev.claim('reproduced_failure', `The first change that makes the test fail is ${found.commit.slice(0, 7)}, "${found.subject}" (${found.author}, ${found.date}). The change just before it passed ${runs} of ${runs} runs and it failed ${runs} of ${runs} runs. Found by binary search over ${found.changes} changes in ${found.steps} steps.`, { evidence: [bisH, specH[first.id]] })
    ev.claim('verified_fact', `That change touched ${found.files.length} file${found.files.length === 1 ? '' : 's'}: ${found.files.slice(0, 6).join(', ')}.`, { evidence: [bisH] })
  } else if (found.conclusive) {
    ev.claim('suspected_cause', `The search points at ${found.commit.slice(0, 7)}, "${found.subject}", but the verification runs were not clean, so this is a lead and not a result.`, { evidence: [bisH] })
  } else {
    ev.claim('suspected_cause', `The first bad change is one of ${found.range[1] - found.range[0] + 1} (changes #${found.range[0]} to #${found.range[1]}); the ones in between could not be tested.`, { evidence: [bisH] })
  }
}
close({ outcome: confirmed ? 'regression proven' : 'not confirmed', bisected: !!found })
console.log(`evidence log verified: ${ev.verify().ok}`)
const topFact = findings[0].fact, tally = Object.fromEntries([goodRef, candRef].map(ref => [ref, runsOf[ref][findings[0].id].map(r => (r.error ? `error: ${r.error}` : r.results[findings[0].id] === true))]))
writeFileSync(join(dir, 'result.json'), JSON.stringify({ goodRef, candRef, caseId, fact: topFact, tally, confirmed, findings: judged, skipped, bisect: found }, null, 1))
process.exit(confirmed ? 0 : 1)
