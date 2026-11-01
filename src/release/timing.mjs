// Where a check's time goes: every build is noted with its phase (compare, tests, shots, bisect), how long it took and whether it
// came from a cache. The summary is written to the evidence record (`check.timing`) and printed as one line the bench can read.
// Pure data; no clocks of its own. Tests: node --test src/release/timing.test.mjs
export const PHASES = ['compare', 'canvas', 'tests', 'shots', 'bisect']

/** A fresh collector. `now` is injected for tests. */
export function createTiming({ now = Date.now } = {}) {
  const t0 = now()
  const builds = [] // { phase, ref, sha, ms, cached }
  const marks = [] // { phase, at }
  let phase = 'compare'
  marks.push({ phase, at: t0 })
  return {
    get phase() { return phase },
    setPhase(p) { if (!PHASES.includes(p) || p === phase) return; phase = p; marks.push({ phase, at: now() }) },
    note(b) { builds.push({ phase, ref: String(b?.ref ?? ''), sha: String(b?.sha ?? '').slice(0, 12), ms: Number.isFinite(b?.buildMs) ? Math.round(b.buildMs) : 0, cached: b?.cached === true }) },
    summary() { return summarize({ builds, marks, startedAt: t0, now: now() }) },
    builds,
  }
}

/** Per phase: wall seconds (from the marks), builds, cached builds, seconds spent inside builds. Never throws. */
export function summarize({ builds = [], marks = [], startedAt = 0, now = 0 } = {}) {
  const phases = Object.fromEntries(PHASES.map(p => [p, { seconds: 0, builds: 0, cached: 0, buildSeconds: 0 }]))
  const list = Array.isArray(marks) ? marks.filter(m => m && PHASES.includes(m.phase) && Number.isFinite(m.at)) : []
  for (let i = 0; i < list.length; i++) {
    const end = i + 1 < list.length ? list[i + 1].at : now
    phases[list[i].phase].seconds += Math.max(0, (end - list[i].at) / 1000)
  }
  for (const b of Array.isArray(builds) ? builds : []) {
    const p = phases[b?.phase]
    if (!p) continue
    p.builds += 1
    if (b.cached) p.cached += 1
    p.buildSeconds += Math.max(0, (Number(b.ms) || 0) / 1000)
  }
  for (const p of Object.values(phases)) { p.seconds = round1(p.seconds); p.buildSeconds = round1(p.buildSeconds) }
  const total = { seconds: round1(Math.max(0, (now - startedAt) / 1000)), builds: Object.values(phases).reduce((n, p) => n + p.builds, 0), cached: Object.values(phases).reduce((n, p) => n + p.cached, 0) }
  return { total, phases }
}

/** One line for the console and the bench: `timing: total 2160 s | compare 464 s (4 builds, 0 cached) | tests ... | shots ... | bisect ...` */
export function timingLine(s) {
  const p = s?.phases ?? {}
  const part = name => { const x = p[name] ?? { seconds: 0, builds: 0, cached: 0 }; return `${name} ${x.seconds} s (${x.builds} builds, ${x.cached} cached)` }
  return `timing: total ${s?.total?.seconds ?? 0} s | ${PHASES.map(part).join(' | ')}`
}

/** Read the line back into `{ total: { seconds }, phases: { compare: { seconds, builds, cached }, ... } }`, or null if it is not a timing line. */
export function parseTimingLine(line) {
  const m = String(line ?? '').trim().match(/^timing: total ([\d.]+) s \| (.*)$/)
  if (!m) return null
  const out = { total: { seconds: Number(m[1]) }, phases: {} }
  for (const part of m[2].split(' | ')) {
    const pm = part.match(/^(\w+) ([\d.]+) s \((\d+) builds, (\d+) cached\)$/)
    if (pm && PHASES.includes(pm[1])) out.phases[pm[1]] = { seconds: Number(pm[2]), builds: Number(pm[3]), cached: Number(pm[4]) }
  }
  return out
}

function round1(n) { return Math.round(n * 10) / 10 }
