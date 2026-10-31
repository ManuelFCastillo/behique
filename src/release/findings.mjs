// Pure logic for turning changed facts into findings and judging them.
// Run offline: node --test src/release/findings.test.mjs
// A person wires this into confirm.mjs afterwards.
import { noticeOf, rankFindings } from './notice.mjs'

/**
 * A changed fact as a finding the exporter understands, or null if it cannot be turned into a test.
 * Markup facts are keyed by body/tag[n]/..., which is an XPath. A scroll fact becomes a RELATIVE test: how far the last
 * action moved the page, compared with how far it moved it on the old version (no absolute pixel positions).
 */
/**
 * The actions a test must replay to reach step i. The crawl joins its flows with a `goto /`, which starts the app over, so a test
 * for a step in the third flow replays that flow only, not the two before it (they would only add time and shared state).
 */
function historyFor(actions, i) {
  for (let g = i - 1; g >= 0; g--) if (actions[g]?.type === 'goto' && actions[g].path === '/') return actions.slice(g + 1, i)
  return actions.slice(0, i)
}

export function factToFinding(d, actions, start, baseline, id = 'R1') {
  if (d.key === 'step@error') return null // a step that could not be performed is reported, but there is no element to test
  if (d.key === 'window@scrollY') {
    const before = baseline.stable[`${d.i - 1}|${d.key}`]
    if (d.i < 1 || typeof before !== 'number' || typeof d.was !== 'number') return null
    const moved = d.was - before, a = actions[d.i - 1]
    return {
      id, start,
      title: `the page scrolls by ${moved} pixels after: ${a.type} ${a.selector ?? ''}`.slice(0, 140),
      expected: `the page scrolls by ${moved} pixels (the old version)`, actual: `the page ends ${Math.abs(d.now - d.was)} pixels ${d.now < d.was ? 'higher up' : 'lower down'} than the old version leaves it`,
      history: historyFor(actions, d.i), assert: { kind: 'scroll_delta', value: moved },
    }
  }
  const m = d.key.match(/^(.*?)(?:@([^/]+)|#text)$/)
  const selector = 'xpath=/html/' + m[1]
  const attr = m[2]
  const long = String(d.was).length >= 300 // facts cut values at 300 characters
  const assert = attr
    ? { kind: 'attr', selector, name: attr, op: long ? 'contains' : 'equals', value: d.was }
    : { kind: 'own_text', selector, op: long ? 'contains' : 'equals', value: d.was } // the fact is the element's own text, cut at 300 characters: compare it exactly, or a longer new text still contains the old one
  const what = attr ? `${attr} of ${m[1].split('/').slice(-2).join('/')}` : `text of ${m[1].split('/').slice(-2).join('/')}`
  return {
    id, start,
    title: `${what} after step ${d.i} keeps the previous release's value`,
    expected: JSON.stringify(d.was), actual: JSON.stringify(d.now),
    history: historyFor(actions, d.i), assert,
  }
}

/**
 * Turn the ranked changed facts into at most max findings, earliest step per key first.
 * Each finding carries `notice` ({ cls, why }: would a person notice it, see notice.mjs). Findings are ordered by that class,
 * visible before churn, so the cap keeps what a person would notice and R1 is the most noticeable; the given order holds inside a
 * class. Third-party content (an ad, a widget loaded from another host) never becomes a finding: it is skipped and listed as such.
 * `origin` is where the facts were recorded, so its host counts as the app's own.
 * Returns { findings, skipped } where skipped entries look like { key, i, why }.
 */
export function selectFindings(changed, actions, start, baseline, { max = 5, origin = null } = {}) {
  if (!Array.isArray(changed)) return { findings: [], skipped: [] }
  const list = changed.filter(d => d && d.kind === 'changed' && typeof d.key === 'string')
  if (list.length === 0) return { findings: [], skipped: [] }
  const limit = Number(max)
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 5
  // Keep only the earliest step (smallest i) for each key.
  const earliest = new Map()
  const skipped = []
  for (const d of list) {
    if (!earliest.has(d.key)) {
      earliest.set(d.key, d)
      continue
    }
    const first = earliest.get(d.key)
    if (d.i < first.i) {
      skipped.push({ key: d.key, i: first.i, why: `carried over from step ${d.i}` })
      earliest.set(d.key, d)
    } else {
      skipped.push({ key: d.key, i: d.i, why: `carried over from step ${first.i}` })
    }
  }
  // Kept facts stay in the given order.
  const kept = []
  for (const d of list) {
    if (earliest.get(d.key) === d && !kept.includes(d)) kept.push(d)
  }
  const testable = []
  for (const d of kept) {
    const notice = noticeOf(d, { origin })
    if (notice.cls === 'third_party') {
      skipped.push({ key: d.key, i: d.i, why: `third-party content (${notice.why})` })
      continue
    }
    let finding = null
    try {
      finding = factToFinding(d, actions, start, baseline, 'R0')
    } catch {
      finding = null
    }
    if (!finding) {
      skipped.push({ key: d.key, i: d.i, why: 'cannot be written as a test' })
      continue
    }
    testable.push({ ...finding, notice, fact: { key: d.key, i: d.i, was: d.was, now: d.now } })
  }
  const findings = []
  for (const f of rankFindings(testable)) {
    if (findings.length >= cap) {
      skipped.push({ key: f.fact.key, i: f.fact.i, why: `over the limit of ${cap} findings` })
      continue
    }
    findings.push({ ...f, id: `R${findings.length + 1}` })
  }
  return { findings, skipped }
}

/**
 * Judge each finding over the runs of each version.
 * Each run is what runExported returns: { results: { R1: true }, errors?, error? }.
 */
export function judgeFindings(findings, goodRuns, candRuns) {
  if (!Array.isArray(findings)) return []
  const good = Array.isArray(goodRuns) ? goodRuns : []
  const cand = Array.isArray(candRuns) ? candRuns : []
  return findings.map(f => {
    const id = f.id
    const goodBools = good.map(r => r?.results?.[id])
    const candBools = cand.map(r => r?.results?.[id])
    const hasError = [...good, ...cand].some(r => !r || r.error || typeof r?.results?.[id] !== 'boolean')
    const goodPassed = goodBools.filter(v => v === true).length
    const candFailed = candBools.filter(v => v === false).length
    const runs = cand.length
    if (hasError) return { id, verdict: 'error', goodPassed, candFailed, runs }
    const goodAllPass = good.length > 0 && goodBools.every(v => v === true)
    const goodAllFail = good.length > 0 && goodBools.every(v => v === false)
    const candAllPass = cand.length > 0 && candBools.every(v => v === true)
    const candAllFail = cand.length > 0 && candBools.every(v => v === false)
    if (goodAllPass && candAllFail) return { id, verdict: 'confirmed', goodPassed, candFailed, runs }
    if (goodAllFail) return { id, verdict: 'fails_both', goodPassed, candFailed, runs }
    if (goodAllPass && candAllPass) return { id, verdict: 'not_reproduced', goodPassed, candFailed, runs }
    return { id, verdict: 'unstable', goodPassed, candFailed, runs }
  })
}

/** The first entry with verdict confirmed, or null. */
export function firstConfirmed(judged) {
  if (!Array.isArray(judged)) return null
  return judged.find(j => j?.verdict === 'confirmed') ?? null
}

/** One plain sentence for a log line. Leaves out parts that are zero. */
export function summarize(judged, skipped) {
  const list = Array.isArray(judged) ? judged : []
  const skips = Array.isArray(skipped) ? skipped : []
  const n = list.length
  const by = verdict => list.filter(j => j?.verdict === verdict)
  const confirmed = by('confirmed')
  const parts = []
  if (n === 0) {
    parts.push('0 of 0 findings confirmed')
  } else {
    parts.push(`${confirmed.length} of ${n} findings confirmed${confirmed.length ? ` (${confirmed.map(j => j.id).join(', ')})` : ''}`)
  }
  for (const verdict of ['error', 'fails_both', 'not_reproduced', 'unstable']) {
    const group = by(verdict)
    if (group.length) parts.push(`${group.length} ${verdict} (${group.map(j => j.id).join(', ')})`)
  }
  const carried = skips.filter(s => typeof s?.why === 'string' && s.why.includes('carried over')).length
  if (carried) parts.push(`${carried} fact${carried === 1 ? '' : 's'} carried over from an earlier step`)
  return parts.join('; ')
}
