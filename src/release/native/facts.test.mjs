// node --test src/release/native/facts.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellAt, factsOf, gridDiff, normalizeName, noiseRules, parseAsciiGrid } from './facts.mjs'

const GRID = 'ncols 3\nnrows 2\nxllcorner 100\nyllcorner 200\ncellsize 10\nNODATA_value -9999\n1 2 3\n4 -9999 6\n'
const profile = { noise: { lines: ['CONNECT tunnel', 'seconds\\.$'], names: [['\\d{2}-\\d{2}-\\d{4}_\\d{4}', '<date>']] } }
const run = (over = {}) => ({ exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', outputs: {}, ...over })

test('an ASCII grid is parsed with row 0 at the top', () => {
  const g = parseAsciiGrid(GRID)
  assert.deepEqual([g.ncols, g.nrows, g.xll, g.yll, g.cellsize, g.nodata], [3, 2, 100, 200, 10, -9999])
  assert.deepEqual(g.values, [1, 2, 3, 4, -9999, 6])
  assert.equal(cellAt(g, 105, 215).value, 1) // top-left cell spans x 100-110, y 210-220
  assert.equal(cellAt(g, 125, 205).value, 6) // bottom-right
  assert.equal(cellAt(g, 99, 205), null)
  assert.equal(cellAt(g, 105, 221), null)
})

test('center-registered grids and bad grids', () => {
  const g = parseAsciiGrid('ncols 1\nnrows 1\nxllcenter 105\nyllcenter 205\ncellsize 10\n7\n')
  assert.deepEqual([g.xll, g.yll], [100, 200])
  assert.equal(parseAsciiGrid('hello world'), null)
  assert.equal(parseAsciiGrid('ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3\n'), null) // too few values
})

test('exit code, final line and messages, with noise lines dropped', () => {
  const { facts } = factsOf(run({
    exitCode: 255,
    stdout: 'Run 0: Reading elevation file...\nRun 0: ERROR: Exception caught: The grid does not contain any values.\nRun 0: Total simulation time was 0.42 seconds.\n',
    stderr: 'ERROR 1: CONNECT tunnel failed, response 403\nException caught: std::exception\n',
  }), {}, profile)
  assert.equal(facts.exit, '255')
  assert.equal(facts.final, 'Exception caught: std::exception')
  assert.equal(facts['message:Run 0: ERROR: Exception caught: The grid does not contain any values.'], '1')
  assert.equal(facts['message:Exception caught: std::exception'], '1')
  assert.ok(!Object.keys(facts).some(k => /CONNECT|seconds/.test(k)))
})

test('the final line comes from stdout when stderr has nothing meaningful', () => {
  const { facts } = factsOf(run({ stdout: 'a\nRun 0: Run number 0 done!\n', stderr: 'ERROR 1: CONNECT tunnel failed\n' }), {}, profile)
  assert.equal(facts.final, 'Run 0: Run number 0 done!')
  assert.equal(factsOf(run(), {}, profile).facts.final, '(nothing printed)')
  assert.equal(factsOf(run({ timedOut: true, exitCode: null }), {}, profile).facts.exit, 'timeout')
  assert.equal(factsOf(run({ spawnError: 'ENOENT', exitCode: null }), {}, profile).facts.exit, 'not started')
})

test('output files: names normalized, checksummed, grids summarized and probed', () => {
  const name = 'missoula_valley_point_11-06-2026_2358_413m_ang.asc'
  const { facts, grids } = factsOf(run({ outputs: { [name]: Buffer.from(GRID) } }),
    { probes: [{ name: 'station', file: '*_ang.asc', x: 125, y: 205 }, { name: 'far', file: '*_ang.asc', x: 0, y: 0 }, { name: 'none', file: '*_vel.asc', x: 1, y: 1 }] }, profile)
  const n = 'missoula_valley_point_<date>_413m_ang.asc'
  assert.equal(normalizeName(name, noiseRules(profile)), n)
  assert.match(facts[`file:${n}`], /^[0-9a-f]{64}$/)
  assert.equal(facts[`grid:${n}:shape`], '3 x 2 at 100, 200, cell 10')
  assert.equal(facts[`grid:${n}:stats`], 'nodata 1, min 1, max 6, mean 3.2')
  assert.equal(facts['probe:station'], '6')
  assert.equal(facts['probe:far'], 'outside the grid')
  assert.equal(facts['probe:none'], 'no matching grid')
  assert.ok(grids[n])
})

test('grids compared cell by cell, with a tolerance', () => {
  const a = parseAsciiGrid(GRID), b = parseAsciiGrid(GRID.replace('1 2 3', '1 2.0001 9'))
  assert.deepEqual(gridDiff(a, a), { comparable: true, cells: 6, changed: 0, maxAbs: 0, where: null })
  const d = gridDiff(a, b, 0.001)
  assert.equal(d.changed, 1)
  assert.equal(d.maxAbs, 6)
  assert.deepEqual(d.where, { row: 0, col: 2, good: 3, cand: 9 })
  assert.equal(gridDiff(a, parseAsciiGrid('ncols 1\nnrows 1\nxllcorner 0\nyllcorner 0\ncellsize 1\n1\n')).comparable, false)
})
