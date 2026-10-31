// Crawl summary: coverage numbers and a plain verdict from a saved crawl.
// Run tests with: node --test src/release/crawl/summary.test.mjs
// Pure functions on plain data: no files, no processes, no network.

const QUALITY_RANK = { good: 3, thin: 2, degenerate: 1, failed: 0 }

function asArray(v) {
  return Array.isArray(v) ? v : []
}

function asRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function asString(v, fallback = '') {
  return typeof v === 'string' ? v : fallback
}

function asCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function roundTo(n, places) {
  const k = 10 ** places
  return Math.round(n * k) / k
}

// Keep path and query, drop the origin. Unparseable values stay as text.
function stripOrigin(u) {
  try {
    const parsed = new URL(u)
    return parsed.pathname + parsed.search
  } catch {
    return String(u)
  }
}

function allZeroSummary() {
  return {
    app: '',
    ref: '',
    states: 0,
    distinctUrls: 0,
    distinctTitles: 0,
    distinctStates: 0,
    maxDepth: 0,
    meanDepth: 0,
    flows: 0,
    steps: 0,
    clicks: 0,
    tried: 0,
    failed: 0,
    failedRatio: 0,
    seenAgain: 0,
    stoppedBy: 'unknown',
    seconds: 0,
    quality: 'failed',
    reasons: ['No crawl data.']
  }
}

export function summarizeCrawl(crawl) {
  const rec = asRecord(crawl)
  if (!rec) return allZeroSummary()

  const app = asString(rec.app)
  const ref = asString(rec.ref)
  const stateList = asArray(rec.states)
  const flowList = asArray(rec.flows)
  const stepList = asArray(rec.steps)
  const stats = asRecord(rec.stats) ?? {}

  const states = stateList.length
  const flows = flowList.length
  const steps = stepList.length
  const clicks = stepList.filter(s => asRecord(s)?.type === 'click' || (s !== null && typeof s === 'object' && !Array.isArray(s) && s.type === 'click')).length

  // Distinct addresses ignore the origin so reruns on another port still match.
  const urlSet = new Set()
  const titleSet = new Set()
  const stateSet = new Set()
  const depths = []
  for (const s of stateList) {
    const r = asRecord(s) ?? {}
    const rawUrl = typeof r.url === 'string' ? r.url : ''
    const rawTitle = typeof r.title === 'string' ? r.title : ''
    const title = rawTitle.trim()
    if (rawUrl !== '') urlSet.add(stripOrigin(rawUrl))
    if (title !== '') titleSet.add(title)
    stateSet.add(rawUrl + '|' + rawTitle)
    const path = Array.isArray(r.path) ? r.path : []
    depths.push(path.length)
  }
  // An empty crawl found no pairs at all.
  const distinctUrls = urlSet.size
  const distinctTitles = titleSet.size
  const distinctStates = states === 0 ? 0 : stateSet.size

  const maxDepth = depths.length === 0 ? 0 : Math.max(...depths)
  const meanDepth = depths.length === 0 ? 0 : roundTo(depths.reduce((a, b) => a + b, 0) / depths.length, 1)

  const tried = asCount(stats.tried)
  const failed = asCount(stats.failed)
  const seenAgain = asCount(stats.seenAgain)
  const failedRatio = tried === 0 ? 0 : roundTo(failed / tried, 2)

  const rawStopped = typeof rec.stoppedBy === 'string' && rec.stoppedBy !== '' ? rec.stoppedBy : 'unknown'
  const stoppedBy = rawStopped
  const ms = typeof rec.ms === 'number' && Number.isFinite(rec.ms) && rec.ms >= 0 ? rec.ms : 0
  const seconds = roundTo(ms / 1000, 1)

  const reasons = []
  const fired = [false, false, false, false, false]

  if (steps === 0) {
    fired[0] = true
    reasons.push('The crawl produced no steps.')
  }
  if (states <= 1) {
    fired[1] = true
    reasons.push('Only the landing page was found.')
  }
  if (failedRatio > 0.3) {
    fired[2] = true
    reasons.push('More than 30 percent of the tries failed.')
  }
  const titleShare = states === 0 ? 1 : distinctTitles / states
  if (states > 5 && titleShare < 0.2 && distinctUrls < 3) {
    fired[3] = true
    reasons.push('Most pages look the same (few titles and few addresses).')
  }
  if (flows <= 1) {
    fired[4] = true
    reasons.push('Only one click path was found.')
  }

  let quality = 'good'
  if (fired[0]) quality = 'failed'
  else if (fired[1]) quality = 'degenerate'
  else if (fired[2] || fired[3] || fired[4]) quality = 'thin'

  if (stoppedBy === 'paths') reasons.push('Stopped at the path limit; more pages may exist.')
  if (stoppedBy === 'budget') reasons.push('Stopped at the time budget; more pages may exist.')

  return {
    app,
    ref,
    states,
    distinctUrls,
    distinctTitles,
    distinctStates,
    maxDepth,
    meanDepth,
    flows,
    steps,
    clicks,
    tried,
    failed,
    failedRatio,
    seenAgain,
    stoppedBy,
    seconds,
    quality,
    reasons
  }
}

export function renderSummary(summary) {
  const s = asRecord(summary) ?? {}
  const pick = (key, fallback) => (s[key] === undefined ? fallback : s[key])
  const app = asString(s.app)
  const ref = asString(s.ref)
  const quality = asString(s.quality, 'failed')
  const stoppedBy = asString(s.stoppedBy, 'unknown')
  const reasons = asArray(s.reasons).filter(r => typeof r === 'string')
  const lines = [
    `${app} ${ref}: ${quality}`,
    `pages: ${pick('states', 0)} (${pick('distinctStates', 0)} distinct, ${pick('distinctTitles', 0)} titles), depth max ${pick('maxDepth', 0)} mean ${pick('meanDepth', 0)}`,
    `click paths: ${pick('flows', 0)}, steps: ${pick('steps', 0)} (${pick('clicks', 0)} clicks)`,
    `tries: ${pick('tried', 0)}, failed ${pick('failed', 0)} (${pick('failedRatio', 0)}), already seen ${pick('seenAgain', 0)}`,
    `stopped by: ${stoppedBy} after ${pick('seconds', 0)} s`
  ]
  for (const r of reasons) lines.push(`note: ${r}`)
  return lines
}

function rankOf(summary) {
  const q = asRecord(summary)?.quality
  return QUALITY_RANK[q] ?? 0
}

function numOf(summary, key) {
  const v = asRecord(summary)?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function compareSummaries(a, b) {
  const notes = []
  const ra = rankOf(a)
  const rb = rankOf(b)
  const da = numOf(a, 'distinctStates')
  const db = numOf(b, 'distinctStates')
  const fa = numOf(a, 'flows')
  const fb = numOf(b, 'flows')

  if (ra !== rb) notes.push(`quality differs (a: ${asString(asRecord(a)?.quality, 'failed')}, b: ${asString(asRecord(b)?.quality, 'failed')}).`)
  if (da !== db) notes.push(`distinctStates differs (a: ${da}, b: ${db}).`)
  if (fa !== fb) notes.push(`flows differs (a: ${fa}, b: ${fb}).`)

  const same = ra === rb && da === db && fa === fb
  let better = null
  if (!same) {
    if (ra !== rb) better = ra > rb ? 'a' : 'b'
    else if (da !== db) better = da > db ? 'a' : 'b'
    else better = fa > fb ? 'a' : 'b'
  }
  return { better, same, notes }
}
