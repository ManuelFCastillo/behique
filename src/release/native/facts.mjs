// Facts about one run of a native case: what a person would see or rely on, as named values that can be compared
// between versions. The web pipeline records what a page shows; this records what a program says and writes.
//   node --test src/release/native/facts.test.mjs
//
//   exit                    the exit code ("0", "255"), or "timeout" / "not started"
//   final                   the last meaningful line the program printed (stderr if it printed anything there)
//   message:<text>          how many times an error, exception or warning line was printed
//   file:<name>             sha256 of an output file (names normalized with the profile's noise.names rules)
//   grid:<name>:shape       columns x rows, corner and cell size of an ASCII grid
//   grid:<name>:stats       count of no-data cells, min, max and mean of the rest
//   probe:<name>            the grid value at one map point the profile names (x, y in the grid's own coordinates)
// Lines matching the profile's noise.lines patterns are dropped before anything is read from the output streams.
import { createHash } from 'node:crypto'
import { globToRegex } from './run.mjs'

const sha256 = b => createHash('sha256').update(b).digest('hex')
const MESSAGE_RE = /\b(error|exception|warning|failed|failure)\b/i
const fmt = v => (Number.isFinite(v) ? Number(v.toPrecision(7)).toString() : String(v))

export function noiseRules(profile) {
  const n = profile?.noise ?? {}
  return {
    lines: (n.lines ?? []).map(r => new RegExp(r)),
    names: (n.names ?? []).map(([re, to]) => [new RegExp(re, 'g'), to]),
  }
}

export const normalizeName = (name, rules) => rules.names.reduce((s, [re, to]) => s.replace(re, to), name)

function meaningfulLines(text, rules) {
  return String(text ?? '').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim() && !rules.lines.some(re => re.test(l)))
}

/** Parse an ESRI ASCII grid. Returns null when the text is not one. Row 0 is the top (north) row, as in the file. */
export function parseAsciiGrid(text) {
  const tokens = String(text).split(/\s+/).filter(Boolean)
  const head = {}
  let i = 0
  while (i + 1 < tokens.length && /^[a-z_]+$/i.test(tokens[i])) { head[tokens[i].toLowerCase()] = Number(tokens[i + 1]); i += 2 }
  const ncols = head.ncols, nrows = head.nrows, cellsize = head.cellsize
  if (!Number.isInteger(ncols) || !Number.isInteger(nrows) || !(cellsize > 0)) return null
  const center = head.xllcenter !== undefined
  const xll = center ? head.xllcenter - cellsize / 2 : head.xllcorner
  const yll = center ? head.yllcenter - cellsize / 2 : head.yllcorner
  if (!Number.isFinite(xll) || !Number.isFinite(yll)) return null
  const values = tokens.slice(i, i + ncols * nrows).map(Number)
  if (values.length !== ncols * nrows || values.some(v => Number.isNaN(v))) return null
  return { ncols, nrows, xll, yll, cellsize, nodata: head.nodata_value, values }
}

/** The value of the cell containing map point (x, y), or null outside the grid. */
export function cellAt(grid, x, y) {
  const col = Math.floor((x - grid.xll) / grid.cellsize)
  const rowFromBottom = Math.floor((y - grid.yll) / grid.cellsize)
  if (col < 0 || col >= grid.ncols || rowFromBottom < 0 || rowFromBottom >= grid.nrows) return null
  const row = grid.nrows - 1 - rowFromBottom
  return { row, col, value: grid.values[row * grid.ncols + col] }
}

function gridStats(g) {
  let n = 0, nodata = 0, min = Infinity, max = -Infinity, sum = 0
  for (const v of g.values) {
    if (g.nodata !== undefined && v === g.nodata) { nodata++; continue }
    n++; sum += v; if (v < min) min = v; if (v > max) max = v
  }
  return n ? `nodata ${nodata}, min ${fmt(min)}, max ${fmt(max)}, mean ${fmt(sum / n)}` : `nodata ${nodata}, no values`
}

/**
 * Facts for one run. Returns { facts: {key: string}, grids: {name: grid} } where grids keeps the parsed output grids
 * (by normalized name) for a cell-by-cell comparison later.
 */
export function factsOf(run, kase, profile) {
  const rules = noiseRules(profile)
  const facts = {}, grids = {}
  facts.exit = run.spawnError ? 'not started' : run.timedOut ? 'timeout' : String(run.exitCode)
  const errLines = meaningfulLines(run.stderr, rules), outLines = meaningfulLines(run.stdout, rules)
  const last = (errLines.length ? errLines : outLines).at(-1)
  facts.final = last === undefined ? '(nothing printed)' : last.trim()
  for (const l of [...outLines, ...errLines]) {
    if (!MESSAGE_RE.test(l)) continue
    const k = `message:${l.trim()}`
    facts[k] = String(Number(facts[k] ?? 0) + 1)
  }
  for (const [rel, buf] of Object.entries(run.outputs ?? {})) {
    const name = normalizeName(rel, rules)
    facts[`file:${name}`] = sha256(buf)
    if (!/\.asc$/i.test(rel)) continue
    const g = parseAsciiGrid(buf.toString('utf8'))
    if (!g) { facts[`grid:${name}:shape`] = 'not a readable grid'; continue }
    grids[name] = g
    facts[`grid:${name}:shape`] = `${g.ncols} x ${g.nrows} at ${fmt(g.xll)}, ${fmt(g.yll)}, cell ${fmt(g.cellsize)}`
    facts[`grid:${name}:stats`] = gridStats(g)
  }
  for (const pr of kase.probes ?? []) {
    const re = globToRegex(pr.file)
    const name = Object.keys(grids).find(n => re.test(n))
    if (!name) { facts[`probe:${pr.name}`] = 'no matching grid'; continue }
    const c = cellAt(grids[name], pr.x, pr.y)
    facts[`probe:${pr.name}`] = c ? fmt(c.value) : 'outside the grid'
  }
  return { facts, grids }
}

/** Cell-by-cell difference of two grids of the same shape: how many cells differ by more than `tol`, and the largest. */
export function gridDiff(a, b, tol = 0) {
  if (a.ncols !== b.ncols || a.nrows !== b.nrows) return { comparable: false }
  let changed = 0, maxAbs = 0, where = null
  for (let i = 0; i < a.values.length; i++) {
    const d = Math.abs(a.values[i] - b.values[i])
    if (d > tol) {
      changed++
      if (d > maxAbs) { maxAbs = d; where = { row: Math.floor(i / a.ncols), col: i % a.ncols, good: a.values[i], cand: b.values[i] } }
    }
  }
  return { comparable: true, cells: a.values.length, changed, maxAbs, where }
}
