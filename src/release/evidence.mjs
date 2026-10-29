// Evidence store: everything a release check saw and concluded, as an append-only log plus saved evidence files.
//   <dir>/events.ndjson     one JSON event per line; each carries the sha256 of the previous line, so editing or
//                           deleting an earlier line is detectable (verify())
//   <dir>/artifacts/<sha>   evidence files, named by the sha256 of their content
// A claim is a labelled conclusion. The label says how much it can be trusted, and who may write it is enforced here,
// not by convention: only deterministic code can say something is a verified fact or a reproduced failure, a model
// can only offer a hypothesis, and only a person can record a ship or hold decision.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LABELS = {
  verified_fact:      { by: ['code'], proof: true, evidence: true, meaning: 'Observed directly by deterministic code, with the evidence saved.' },
  reproduced_failure: { by: ['code'], proof: true, evidence: true, meaning: 'A replayable test fails on the new version and passes on the old one, every time.' },
  statistical:        { by: ['code'], proof: true, evidence: true, meaning: 'A rate or count measured over repeated runs.' },
  suspected_cause:    { by: ['code', 'human'], proof: false, evidence: true, meaning: 'A lead about why, with evidence, but not proven.' },
  ai_hypothesis:      { by: ['model'], proof: false, evidence: false, meaning: 'A model’s guess. Never proof.' },
}
export const DECISIONS = ['ship', 'hold']

/** Why `by` may not write a claim with this label, or null if it may. The one place the authorship rule lives. */
export function writeError(label, by) {
  const rule = LABELS[label]
  if (!rule) return `unknown claim label "${label}"`
  return rule.by.includes(by) ? null : `${by} may not write a ${label} claim (allowed: ${rule.by.join(', ')})`
}

const ZERO = '0'.repeat(64)
export const sha = x => createHash('sha256').update(x).digest('hex')

export function openCase(dir) {
  const file = join(dir, 'events.ndjson')
  const ensure = () => mkdirSync(join(dir, 'artifacts'), { recursive: true }) // only when writing: reading a case never creates folders
  const lines = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
  const tail = () => { const l = lines(); return { seq: l.length, prev: l.length ? sha(l.at(-1)) : ZERO } }
  const hasArtifact = h => /^[0-9a-f]{64}$/.test(h) && existsSync(join(dir, 'artifacts', h))

  /** Append one event. Returns its sequence number. */
  function event(type, data = {}, by = 'code') {
    ensure()
    const { seq, prev } = tail()
    appendFileSync(file, JSON.stringify({ seq, ts: new Date().toISOString(), type, by, data, prev }) + '\n')
    return seq
  }

  /** Save evidence under its own hash and log that it exists. Returns the hash, which claims cite. */
  function artifact(name, content, mediaType = 'text/plain') {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 1))
    const hash = sha(buf)
    ensure()
    if (!hasArtifact(hash)) writeFileSync(join(dir, 'artifacts', hash), buf)
    event('artifact', { name, hash, bytes: buf.length, mediaType })
    return hash
  }

  /** Record a labelled conclusion. Throws unless the label is allowed for `by` and the cited evidence exists. */
  function claim(label, text, { by = 'code', evidence = [], model, extra = {} } = {}) {
    const rule = LABELS[label], bad = writeError(label, by)
    if (bad) throw new Error(bad)
    if (by === 'model' && !model) throw new Error('a model claim must name the model')
    if (typeof text !== 'string' || !text.trim()) throw new Error('a claim needs text')
    if (rule.evidence && !evidence.length) throw new Error(`a ${label} claim must cite evidence`)
    const { seq } = tail()
    for (const ref of evidence) {
      const ok = /^event:\d+$/.test(ref) ? +ref.slice(6) < seq : hasArtifact(ref)
      if (!ok) throw new Error(`evidence not found: ${ref}`)
    }
    return event('claim', { ...extra, label, text, evidence, ...(model ? { model } : {}) }, by) // extra first, so it can never override the label
  }

  /** A person records ship or hold. Later decisions do not erase earlier ones; the newest counts. */
  function decide(decision, { who = '', note = '', override = false, recommendation = null, supersedes = null } = {}) {
    if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of ${DECISIONS.join(', ')}`)
    // Validation (reason length, overrides, what may be decided when) lives in decision.mjs, so nothing here is silently truncated.
    // `recommendation` is what Behique recommended at that moment and `supersedes` the earlier decision this one replaces:
    // together they keep the person's choice and the system's advice separate, and the history intact.
    return event('decision', { decision, who: String(who), note: String(note), override: Boolean(override), recommendation, supersedes }, 'human')
  }

  const read = () => lines().map(l => JSON.parse(l))
  const rawLines = () => lines() // the exact bytes each event hash is computed over, so a viewer can re-check the chain itself

  /** Check the hash chain and that every evidence file still matches its name. */
  function verify() {
    const problems = []
    let prev = ZERO
    lines().forEach((l, i) => {
      let e; try { e = JSON.parse(l) } catch { problems.push(`line ${i}: not valid JSON`); return }
      if (e.seq !== i) problems.push(`line ${i}: sequence is ${e.seq}`)
      if (e.prev !== prev) problems.push(`event ${i}: the chain is broken (an earlier line was changed, removed or reordered)`)
      prev = sha(l)
      if (e.type === 'artifact') {
        const p = join(dir, 'artifacts', e.data.hash)
        if (!existsSync(p)) problems.push(`event ${i}: evidence file ${e.data.name} is missing`)
        else if (sha(readFileSync(p)) !== e.data.hash) problems.push(`event ${i}: evidence file ${e.data.name} was changed`)
      }
    })
    return { ok: !problems.length, events: lines().length, problems }
  }

  return { dir, event, artifact, claim, decide, read, rawLines, verify, artifactPath: h => (hasArtifact(h) ? join(dir, 'artifacts', h) : null) }
}

/** Pull the parts a report needs out of an event list. */
export function summarize(events) {
  const decisions = events.filter(e => e.type === 'decision')
  return {
    claims: events.filter(e => e.type === 'claim').map(e => ({ seq: e.seq, ts: e.ts, by: e.by, ...e.data })),
    artifacts: Object.fromEntries(events.filter(e => e.type === 'artifact').map(e => [e.data.hash, e.data])),
    decisions: decisions.map(e => ({ seq: e.seq, ts: e.ts, ...e.data })),
    decision: decisions.length ? { seq: decisions.at(-1).seq, ts: decisions.at(-1).ts, ...decisions.at(-1).data } : null,
    opened: events.find(e => e.type === 'case.opened')?.data ?? null,
  }
}

export function listCases(root) {
  return existsSync(root) ? readdirSync(root).filter(n => existsSync(join(root, n, 'events.ndjson'))).sort().reverse() : []
}
