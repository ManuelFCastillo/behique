// Record every case of a command profile on one version (each case run twice, to learn what changes on its own), then
// compare two recordings. The web pipeline's run-twice masking, for programs instead of pages.
//   node --test src/release/native/compare.test.mjs
//
// A fact is "stable" for a case when every run of that version gave it the same value. Anything else is masked as noise:
// a value that changed between identical runs, or a fact that appeared in some runs only. A masked fact is never compared,
// and the report counts what was masked, so nobody mistakes "not compared" for "unchanged".
import { join } from 'node:path'
import { factsOf, gridDiff } from './facts.mjs'
import { runCase } from './run.mjs'

/** Which facts are stable across runs, and which are masked. Pure: takes the facts of each run. */
export function stableFacts(runsFacts) {
  const keys = new Set(runsFacts.flatMap(f => Object.keys(f)))
  const stable = {}, masked = []
  for (const k of [...keys].sort()) {
    const vals = runsFacts.map(f => f[k])
    if (vals.every(v => v !== undefined && v === vals[0])) stable[k] = vals[0]
    else masked.push(k)
  }
  return { stable, masked }
}

/** Run every case `runs` times on one built version. Returns { cases: {id: {stable, masked, grids, runs: [...]}} }. */
export async function recordVersion(profile, { src, build, workDir, runs = 2, only, onRun = () => {} }) {
  const cases = {}
  for (const kase of profile.cases) {
    if (only && !only.includes(kase.id)) continue
    const runFacts = [], runInfo = []
    let grids = {}
    for (let i = 0; i < runs; i++) {
      const r = await runCase(profile, kase, { src, build, runDir: join(workDir, kase.id, `run${i + 1}`) })
      const f = factsOf(r, kase, profile)
      if (i === 0) grids = f.grids
      runFacts.push(f.facts)
      runInfo.push({ exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms, stdout: r.stdout, stderr: r.stderr, outputs: Object.keys(r.outputs) })
      onRun({ case: kase.id, run: i + 1, ms: r.ms, exit: f.facts.exit })
    }
    cases[kase.id] = { ...stableFacts(runFacts), grids, runs: runInfo }
  }
  return { cases }
}

/** How noticeable a changed fact is. Lower ranks first. */
export function rankOf(key) {
  if (key === 'exit') return { rank: 0, cls: 'notice', what: 'exit code' }
  if (key === 'final') return { rank: 1, cls: 'notice', what: 'final message' }
  if (key.startsWith('message:')) return { rank: 2, cls: 'notice', what: 'printed message' }
  if (key.startsWith('probe:')) return { rank: 3, cls: 'notice', what: 'value at a named point' }
  if (/^grid:.*:shape$/.test(key)) return { rank: 4, cls: 'notice', what: 'grid shape' }
  if (/^grid:.*:stats$/.test(key)) return { rank: 5, cls: 'notice', what: 'grid values' }
  if (key.startsWith('file:')) return { rank: 6, cls: 'output', what: 'output file' }
  return { rank: 7, cls: 'output', what: 'other' }
}

/**
 * Compare two recordings case by case. Returns { cases: {id: {diffs, masked}}, diffs } where each diff is
 * { case, key, kind: changed|added|removed, good, cand, rank, cls, what, grid? }, ranked most noticeable first.
 * A file whose bytes changed but whose grid is cell-for-cell equal within `tol` is classed as churn, not a change.
 */
export function compareRecordings(good, cand, { tol = 0 } = {}) {
  const out = { cases: {}, diffs: [] }
  for (const id of Object.keys(good.cases)) {
    const g = good.cases[id], c = cand.cases[id]
    if (!c) continue
    const masked = [...new Set([...g.masked, ...c.masked])].sort()
    const skip = new Set(masked)
    const diffs = []
    // Steady on one version, varying on the other: that is a difference in itself (a version that is sometimes wrong), not
    // noise. It cannot be proven pass-every-time / fail-every-time, so it is reported for a person to review.
    for (const key of masked) {
      const side = !g.masked.includes(key) && key in g.stable ? 'cand' : !c.masked.includes(key) && key in c.stable ? 'good' : null
      if (!side) continue
      diffs.push({ case: id, key, kind: 'unsteady', side, good: g.stable[key] ?? null, cand: c.stable[key] ?? null, ...rankOf(key), cls: 'unsteady', what: `${rankOf(key).what}, varies between runs of the ${side === 'cand' ? 'candidate' : 'good version'}` })
    }
    for (const key of [...new Set([...Object.keys(g.stable), ...Object.keys(c.stable)])].sort()) {
      if (skip.has(key)) continue
      const a = g.stable[key], b = c.stable[key]
      if (a === b) continue
      const kind = a === undefined ? 'added' : b === undefined ? 'removed' : 'changed'
      const d = { case: id, key, kind, good: a ?? null, cand: b ?? null, ...rankOf(key) }
      const name = key.startsWith('file:') ? key.slice(5) : null
      if (name && g.grids[name] && c.grids[name]) {
        d.grid = gridDiff(g.grids[name], c.grids[name], tol)
        if (d.grid.comparable && d.grid.changed === 0) { d.cls = 'churn'; d.what = 'output file bytes only (values equal)'; d.rank = 8 }
      }
      diffs.push(d)
    }
    out.cases[id] = { diffs, masked }
    out.diffs.push(...diffs)
  }
  out.diffs.sort((x, y) => x.rank - y.rank || x.case.localeCompare(y.case) || x.key.localeCompare(y.key))
  return out
}
