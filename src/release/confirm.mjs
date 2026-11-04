// Turn the top changed fact between two builds into an exported Playwright test, then run it 3 times on each build.
//   node src/release/confirm.mjs <goodRef> <candidateRef> [--scenario share|scroll] [--port 8300] [--steps file] [--adapter name] [--app name --steps file] [--read-only] [--runs 3] [--max-findings 3] [--bisect]
// Each changed fact (earliest step per fact, at most --max-findings) becomes a test that states the good build's value. A test must PASS
// every run on the good build and FAIL every run on the candidate; every run of every test starts from its own freshly seeded build, so tests
// cannot change each other's state. Anything else (flaky, or passes on both) is not a confirmed regression. --bisect searches for the
// first bad change of the first confirmed test only.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runExportedAsync, writeExport } from '../export.mjs'
import { appearedStates, firstConfirmed, judgeFindings, selectFindings, summarize, vanishedRoots } from './findings.mjs'
import { changesText } from './claimtext.mjs'
import { LABEL, maskedAreas, noticePhrase, noticeSummary } from './notice.mjs'
import { captureShots, captureShotsWithCanvases, recordShots } from './shots.mjs'
import { setTiming, startBuild, stopAll } from './build.mjs'
import { poolSize, runPool, slotPort } from './pool.mjs'
import { sandboxConfigFromEnv } from './sandbox/backend.mjs'
import { createTiming, timingLine } from './timing.mjs'
import { compareBuilds, summaryLines } from './compare.mjs'
import { openCase } from './evidence.mjs'
import { anchor } from './anchor.mjs'
import { redactActions, withLogin } from './login.mjs'
import { compareCanvases, pickCanvasSteps, recordCanvases } from './canvas-check.mjs'
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
const profile = appName ? loadProfile(appName) : null
// a profile's login step runs first and again after every flow reset (`goto /`); its password is filled in but never written to the record
const actions = withLogin(JSON.parse(readFileSync(sc?.steps ?? opt('steps', 'bench/fixtures/freshrss/steps.json'), 'utf8')), profile?.login ?? null, process.env)

// Everything below is also written to an evidence case: an append-only log plus saved evidence files, with each
// conclusion recorded as a labelled claim (see evidence.mjs). The report page reads from it.
const caseId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_${goodRef}-vs-${candRef}`.replace(/[^\w.-]/g, '_')
const ev = openCase(join('out', 'evidence', caseId))
ev.event('case.opened', { goodRef, candRef, adapter: adapter.name, ...(appName ? { app: appName } : {}), steps: redactActions(actions), options: { bisect: args.includes('--bisect'), runs }, scenario: sc ? { name: scenario, label: sc.label, about: sc.about, upstream: sc.upstream } : null })
console.log(`evidence: ${caseId}`)
const timing = createTiming(); setTiming(timing) // where the time goes, by phase; written to the record and printed as one line at the end
const close = data => {
  const s = timing.summary(); console.log(timingLine(s)); ev.event('check.timing', s); ev.event('case.closed', data)
  // the head of the finished record goes to the ledger outside the case folder (and to a mirror elsewhere when BEHIQUE_ANCHOR_MIRROR names one)
  try { anchor(join('out', 'evidence'), caseId, ev, { mirror: process.env.BEHIQUE_ANCHOR_MIRROR || null }) } catch (e) { console.log(`not anchored: ${String(e.message).slice(0, 120)}`) }
}
// A cancelled run stops its builds, closes its record honestly, and exits; it never leaves servers or an unfinished record.
process.on('SIGTERM', async () => { await stopAll(); try { close({ outcome: 'cancelled' }) } catch {} ; console.log('run cancelled'); process.exit(130) })

// How many builds run at once (BEHIQUE_POOL, default 3), each on its own port; on this machine builds share the port, so they run one at a time. An adapter with no profile (FreshRSS) always builds here, sandbox or not (build.mjs).
// Used by the canvas comparison, the test runs and the screenshots alike.
const sandboxCfg = sandboxConfigFromEnv(process.env)
const pool = poolSize({ setting: Number(process.env.BEHIQUE_POOL), sandbox: Boolean(sandboxCfg && adapter.profile), perBuildMemoryMb: sandboxCfg?.limits?.memoryMb, freeMemoryMb: Number(process.env.BEHIQUE_POOL_MEMORY_MB) || undefined })
if (pool > 1) console.log(`running ${pool} builds at once`)
const onBuild = async (ref, slot, work) => { // one fresh build on the slot's port, then `work`, then the build is stopped whatever happened
  const p = slotPort(port, slot) ?? port
  const b = await startBuild({ adapter, ref, port: p })
  try { return { sha: b.sha, value: await work(b) } } finally { await b.stop() }
}
// A crawled step list holds several flows, each starting over with a `goto`: a replay runs only the flow its step is in, in a fresh browser on a fresh build.
// `goto /` is where a replay starts anyway and is left out; a direct load of another page is the flow's first action and is kept.
const flowStart = i => { for (let g = i - 1; g >= 0; g--) if (actions[g]?.type === 'goto') return actions[g].path === '/' ? g + 1 : g; return 0 }
const groupByFlow = steps => { const groups = new Map(); for (const step of steps) groups.set(flowStart(step), [...(groups.get(flowStart(step)) ?? []), step]); return groups }
/** The page at each step on the good version twice (the second is the noise floor) and on the candidate once, through the pool: { goodA, goodB, cand } of step -> result. */
const takeAt = async (steps, capture) => {
  const jobs = []
  for (const which of ['goodA', 'goodB', 'cand']) for (const [from, list] of groupByFlow(steps)) jobs.push({ which, ref: which === 'cand' ? candRef : goodRef, from, steps: list })
  const taken = await runPool(jobs, ({ ref, from, steps }, slot) => onBuild(ref, slot, b => capture(b, actions.slice(from), steps.map(x => x - from))), { size: pool })
  const out = { goodA: {}, goodB: {}, cand: {} }
  taken.forEach((t, i) => { if (!t.ok) throw new Error(t.error); for (const [k, v] of Object.entries(t.value.value)) out[jobs[i].which][+k + jobs[i].from] = v })
  return out
}

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
// What this check cannot see: every masked fact, and where on the page they sit. Recorded as an event for the report and said in the claim.
const { areas } = maskedAreas(baseline.volatile)
ev.event('masking.summary', { masked: nVolAll, total: nAll, learned: nLearned, areas })
const areaNote = nVolAll ? `${areas.length ? ` The masked facts sit mostly under ${areas.map(a => `${a.area} (${a.count})`).join(', ')}.` : ''} A change inside a masked fact cannot be seen by this check.` : ''
ev.claim('statistical', `${nVol} of ${nAll} recorded facts (${(100 * nVol / nAll).toFixed(1)}%) differed between two identical installs of ${goodRef}, so they are ignored when comparing.${nLearned ? ` A control recording then disagreed on ${nLearned} more, so those are ignored too (found over ${cmp.learned.rounds} extra recording${cmp.learned.rounds === 1 ? '' : 's'}).` : ''}${areaNote}`, { evidence: [baseH] })
if (nVolAll) console.log(`masked as noise: ${nVolAll} of ${nAll} facts${areas.length ? `, mostly under ${areas.map(a => `${a.area} (${a.count})`).join(', ')}` : ''}`)
if (control.length) {
  console.log(`control run shows ${control.length} differences: masking is not trustworthy, stopping`)
  close({ outcome: 'masking not trustworthy' }); process.exit(1)
}
ev.claim('verified_fact', `${nLearned ? 'A further recording' : 'A third recording'} of ${goodRef} showed 0 differences from the baseline, so the noise filter holds.`, { evidence: [diffH] })

// Canvas drawings: the recorded facts see a canvas only as a box with a size, so at the steps where one shows the drawing itself is
// compared pixel by pixel, inside the canvas box, against the noise floor of two good runs. A changed drawing is person-visible
// evidence on its own (recorded as a claim with the diff picture); it is not a repeatable test, and the record says so.
const canvasSteps = pickCanvasSteps(baseline, actions)
const canvasChanged = [] // { step, label, n } for each step where a canvas drawing changed beyond the floor
if (canvasSteps.length) {
  timing.setPhase('canvas')
  console.log(`canvas drawings at ${canvasSteps.length} step${canvasSteps.length === 1 ? '' : 's'}: comparing the pixels inside each canvas`)
  try {
    const got = await takeAt(canvasSteps, (b, acts, steps) => captureShotsWithCanvases(b.base, acts, steps, { readOnly }).then(r => Object.fromEntries(steps.map(s => [s, { png: r.shots[s], boxes: r.canvases[s] ?? [] }]))))
    for (const step of canvasSteps) {
      const boxes = got.goodA[step]?.boxes ?? []
      if (!boxes.length) { ev.event('canvas.compared', { step, label: baseline.labels[step], results: [] }); console.log(`  step ${step}: no canvas large enough to compare`); continue }
      const results = compareCanvases({ goodA: got.goodA[step].png, goodB: got.goodB[step].png, cand: got.cand[step].png, boxes })
      const r = recordCanvases({ ev, step, label: baseline.labels[step], goodRef, candRef, results, pngs: { goodA: got.goodA[step].png, cand: got.cand[step].png } })
      if (r.changed) canvasChanged.push({ step, label: baseline.labels[step], n: r.changed })
      for (const x of results) console.log(`  step ${step}: ${x.text}`)
    }
  } catch (e) { // the canvas comparison is extra evidence: a failure here must not change the result of the DOM check
    const msg = String(e.message ?? e).split('\n')[0].slice(0, 200)
    ev.event('canvas.failed', { reason: msg })
    console.log(`canvas comparison unavailable: ${msg}`)
  }
  timing.setPhase('compare')
}
// An element that is on the good version and gone from the candidate is a difference like any other: each vanished element (the
// root of what disappeared, not every attribute under it) becomes a test that expects the old value, so it fails on the candidate.
const vanished = vanishedRoots(cand, baseline) // with the baseline, a fact dropped from an element the candidate still has is its own entry, not a vanished element
// A state attribute newly set on an element both versions have (inert, disabled, hidden) is a change a person feels at once, and it
// becomes a test that expects the attribute absent, as on the good version.
const appeared = appearedStates(cand, baseline)
if (!cand.some(d => d.kind === 'changed') && !vanished.length && !appeared.length) {
  const n = k => cand.filter(d => d.kind === k).length
  console.log('no changed facts between the builds; nothing to turn into a test')
  ev.claim('verified_fact', `No recorded value differs between ${goodRef} and ${candRef} across ${actions.length} step${actions.length === 1 ? '' : 's'} (${n('added')} new and ${n('moved')} moved elements, 0 changed, 0 missing).`, { evidence: [diffH] })
  if (canvasChanged.length) { // the page's facts agree, but a drawing does not: that is a change a person would see, so no ship
    console.log(`but a canvas drawing changed at step${canvasChanged.length === 1 ? '' : 's'} ${canvasChanged.map(c => c.step).join(', ')}: HOLD`)
    close({ outcome: 'canvas changed', canvasSteps: canvasChanged.map(c => c.step) }); process.exit(1)
  }
  close({ outcome: 'no changed facts' }); process.exit(0)
}
const valueChanges = cand.filter(d => d.kind === 'changed')
const changed = [...valueChanges, ...appeared, ...vanished] // ranked: value changes first, then states newly set, then vanished elements
const short = k => k.split('/').slice(-2).join('/')
const attrName = k => (k.match(/@([^/@]+)$/) ?? [])[1] ?? k
const gone = vanished.filter(d => !d.stillThere), dropped = vanished.filter(d => d.stillThere) // gone: elements (and scroll areas) missing; dropped: facts lost from elements still there
const nGone = gone.reduce((a, d) => a + (d.vanished ?? 1), 0)
const parts = [
  valueChanges.length ? `${valueChanges.length} recorded value${valueChanges.length === 1 ? '' : 's'}` : null,
  appeared.length ? `${appeared.length} state attribute${appeared.length === 1 ? '' : 's'} newly set on ${candRef} (${[...new Set(appeared.map(d => attrName(d.key)))].slice(0, 4).join(', ')})` : null,
  gone.length ? `${gone.length} element${gone.length === 1 ? '' : 's'} present on ${goodRef} ${gone.length === 1 ? 'is' : 'are'} missing (${nGone} recorded fact${nGone === 1 ? '' : 's'})` : null,
  dropped.length ? `${dropped.length} recorded fact${dropped.length === 1 ? '' : 's'} dropped from element${dropped.length === 1 ? '' : 's'} still there (${[...new Set(dropped.map(d => attrName(d.key)))].slice(0, 4).join(', ')})` : null,
].filter(Boolean)
ev.claim('verified_fact', `${candRef} differs from ${goodRef} in ${parts.join(', and ')}: ${changesText(changed)}.`, { evidence: [diffH] }) // identical changes are counted once, so four copies of a version label do not hide the one state attribute
if (appeared.length) console.log(`${appeared.length} state attribute${appeared.length === 1 ? '' : 's'} newly set on ${candRef}: ${appeared.slice(0, 3).map(d => short(d.key)).join(', ')}`)
if (gone.length) console.log(`${gone.length} element${gone.length === 1 ? '' : 's'} vanished on ${candRef} (${nGone} facts): ${gone.slice(0, 3).map(d => short(d.key)).join(', ')}`)
if (dropped.length) console.log(`${dropped.length} fact${dropped.length === 1 ? '' : 's'} dropped from elements still there on ${candRef}: ${dropped.slice(0, 3).map(d => short(d.key)).join(', ')}`)

const probe = await startBuild({ adapter, ref: goodRef, port })
const origin = new URL(probe.base).origin, start = new URL(probe.base + '/').pathname
await probe.stop()
const { findings, skipped } = selectFindings(changed, actions, start, baseline, { max: maxFindings, origin, refs: { good: goodRef, cand: candRef } }) // ordered: what a person would notice first; third-party content skipped, the release's own version label ranked as churn
for (const f of findings) { f.origin = origin; if (readOnly) f.readOnly = true } // origin: so a test can swap it for the address of the build it runs against
if (!findings.length) {
  console.log('none of the changed facts can be written as a test')
  if (canvasChanged.length) { console.log(`but a canvas drawing changed at step${canvasChanged.length === 1 ? '' : 's'} ${canvasChanged.map(c => c.step).join(', ')}: HOLD`); close({ outcome: 'canvas changed', canvasSteps: canvasChanged.map(c => c.step) }); process.exit(1) }
  if (vanished.length) { // things that existed before are missing and no test could say so: never recommend shipping on that
    ev.claim('verified_fact', `${vanished.length} element${vanished.length === 1 ? '' : 's'} present on ${goodRef} ${vanished.length === 1 ? 'is' : 'are'} missing on ${candRef} and no test could be written for ${vanished.length === 1 ? 'it' : 'them'}.`, { evidence: [diffH] })
    close({ outcome: 'facts missing' }); process.exit(0)
  }
  close({ outcome: 'no testable change' }); process.exit(0)
}
const dir = join('out', 'regression', `${goodRef}-vs-${candRef}`.replace(/[^\w.-]/g, '_'))
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
writeExport(dir, findings.map(f => ({ ...f, goodRef, candRef }))) // the version names only name the recording's tag; the test itself is the same
const specH = {}
for (const f of findings) {
  specH[f.id] = ev.artifact(`${f.id}.spec.js`, readFileSync(join(dir, f.id + '.spec.js'), 'utf8'), 'text/javascript')
  ev.event('test.exported', { id: f.id, fact: f.fact.key, i: f.fact.i, good: f.expected, candidate: f.actual, notice: f.notice, ...(f.alike?.length ? { alike: f.alike } : {}), ...(f.fact.removed ? { removed: true, vanished: f.fact.vanished, ...(f.fact.stillThere ? { stillThere: true } : {}), ...(f.fact.names?.length ? { names: f.fact.names, namesTotal: f.fact.namesTotal } : {}) } : {}), ...(f.fact.appeared ? { appeared: true } : {}) })
  console.log(`test written: ${join(dir, f.id + '.spec.js')}\n  fact: ${f.fact.key.slice(-70)}\n  good: ${f.expected.slice(0, 80)}\n  cand: ${f.actual.slice(0, 80)}\n  class: ${LABEL[f.notice?.cls] ?? 'unknown'} (${f.notice?.why ?? ''})${f.alike?.length ? `\n  the same change on ${f.alike.length} other element${f.alike.length === 1 ? '' : 's'}: ${f.alike.map(k => k.split('/').slice(-2).join('/').replace(/@class$/, '')).join(', ')}` : ''}`)
}
if (skipped.length) console.log(`${skipped.length} other changed fact${skipped.length === 1 ? '' : 's'} not tested separately (${[...new Set(skipped.map(k => k.why.replace(/ \d+/, ' N')))].join('; ')})`)

// Every run of every test gets its own freshly seeded build, so one test cannot change the state another sees. In a sandbox several
// builds run at once (BEHIQUE_POOL, default 3), each on its own port; on this machine builds share the port, so they run one at a time.
timing.setPhase('tests')
const originFor = b => new URL(b.base).origin
const runsOf = { [goodRef]: {}, [candRef]: {} }, runLog = []
const jobs = []
for (const ref of [goodRef, candRef]) for (const f of findings) { runsOf[ref][f.id] = []; for (let n = 0; n < runs; n++) jobs.push({ ref, f, n }) }
const ran = await runPool(jobs, ({ ref, f }, slot) => onBuild(ref, slot, b => runExportedAsync(dir, originFor(b), { only: f.id, video: true })), { size: pool }) // video: every run is recorded; one passing and one failing recording per reproduced failure are kept
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
const judged = findings.map(f => ({ ...judgeFindings([f], runsOf[goodRef][f.id], runsOf[candRef][f.id])[0], notice: f.notice, alike: f.alike ?? [] }))
const runsH = ev.artifact('test-runs.json', runLog, 'application/json')
// A recording of one passing run on the good version and one failing run on the candidate, saved with the reproduced failure so a
// person can watch the test do what it does. The other recordings are deleted with the run folder below.
const recordingOf = (ref, id, passed) => {
  const r = runsOf[ref][id].find(x => x.results?.[id] === passed && x.videos?.[id] && existsSync(x.videos[id]))
  if (!r) return null
  const buf = readFileSync(r.videos[id])
  return buf.length > 8 ? ev.artifact(`${id}.${ref === goodRef ? 'good' : 'candidate'}.webm`, buf, 'video/webm') : null
}
for (const j of judged) {
  ev.event('test.judged', { id: j.id, verdict: j.verdict, goodPassed: j.goodPassed, candFailed: j.candFailed, runs, notice: j.notice, ...(j.alike.length ? { alike: j.alike } : {}) })
  console.log(`\n${j.id}: ${goodRef} (good) passed ${j.goodPassed}/${runs}, ${candRef} (candidate) failed ${j.candFailed}/${runs}: ${j.verdict}`)
  if (j.verdict === 'confirmed') {
    const vids = [recordingOf(goodRef, j.id, true), recordingOf(candRef, j.id, false)].filter(Boolean)
    const alikeText = j.alike.length ? ` The same change is on ${j.alike.length} other element${j.alike.length === 1 ? '' : 's'}, not tested separately.` : ''
    ev.claim('reproduced_failure', `The test ${j.id} passed ${runs} of ${runs} runs on ${goodRef} and failed ${runs} of ${runs} runs on ${candRef}, each run on a freshly seeded build. ${noticePhrase(j.notice)}${alikeText}`.trim(), { evidence: [specH[j.id], runsH, ...vids] })
    if (vids.length) console.log(`  recordings saved: ${vids.length} (one run each way)`)
  }
  else ev.claim('statistical', `The test ${j.id} passed ${j.goodPassed} of ${runs} runs on ${goodRef} and failed ${j.candFailed} of ${runs} on ${candRef}. That is not consistent enough to call a regression.`, { evidence: [runsH] })
}
rmSync(join(dir, 'test-results'), { recursive: true, force: true }) // the other recordings
const ns = noticeSummary(judged)
console.log(`\n${summarize(judged, skipped)}${ns.confirmed ? `; ${ns.visible} a person would notice, ${ns.churn} markup churn` : ''}`)
const first = firstConfirmed(judged) // the most noticeable confirmed finding, since findings are ranked
const confirmed = Boolean(first)
console.log(confirmed ? '\nCONFIRMED: reproducible behaviour change, test passes on good and fails on candidate every time' : `\nNOT CONFIRMED: ${JSON.stringify(judged)}`)
if (ns.churnOnly) console.log(`only markup churn was proven (${ns.churn} finding${ns.churn === 1 ? '' : 's'}): nothing a person would notice changed, so the recommendation is SHIP with a note, not HOLD`)

// Pictures for a person: the page at the step where each confirmed change shows up, on the good version (twice, so the
// difference between two runs of the SAME version is the noise floor) and on the candidate. They are a lead for the eye, never the proof:
// a change that lives in an attribute looks identical in a picture, and the claim says exactly that.
const shotSteps = [...new Set(judged.filter(j => j.verdict === 'confirmed').map(j => findings.find(f => f.id === j.id).fact.i))].sort((a, b) => a - b)
if (shotSteps.length) {
  timing.setPhase('shots')
  try {
    // one build per (version, flow): good twice and the candidate once, through the same pool as the test runs
    const shots = await takeAt(shotSteps, (b, acts, steps) => captureShots(b.base, acts, steps, { readOnly }))
    const goodA = shots.goodA, goodB = shots.goodB, candShots = shots.cand
    for (const step of shotSteps) {
      const forSteps = judged.filter(j => j.verdict === 'confirmed' && findings.find(f => f.id === j.id).fact.i === step).map(j => j.id)
      const r = recordShots({ ev, step, label: baseline.labels[step], goodRef, candRef, goodPng: goodA[step], candPng: candShots[step], floorPng: goodB[step] })
      ev.event('shots.recorded', { step, label: baseline.labels[step], findings: forSteps, above: r.above, shift: r.shift ?? null, text: r.text, good: r.hashes[0], candidate: r.hashes[1], diff: r.hashes[2] })
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
close({ outcome: confirmed ? 'regression proven' : canvasChanged.length ? 'canvas changed' : 'not confirmed', bisected: !!found, ...(canvasChanged.length ? { canvasSteps: canvasChanged.map(c => c.step) } : {}) })
console.log(`evidence log verified: ${ev.verify().ok}`)
const topFact = findings[0].fact, tally = Object.fromEntries([goodRef, candRef].map(ref => [ref, runsOf[ref][findings[0].id].map(r => (r.error ? `error: ${r.error}` : r.results[findings[0].id] === true))]))
writeFileSync(join(dir, 'result.json'), JSON.stringify({ goodRef, candRef, caseId, fact: topFact, tally, confirmed, findings: judged, skipped, bisect: found }, null, 1))
process.exit(confirmed || canvasChanged.length ? 0 : 1)
