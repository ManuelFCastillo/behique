// Anchor the evidence chain outside the case folder: an append-only ledger of case head hashes.
// Run tests with: node --test src/release/anchor.test.mjs
import { createHash, } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha } from './evidence.mjs'

export const ZERO = '0'.repeat(64)

const CASE_ID_RULE = '/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/'
const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/

export function ledgerPath(root) {
  return join(root, 'anchors.ndjson')
}

export function headOf(c) {
  const lines = c.rawLines()
  const seq = lines.length
  if (seq === 0) return { seq: 0, head: ZERO }
  return { seq, head: sha(lines.at(-1)) }
}

function rawLedgerLines(path) {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (!text) return []
  const parts = text.split('\n')
  if (parts.length && parts.at(-1) === '') parts.pop()
  return parts
}

function ledgerPrevFor(lines) {
  if (lines.length === 0) return ZERO
  return createHash('sha256').update(lines.at(-1)).digest('hex')
}

function isoTs(now) {
  const v = now()
  if (v instanceof Date) return v.toISOString()
  return new Date(v).toISOString()
}

export function anchor(root, caseId, c, { now = () => new Date(), mirror = null } = {}) {
  if (!CASE_ID_RE.test(caseId)) throw new Error(`caseId must match ${CASE_ID_RULE}`)
  const { seq, head } = headOf(c)
  if (seq === 0) throw new Error('nothing to anchor')
  const path = ledgerPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const ts = isoTs(now)
  const prev = ledgerPrevFor(rawLedgerLines(path))
  const entry = { ts, caseId, seq, head, prev }
  appendFileSync(path, JSON.stringify(entry) + '\n')
  if (mirror) {
    mkdirSync(dirname(mirror), { recursive: true })
    const mPrev = ledgerPrevFor(rawLedgerLines(mirror))
    const mEntry = { ts, caseId, seq, head, prev: mPrev }
    appendFileSync(mirror, JSON.stringify(mEntry) + '\n')
  }
  return entry
}

export function readLedger(path) {
  if (!existsSync(path)) return { entries: [], problems: [] }
  const lines = rawLedgerLines(path)
  const entries = []
  const problems = []
  lines.forEach((line, i) => {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      problems.push(`line ${i}: not a ledger entry`)
      return
    }
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      problems.push(`line ${i}: not a ledger entry`)
      return
    }
    const expected = i === 0 ? ZERO : createHash('sha256').update(lines[i - 1]).digest('hex')
    if (e.prev !== expected) {
      problems.push(`line ${i}: the ledger chain is broken (an earlier entry was changed, removed or reordered)`)
    }
    entries.push(e)
  })
  return { entries, problems }
}

export function verifyAnchors(root, caseId, c, { mirror = null } = {}) {
  const raw = c.rawLines()
  const total = raw.length
  const path = ledgerPath(root)
  const { entries: allEntries, problems: ledgerProblems } = readLedger(path)
  const problems = [...ledgerProblems]
  const entries = allEntries.filter((e) => e && e.caseId === caseId)
  let anchored = 0
  for (const entry of entries) {
    if (entry.seq > total) {
      problems.push(`anchor at ${entry.ts}: the record lost events (it had ${entry.seq}, now ${total})`)
    } else if (sha(raw[entry.seq - 1]) !== entry.head) {
      problems.push(`anchor at ${entry.ts}: the record was changed after it was anchored at event ${entry.seq}`)
    } else {
      if (entry.seq > anchored) anchored = entry.seq
    }
  }
  if (mirror) {
    if (!existsSync(mirror)) {
      problems.push('the mirror file is missing')
    } else {
      const { entries: mirrorAll } = readLedger(mirror)
      const mirrorEntries = mirrorAll.filter((e) => e && e.caseId === caseId)
      const has = (list, seq, head) => list.some((e) => e.seq === seq && e.head === head)
      for (const entry of entries) {
        if (!has(mirrorEntries, entry.seq, entry.head)) {
          problems.push(`the mirror disagrees with the ledger for event ${entry.seq}`)
        }
      }
      for (const entry of mirrorEntries) {
        if (!has(entries, entry.seq, entry.head)) {
          problems.push(`the mirror disagrees with the ledger for event ${entry.seq}`)
        }
      }
    }
  }
  const since = total - anchored
  return { ok: problems.length === 0, anchored, total, since, entries, problems }
}

const fmt = (n) => Number(n).toLocaleString('en-US')

export function anchorText(report) {
  if (report.problems && report.problems.length) {
    return `Anchor check FAILED: ${report.problems.join('; ')}`
  }
  if (report.anchored === 0) {
    return 'Not anchored: the ledger outside the case holds no entry for it.'
  }
  if (report.since === 0) {
    return `Anchored: all ${fmt(report.total)} events are covered by the ledger outside the case.`
  }
  return `Anchored up to event ${fmt(report.anchored)} of ${fmt(report.total)}: the last ${fmt(report.since)} event(s) are not covered yet.`
}
