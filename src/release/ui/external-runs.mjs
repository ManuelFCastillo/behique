// External runs: turn evidence cases started outside the dashboard into run rows.
// Run with: node --test src/release/ui/external-runs.test.mjs
import { join } from 'node:path'

export const PHASES = {
  'case.opened': { phase: 'recording the good version', pct: 5 },
  'builds.compared': { phase: 'comparing the versions', pct: 35 },
  'masking.summary': { phase: 'comparing the versions', pct: 35 },
  'test.exported': { phase: 'writing tests', pct: 45 },
  'test.run': { phase: 'running tests', pct: 60 },
  'test.judged': { phase: 'running tests', pct: 65 },
  'shots.recorded': { phase: 'taking screenshots', pct: 80 },
  'shots.failed': { phase: 'taking screenshots', pct: 80 },
  'bisect.started': { phase: 'bisecting', pct: 85 },
  'bisect.step': { phase: 'bisecting', pct: 90 },
  'bisect.done': { phase: 'bisecting', pct: 95 },
  'case.closed': { phase: 'done', pct: 100 },
  decision: { phase: 'done', pct: 100 },
}

function asIso(ts) {
  if (!ts) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString()
}

/** Derive a phase and progress figure from events already written. */
export function phaseOf(events) {
  const list = Array.isArray(events) ? events : []
  if (!list.length) return { phase: 'starting', pct: 0, lastType: null, lastAt: null, done: false, text: 'starting' }
  let last = null
  for (const e of list) {
    if (e && PHASES[e.type]) last = e
  }
  const lastAt = list.at(-1)?.ts ? asIso(list.at(-1).ts) : null
  const done = list.some(e => e && e.type === 'case.closed')
  if (!last) return { phase: 'starting', pct: 0, lastType: null, lastAt, done, text: 'starting' }
  const { phase, pct } = PHASES[last.type]
  let text = phase
  if (last.type === 'test.exported') {
    const n = list.filter(e => e && e.type === 'test.exported').length
    text = `writing tests (${n} so far)`
  } else if (last.type === 'test.judged') {
    const n = list.filter(e => e && e.type === 'test.judged').length
    const m = list.filter(e => e && e.type === 'test.exported').length
    text = `running tests (${n} of ${m} judged)`
  } else if (last.type === 'bisect.step') {
    const n = list.filter(e => e && e.type === 'bisect.step').length
    text = `bisecting (step ${n})`
  } else if (last.type === 'case.closed') {
    text = `done: ${last.data?.outcome ?? ''}`.trimEnd()
    if (text === 'done:') text = 'done'
  }
  return { phase, pct, lastType: last.type, lastAt, done, text }
}

/** Turn open evidence cases into run rows, skipping runs the server started and closed cases. */
export function externalRuns({ cases, started = new Set(), now = Date.now(), staleMs = 30 * 60 * 1000 }) {
  const list = Array.isArray(cases) ? cases : []
  const rows = []
  for (const c of list) {
    if (!c || typeof c.id !== 'string') continue
    if (started instanceof Set ? started.has(c.id) : Array.isArray(started) ? started.includes(c.id) : false) continue
    const events = Array.isArray(c.events) ? c.events : []
    const opened = events.find(e => e && e.type === 'case.opened')
    if (!opened) continue
    const info = phaseOf(events)
    if (info.done) continue
    const data = opened.data ?? {}
    const app = data.app ?? data.adapter ?? 'unknown'
    const startedAt = asIso(opened.ts)
    const lastAt = info.lastAt
    let text = info.text
    let stale = false
    if (lastAt) {
      const ms = Number(now) - Date.parse(lastAt)
      if (ms > staleMs) {
        stale = true
        const m = Math.floor(ms / 60000)
        text = `${text}; no new events for ${m} minutes, it may have been stopped`
      }
    }
    rows.push({
      caseId: c.id,
      app,
      goodRef: data.goodRef ?? null,
      candRef: data.candRef ?? null,
      startedAt,
      lastAt,
      phase: info.phase,
      pct: info.pct,
      text,
      stale,
      external: true,
    })
  }
  rows.sort((a, b) => {
    if (a.startedAt < b.startedAt) return 1
    if (a.startedAt > b.startedAt) return -1
    return 0
  })
  return rows
}

/** Read the newest case folders through injected collaborators. The only function that touches the filesystem. */
export function recentCases({ root, listCases, openCase, limit = 25 }) {
  const ids = listCases(root)
  const newest = [...ids].sort().reverse().slice(0, limit)
  const out = []
  for (const id of newest) {
    try {
      const events = openCase(join(root, id)).read()
      out.push({ id, events })
    } catch {
      continue // an unreadable folder is skipped, never throws
    }
  }
  return out
}
