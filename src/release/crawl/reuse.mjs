// Crawl reuse: decide whether a saved crawl can stand in for a wanted crawl.
// Run tests with: node --test src/release/crawl/reuse.test.mjs
// Pure functions on plain data: no files, no processes, no network.

function asRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function asString(v) {
  return typeof v === 'string' ? v : null
}

function unionSortedKeys(a, b) {
  const set = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...set].sort()
}

/** True only when all hold: same app, same sha, same options, at least one step. */
export function crawlMatches(record, want) {
  try {
    const rec = asRecord(record)
    const w = asRecord(want)
    if (!rec || !w) return { ok: false, why: 'different app' }

    const recApp = asString(rec.app)
    const wantApp = asString(w.app)
    if (recApp === null || wantApp === null || recApp !== wantApp) {
      return { ok: false, why: 'different app' }
    }

    const recSha = asString(rec.sha)
    const wantSha = asString(w.sha)
    if (recSha === null || wantSha === null) {
      return { ok: false, why: 'different commit' }
    }
    if (recSha !== wantSha) {
      const short = wantSha.length === 12 && recSha.startsWith(wantSha)
      if (!short) return { ok: false, why: 'different commit' }
    }

    const recOpts = asRecord(rec.options)
    const wantOpts = asRecord(w.options)
    if (!recOpts || !wantOpts) {
      const keys = unionSortedKeys(recOpts ?? {}, wantOpts ?? {})
      const name = keys.length > 0 ? keys[0] : 'options'
      return { ok: false, why: `different crawl options (${name})` }
    }
    const keys = unionSortedKeys(wantOpts, recOpts)
    for (const key of keys) {
      const a = Object.prototype.hasOwnProperty.call(recOpts, key) ? recOpts[key] : undefined
      const b = Object.prototype.hasOwnProperty.call(wantOpts, key) ? wantOpts[key] : undefined
      if (a !== b) return { ok: false, why: `different crawl options (${key})` }
    }

    const steps = Array.isArray(rec.steps) ? rec.steps : null
    if (!steps || steps.length < 1) {
      return { ok: false, why: 'the saved crawl has no steps' }
    }

    return { ok: true }
  } catch {
    return { ok: false, why: 'the saved crawl has no steps' }
  }
}

/** Among the records that match, the one with the most steps; ties go to the later index. */
export function pickCrawl(records, want) {
  try {
    if (!Array.isArray(records)) return null
    let best = null
    let bestSteps = -1
    for (let i = 0; i < records.length; i++) {
      let m = null
      try {
        m = crawlMatches(records[i], want)
      } catch {
        m = null
      }
      if (!m || m.ok !== true) continue
      let n = 0
      try {
        const steps = asRecord(records[i])?.steps
        n = Array.isArray(steps) ? steps.length : 0
      } catch {
        n = 0
      }
      if (n > bestSteps || (n === bestSteps && best !== null)) {
        best = { record: records[i], index: i }
        bestSteps = n
      } else if (best === null) {
        best = { record: records[i], index: i }
        bestSteps = n
      }
    }
    return best
  } catch {
    return null
  }
}

function agoText(savedAt, now) {
  const s = asString(savedAt)
  if (s === null) return 'an earlier run'
  const t = Date.parse(s)
  if (!Number.isFinite(t) || !Number.isFinite(now)) return 'an earlier run'
  let diff = now - t
  if (!Number.isFinite(diff) || diff < 0) diff = 0
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(diff / 3600000)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(diff / 86400000)
  return `${days}d ago`
}

/** One line for the console describing the reused crawl. */
export function reuseNote(record, { now = Date.now() } = {}) {
  const rec = asRecord(record) ?? {}
  const app = asString(rec.app) ?? 'unknown'
  const shaRaw = asString(rec.sha) ?? 'unknown'
  const sha12 = shaRaw.slice(0, 12)
  const when = agoText(rec.savedAt, now)
  const steps = Array.isArray(rec.steps) ? rec.steps.length : 0
  const states = Array.isArray(rec.states) ? rec.states.length : 0
  return `reusing the crawl of ${app} ${sha12} from ${when} (${steps} steps, ${states} page states); pass --recrawl to crawl again`
}

/** The file stem crawl/cli.mjs uses, or null when the parts are not valid. */
export function crawlFileStem(app, sha) {
  if (typeof app !== 'string' || typeof sha !== 'string') return null
  if (!/^[a-z0-9-]{1,40}$/.test(app)) return null
  if (!/^[0-9a-f]{12,}$/.test(sha)) return null
  return `${app}-${sha.slice(0, 12)}`
}

function takeNumber(argv, flag) {
  const i = argv.indexOf(flag)
  if (i < 0) return null
  const raw = argv[i + 1]
  if (raw === undefined) return null
  const v = Number(raw)
  if (!Number.isFinite(v) || v <= 0) return null
  return v
}

/** Parse the crawl options the same way crawl/cli.mjs reads them. */
export function optionsFromArgs(argv) {
  const args = Array.isArray(argv) ? argv : []
  const out = {}
  const depth = takeNumber(args, '--max-depth')
  if (depth !== null) out.maxDepth = Math.trunc(depth)
  const paths = takeNumber(args, '--max-paths')
  if (paths !== null) out.maxPaths = Math.trunc(paths)
  const flows = takeNumber(args, '--max-flows')
  if (flows !== null) out.maxFlows = Math.trunc(flows)
  const budget = takeNumber(args, '--budget')
  if (budget !== null) out.budgetMs = Math.trunc(budget) * 1000
  return out
}

/** Where a crawl of this app starts: the profile's ready path when it has one (a docs site under /docs, a deck under /sub/), else the root. */
export function startPathOf(resolved) {
  const p = resolved?.adapter?.profile?.ready?.path
  return typeof p === 'string' && p.startsWith('/') && !/[\s?#]/.test(p) && p.length <= 200 ? p : '/'
}

/** The crawl options with the start written in, only when it is off the root: crawls saved before a start existed keep matching. */
export function withStart(options, startPath) {
  return startPath && startPath !== '/' ? { ...options, startPath } : { ...options }
}
