// Turn one saved report (an evidence case) into the exact shape the dashboard UI renders. Pure and read-only:
// it computes nothing the record does not already hold, so the UI can be a plain renderer.
//
// Verdict is Behique's RECOMMENDATION from the record, never a decision (a person decides):
//   running       no case.closed event yet (or none and the last event is under 15 minutes old)
//   hold          a replayable test proved the behaviour differs (a reproduced_failure claim exists) and at least one proven change
//                 is something a person would notice (or the report predates the classes)
//   ship          the run closed with no changed facts: nothing differed in the recorded steps; or every proven change is markup
//                 churn (generated ids, framework attributes), which the sub line says plainly
//   inconclusive  changes were seen but not proven by a stable, repeatable test
//   fail          evidence is incomplete: the noise filter could not be trusted, the build failed, or the run died
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { anchorText, verifyAnchors } from './anchor.mjs'
import { appOfOpened } from './appregistry.mjs'
import { visualView } from './ui/visual-view.mjs'
import { sha, summarize } from './evidence.mjs'
import { LABEL, RANK, maskedSentence, noticeSummary } from './notice.mjs'
import { plainClaim } from './claimtext.mjs'

const STALE_MS = 15 * 60 * 1000
const APP_NAMES = { freshrss: 'FreshRSS' }
const KIND = {
  verified_fact: { label: 'Verified Fact', cls: 'green', color: '#2fd98a' },
  reproduced_failure: { label: 'Reproduced Failure', cls: 'red', color: '#ff4d57' },
  statistical: { label: 'Statistical', cls: 'blue', color: '#3aa0ff' },
  suspected_cause: { label: 'Suspected Cause', cls: 'purple', color: '#b388ff' },
  ai_hypothesis: { label: 'AI Hypothesis', cls: 'purple', color: '#b388ff' },
}
const day = ts => ts.slice(0, 19).replace('T', ' ')
const sha7 = s => String(s ?? '').slice(0, 7)

export function verdictOf(events, s, now = Date.now()) {
  const closed = events.find(e => e.type === 'case.closed')
  if (!closed) return now - Date.parse(events.at(-1).ts) > STALE_MS ? 'fail' : 'running'
  if (s.claims.some(c => c.label === 'reproduced_failure')) return churnOnly(events) ? 'ship' : 'hold'
  switch (closed.data.outcome) {
    case 'no changed facts': case 'no candidate defects': return 'ship'
    case 'canvas changed': return 'hold' // a drawing changed beyond the noise floor of two good runs: a person would see it, even with no DOM fact to test
    case 'masking not trustworthy': case 'build failed': case 'cancelled': return 'fail'
    default: return 'inconclusive'
  }
}

const whereOf = key => key.replace(/(@[^/]+|#text|#scrolls)$/, '').split('/').slice(-2).join('/')
const whatOf = key => key.match(/@([^/]+)$/)?.[1] ?? (key === 'window@scrollY' ? 'scrollY' : 'text')
const unquote = v => { try { return JSON.parse(v) } catch { return v } }

/** The exported findings, most noticeable first: id, class, why, where, what, both values, step and verdict. Empty for older reports. */
export function findingsView(events) {
  const verdicts = new Map(events.filter(e => e.type === 'test.judged').map(e => [e.data.id, e.data.verdict]))
  const list = events.filter(e => e.type === 'test.exported' && typeof e.data.fact === 'string').map(e => {
    const d = e.data, cls = d.notice?.cls ?? null
    return { id: d.id, cls, label: cls ? LABEL[cls] : null, why: d.notice?.why ?? null, where: whereOf(d.fact), what: whatOf(d.fact), was: d.appeared ? 'absent' : unquote(d.good), now: d.removed ? 'missing' : unquote(d.candidate), step: d.i ?? null, verdict: verdicts.get(d.id) ?? 'pending', ...(d.removed ? { removed: true, vanished: d.vanished ?? 1 } : {}), ...(d.appeared ? { appeared: true } : {}) }
  })
  return list.map((f, i) => [f, i]).sort((a, b) => (RANK[a[0].cls] ?? 9) - (RANK[b[0].cls] ?? 9) || a[1] - b[1]).map(([f]) => f)
}

/** The build panes' rows: the findings when the report has them (ranked, with their class), else the first changed facts as before. */
function factsView(events, changed) {
  const findings = findingsView(events)
  if (findings.length) return findings.slice(0, 5).map(f => ({ where: f.where, what: f.what, was: f.was, now: f.now, step: f.step ?? '', id: f.id, cls: f.cls, label: f.label, why: f.why, verdict: f.verdict, ...(f.removed ? { removed: true, vanished: f.vanished } : {}) }))
  return changed.slice(0, 4).map(d => ({ where: whereOf(d.key), what: whatOf(d.key), was: d.was, now: d.now, step: d.step }))
}

/** What the check could not see: the masked facts and where they sit, as one sentence, or null for an older report. */
function maskedView(events) {
  const m = events.find(e => e.type === 'masking.summary')?.data
  return m ? { masked: m.masked, total: m.total, areas: m.areas ?? [], text: maskedSentence({ masked: m.masked, total: m.total, areas: m.areas ?? [] }) } : null
}

/** True when every confirmed finding is classed as markup churn (needs the classes, so never true for an older report). */
export function churnOnly(events) {
  return noticeSummary(events.filter(e => e.type === 'test.judged').map(e => e.data)).churnOnly
}

/** The tested steps plus evenly spaced inferred commits, at most 15 nodes, each good / culprit / bad by position. */
function bisectNodes(steps, n, culpritAt, onlyTested = false) {
  const tested = new Map(steps.filter(t => t.verdict !== 'skip').map(t => [t.index, t]))
  if (onlyTested) return [...tested.values()].sort((a, b) => a.index - b.index).map(t => ({ hash: t.sha, index: t.index, verdict: t.verdict, tested: true, step: t.step }))
  const want = new Set([1, n, ...tested.keys()])
  for (let k = 1; want.size < Math.min(15, n) && k < 15; k++) want.add(Math.max(1, Math.round((k * n) / 15)))
  const picked = [...want].sort((a, b) => a - b).slice(0, 15)
  return picked.map(i => {
    const t = tested.get(i)
    const verdict = culpritAt == null ? 'good' : i === culpritAt ? 'culprit' : i < culpritAt ? 'good' : 'bad'
    return { hash: t ? t.sha : `#${i}`, index: i, verdict, tested: Boolean(t), step: t ? t.step : null }
  })
}

/** Where a run in flight is up to, read from the record alone. null once the run has closed. */
export function progressOf(events, s, stepEv = []) {
  if (events.some(e => e.type === 'case.closed')) return null
  const runs = s.opened?.options?.runs ?? 3, total = 2 * runs * Math.max(1, events.filter(e => e.type === 'test.exported').length) // each finding is run on its own fresh builds
  const ev = t => events.find(e => e.type === t)
  if (!ev('builds.compared')) return { phase: 'recording', fraction: 0.05, text: 'Recording both versions from clean installs (about 15 seconds)' }
  if (ev('bisect.verifying')) return { phase: 'verifying', fraction: 0.9, text: 'Double-checking the answer' }
  const started = ev('bisect.started')?.data
  if (started) {
    const last = stepEv.at(-1), left = last ? last.badFrom - last.goodThrough : started.changes
    const done = 1 - Math.log2(Math.max(left, 1)) / Math.log2(Math.max(started.changes, 2))
    return { phase: 'searching', fraction: 0.4 + 0.5 * done, text: `Searching ${started.changes} code changes: step ${stepEv.length + 1}, ${left} still possible` }
  }
  const ran = events.filter(e => e.type === 'test.run').length
  if (!ev('test.exported')) return { phase: 'comparing', fraction: 0.15, text: 'Comparing the versions and writing the test' }
  if (ran < total) return { phase: 'testing', fraction: 0.2 + 0.2 * (ran / total), text: `Running the test on fresh installs, ${ran} of ${total} done` }
  if (s.opened?.options?.bisect && s.claims.some(k => k.label === 'reproduced_failure')) return { phase: 'searching', fraction: 0.4, text: 'Starting the search for the exact change' }
  return { phase: 'finishing', fraction: 0.95, text: 'Finishing' }
}

/** One decision as the dashboard shows it, next to what Behique recommended when it was made. */
function decisionView(d) {
  const rec = d.recommendation ?? null // older decisions carry no recommendation
  return { seq: d.seq, choice: d.decision.toUpperCase(), reason: d.note ?? '', who: d.who ?? '', time: d.ts.slice(11, 16), ts: d.ts, override: Boolean(d.override), recommendation: rec, agrees: rec === 'hold' || rec === 'ship' ? rec === d.decision : null, supersedes: d.supersedes ?? null }
}

export function buildViewModel(c, { caseId, now = Date.now() } = {}) {
  const events = c.read(), raw = c.rawLines(), hashes = raw.map(sha), s = summarize(events)
  if (!events.length) throw new Error('this record is empty or does not exist')
  const o = s.opened ?? {}
  const art = name => { const a = Object.values(s.artifacts).find(x => x.name === name); return a ? JSON.parse(readFileSync(c.artifactPath(a.hash), 'utf8')) : null }
  const urlOf = h => `/api/artifact?id=${encodeURIComponent(caseId)}&hash=${h}`
  const verdict = verdictOf(events, s, now)
  const app = o.kind === 'visual' ? String(o.adapter ?? '').replace(/^visual-/, '') : APP_NAMES[String(o.adapter ?? '').split('-')[0]] ?? o.adapter ?? 'App'
  const builds = events.find(e => e.type === 'builds.compared')?.data

  // the search for the first bad change, from the saved search record
  const b = art('bisect.json'), log = b?.log ?? [], r = b?.result ?? null
  const stepEv = events.filter(e => e.type === 'bisect.step').map(e => e.data) // newer reports record each step as it happens
  const startedEv = events.find(e => e.type === 'bisect.started')?.data
  const steps = stepEv.length ? stepEv.map(d => ({ step: d.step, sha: d.sha, index: d.index, verdict: d.verdict }))
    : log.map(l => l.match(/bisect step (\d+): (\w+) \(#(\d+) of (\d+)\) (good|bad|skip)/)).filter(Boolean).map(m => ({ step: +m[1], sha: m[2], index: +m[3], verdict: m[5] }))
  const closedRange = stepEv.length && stepEv.at(-1).badFrom - stepEv.at(-1).goodThrough === 1 ? stepEv.at(-1).badFrom : null
  const culpritAt = closedRange ?? (+(log.map(l => l.match(/first bad change is #(\d+) of/)).find(Boolean)?.[1] ?? 0) || null)
  const changes = r?.changes ?? startedEv?.changes ?? null
  const partial = !r && startedEv ? {
    changes, steps: steps.length, conclusive: false, verified: false, partial: true, nodes: bisectNodes(steps, changes, null, true),
    ends: { left: `${sha7(builds?.good?.sha)} (good)`, right: `${sha7(builds?.candidate?.sha)} (bad)`, culprit: null }, commit: null, verifiedText: '',
  } : null
  const bisect = partial ?? (r && changes ? {
    changes, steps: r.steps, conclusive: r.conclusive, verified: r.verified, nodes: bisectNodes(steps, changes, r.conclusive ? culpritAt : null),
    ends: { left: `${sha7(builds?.good?.sha)} (good)`, right: `${sha7(builds?.candidate?.sha)} (bad)`, culprit: r.commit ? `${sha7(r.commit)} ${r.subject?.match(/\(#\d+\)/)?.[0]?.slice(1, -1) ?? ''}`.trim() : null },
    commit: r.commit ? { sha: r.commit, subject: r.subject, author: r.author, date: r.date, files: r.files, url: r.url } : null,
  } : null)

  const claimEv = events.filter(e => e.type === 'claim' || e.type === 'decision')
  const bisectArt = Object.values(s.artifacts).find(a => a.name === 'bisect.json')?.hash
  const claims = claimEv.map(e => {
    const link = { hash: hashes[e.seq], prevHash: events[e.seq - 1] ? hashes[e.seq - 1] : 'GENESIS', timestamp: day(e.ts), actor: e.by, seq: e.seq }
    if (e.type === 'decision') {
      const who = e.data.who ? ` (${e.data.who})` : ''
      return { id: 'h' + e.seq, kind: 'human_decision', label: 'Human Decision', cls: 'gold', color: '#d4a017', text: e.data.note || (e.data.decision === 'ship' ? 'Ship' : 'Hold'), foot: `actor: human${who} . ${e.ts.slice(11, 16)}`, chips: ['decision', ...(e.data.override ? ['against recommendation'] : [])], links: [], linkUrls: [], decision: e.data, ...link }
    }
    const d = e.data, k = KIND[d.label], names = d.evidence.map(h => s.artifacts[h]?.name ?? h.slice(0, 8))
    const ai = d.label === 'ai_hypothesis'
    return {
      id: 'c' + e.seq, kind: d.label, ...k, text: d.text, plain: plainClaim(d.text), ...link, // `text` is what the hash covers; `plain` is the same facts for a quick read, or null
      foot: ai ? (d.source === 'canvas-vision' ? 'a model\'s guess about what is on the screen . not proof' : `${d.grounded ? 'quote verified in the change' : 'quote NOT found in the change'} . confidence ${d.confidence}`) : names.length ? `${names.length} evidence file${names.length === 1 ? '' : 's'}` : 'no evidence cited',
      chips: ai ? ['hypothesis', 'unproven'] : d.label === 'verified_fact' ? ['verified'] : [],
      links: names, linkUrls: d.evidence.map(h => (/^[0-9a-f]{64}$/.test(h) ? urlOf(h) : null)),
      ...(ai ? { model: d.model, quote: d.quote, howToCheck: d.howToCheck, grounded: d.grounded, estUsd: d.estUsd } : {}),
      isCulprit: d.label === 'reproduced_failure' && Boolean(bisectArt) && d.evidence.includes(bisectArt),
    }
  })

  if (bisect) { // how the answer was verified, in the record's own words
    const m = claims.find(k => k.isCulprit)?.text.match(/passed (\d+) of (\d+) runs and it failed (\d+) of (\d+)/)
    bisect.verifiedText = m ? `verified ${m[1]}/${m[2]} and ${m[3]}/${m[4]}` : bisect.verified ? 'verified' : 'not verified'
  }
  const imgUrl = h => (/^[0-9a-f]{64}$/.test(h ?? '') ? `/api/artifact-image?id=${encodeURIComponent(caseId)}&hash=${h}` : null)
  const pictures = events.filter(e => e.type === 'shots.recorded').map(e => ({ step: e.data.step, label: e.data.label, findings: e.data.findings ?? [], differs: Boolean(e.data.above), text: e.data.text, good: imgUrl(e.data.good), candidate: imgUrl(e.data.candidate), diff: imgUrl(e.data.diff) })) // screenshots of the step where a change shows; a lead for the eye, never the proof
  const calls = events.filter(e => e.type === 'model.call')
  const changed = (art('facts-diff.json')?.candidate ?? []).filter(d => d.kind === 'changed')
  const judged = events.filter(e => e.type === 'test.judged') // newer reports judge each exported test; older ones have none
  const nProven = o.kind === 'canvas' || o.kind === 'visual' ? s.claims.filter(k => k.label === 'reproduced_failure').length : judged.length ? judged.filter(e => e.data.verdict === 'confirmed').length : events.filter(e => e.type === 'test.exported').length // a canvas case proves a change with a reproduced failure, not an exported test
  const last = s.decision
  const progress = progressOf(events, s, steps.length ? stepEv : [])
  const ns = noticeSummary(judged.map(e => e.data)) // how many proven changes a person would notice, and how many are markup churn
  const classed = judged.some(e => e.data.notice?.cls)
  const bisectNote = bisect ? (bisect.partial ? `, search ${events.find(e => e.type === 'case.closed')?.data.outcome === 'cancelled' ? 'cancelled' : 'not finished'} after ${bisect.steps} step${bisect.steps === 1 ? '' : 's'}` : `, ${bisect.changes} commits bisected in ${bisect.steps} steps`) : ''
  const canvasHits = events.filter(e => e.type === 'canvas.compared').flatMap(e => (e.data.results ?? []).filter(r => r.above).map(r => ({ step: e.data.step, label: r.label })))
  const canvasNote = canvasHits.length ? `${canvasHits.length} canvas drawing${canvasHits.length === 1 ? '' : 's'} changed beyond the noise floor (step${new Set(canvasHits.map(h => h.step)).size === 1 ? '' : 's'} ${[...new Set(canvasHits.map(h => h.step))].join(', ')})` : ''
  const sub = {
    hold: nProven === 0 && canvasNote ? `${canvasNote}, no other recorded fact differs` : `${nProven} reproduced behaviour change${nProven === 1 ? '' : 's'}${classed ? ` (${ns.visible} a person would notice, ${ns.churn} markup churn)` : ''}${canvasNote ? `; ${canvasNote}` : ''}${bisectNote}`,
    ship: ns.churnOnly ? `Only markup churn changed: ${ns.churn} proven change${ns.churn === 1 ? '' : 's'} (generated ids, framework attributes, the release's own version label), nothing a person would notice${bisectNote}` : 'No behaviour changes found in the recorded steps',
    inconclusive: 'Changes seen, but not proven by a repeatable test',
    fail: events.find(e => e.type === 'case.closed')?.data.outcome === 'cancelled' ? 'Run cancelled, evidence incomplete' : 'Evidence incomplete',
    running: progress?.text ?? 'Running verification, please wait',
  }[verdict]
  const guesses = s.claims.filter(k => k.label === 'ai_hypothesis').length
  const outcome = events.find(e => e.type === 'case.closed')?.data.outcome
  const failReason = verdict !== 'fail' ? null : ({
    'cancelled': 'The run was cancelled before it finished.',
    'build failed': claims.at(-1)?.text ?? 'A build failed to start.',
    'masking not trustworthy': 'The repeat recording of the old version differed from its baseline, so the comparison cannot be trusted.',
  }[outcome] ?? 'The run stopped without finishing.')

  return {
    id: caseId, appId: appOfOpened(o), title: o.kind === 'canvas' ? `Canvas test app: ${o.candRef} (candidate) vs ${o.goodRef} (good)` : `${app} ${o.goodRef} (good) vs ${o.candRef} (candidate)`, app, goodRef: o.goodRef, candRef: o.candRef,
    scenario: o.scenario ?? null, verdict, sub, failReason, progress, claims, bisect, pictures, visual: visualView(c, { caseId }),
    culpritClaimId: claims.find(k => k.isCulprit)?.id ?? null,
    facts: factsView(events, changed),
    findings: findingsView(events),
    masked: maskedView(events),
    recommendation: verdict, // Behique's advice; the person's decision below is a separate thing
    decision: last ? decisionView(last) : null,
    decisionHistory: s.decisions.map(decisionView).reverse(), // newest first; earlier decisions are superseded, never removed
    decisions: s.decisions.length,
    canDecide: verdict !== 'running', canShip: verdict !== 'running' && verdict !== 'fail',
    model: { calls: calls.length, costUsd: calls.reduce((a, e) => a + (e.data.estUsd ?? 0), 0), guesses, limit: 3, canAsk: verdict !== 'running' && Boolean(bisect?.commit) && guesses < 3 },
    startedAt: events[0].ts, chain: c.verify(), events: events.length, rawLines: raw,
    anchors: anchorsOf(c), // the ledger outside the case folder: which events it covers, and whether the record still matches it
  }
}

function anchorsOf(c) {
  try { const r = verifyAnchors(dirname(c.dir), basename(c.dir), c, { mirror: process.env.BEHIQUE_ANCHOR_MIRROR || null }); return { ok: r.ok, anchored: r.anchored, total: r.total, since: r.since, problems: r.problems, text: anchorText(r) } } catch (e) { return { ok: null, anchored: 0, total: 0, since: 0, problems: [String(e.message)], text: `Anchor check unavailable: ${String(e.message).slice(0, 100)}` } }
}
