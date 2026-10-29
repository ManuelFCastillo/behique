// node --test src/release/runparams.test.mjs   (offline: git is faked)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SCENARIOS } from './scenarios.mjs'
import { REF, validateRun } from './runparams.mjs'

// a pretend repository: tags a < b < c on one line, d on another branch
const SHAS = { a: 'a'.repeat(40), b: 'b'.repeat(40), c: 'c'.repeat(40), d: 'd'.repeat(40) }
const ANC = new Set(['a>b', 'a>c', 'b>c'])
const git = async args => {
  if (args[0] === 'rev-parse') { const t = args.at(-1).replace('^{commit}', ''); return SHAS[t] ? { code: 0, out: SHAS[t] } : { code: 1, out: '' } }
  if (args[0] === 'merge-base') { const k = Object.keys(SHAS).find(x => SHAS[x] === args[2]) + '>' + Object.keys(SHAS).find(x => SHAS[x] === args[3]); return { code: ANC.has(k) ? 0 : 1, out: '' } }
  return { code: 1, out: '' }
}
const v = input => validateRun({ scenario: 'share', ...input }, { scenarios: SCENARIOS, git })

test('a good request is accepted and carries the resolved commits', async () => {
  const r = await v({ goodRef: 'a', candRef: 'c', app: 'freshrss' })
  assert.equal(r.ok, true); assert.equal(r.params.bisect, true); assert.equal(r.params.goodSha, SHAS.a); assert.equal(r.params.candSha, SHAS.c); assert.equal(r.params.app, 'freshrss')
})

test('names that could act as options, paths or shell syntax are refused before git is asked', async () => {
  for (const bad of ['--output=/etc/x', '-x', '.hidden', 'a b', 'a;ls', '$(id)', 'a`id`', 'a..b', 'a/', 'x.lock', '', 'a'.repeat(61), '../x', 'a\nb']) {
    const r = await v({ goodRef: bad, candRef: 'c' })
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`); assert.match(r.error, /not a valid tag or branch name/)
  }
  assert.ok(REF.test('1.30.0') && REF.test('release/1.2') && REF.test('v2-rc.1'))
})

test('a version that does not exist is named in the error', async () => {
  const r = await v({ goodRef: 'a', candRef: 'nope' })
  assert.equal(r.ok, false); assert.match(r.error, /There is no new version "nope"/)
})

test('an unknown case, or a case from another app, is refused', async () => {
  assert.match((await validateRun({ scenario: 'x', goodRef: 'a', candRef: 'b' }, { scenarios: SCENARIOS, git })).error, /known cases/)
  assert.match((await v({ goodRef: 'a', candRef: 'b', app: 'other' })).error, /different app/)
})

test('the search needs the old version to come first, but a plain comparison does not', async () => {
  assert.match((await v({ goodRef: 'c', candRef: 'a' })).error, /old version must come before/)
  assert.match((await v({ goodRef: 'a', candRef: 'd' })).error, /old version must come before/)
  const r = await v({ goodRef: 'c', candRef: 'a', bisect: false })
  assert.equal(r.ok, true); assert.equal(r.params.bisect, false)
})

test('the same version twice is a clean run with the search switched off, and says so', async () => {
  const r = await v({ goodRef: 'b', candRef: 'b' })
  assert.equal(r.ok, true); assert.equal(r.params.bisect, false); assert.match(r.note, /nothing to search/)
})
