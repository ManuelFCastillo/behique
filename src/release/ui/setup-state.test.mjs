// Offline tests for the set-up state the dashboard shows.
//   node --test src/release/ui/setup-state.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSetupState, setupSummary, repoOfProposal } from './setup-state.mjs'

function fakeDisk(initial = null) {
  const files = {}
  if (initial !== null) files['out/onboard/state.json'] = initial
  return {
    files,
    readFile: async (p) => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p] },
    writeFile: async (p, text) => { files[p] = text },
  }
}

test('a step in progress is visible, and its result becomes the repo\'s last result', async () => {
  const disk = fakeDisk()
  let t = 1000
  const s = createSetupState({ ...disk, now: () => t })
  assert.deepEqual(await s.view(), { running: null, last: {} })
  assert.equal((await s.begin({ repo: 'skymap', name: 'skymap', step: 'verify', good: 'd88b984', cand: 'main' })).ok, true)
  let v = await s.view()
  assert.equal(v.running.step, 'verify')
  assert.equal(v.running.repo, 'skymap')
  assert.equal(setupSummary(v, 'skymap').state, 'running')
  assert.match(setupSummary(v, 'skymap').text, /verifying d88b984 against main/)
  assert.equal(setupSummary(v, 'other'), null)
  const second = await s.begin({ repo: 'other', name: 'other', step: 'propose' })
  assert.equal(second.ok, false)
  t = 5000
  const checks = [{ name: 'builds the good version', ok: true, detail: 'x' }, { name: 'pictures settle', ok: false, detail: 'timeout\nCall log:\n\u001b[2m  - taking page screenshot\u001b[22m\n', logs: 'LONG LOGS' }]
  const r = await s.end({ ok: false, saved: false, checks })
  assert.equal(r.ok, true)
  v = await s.view()
  assert.equal(v.running, null)
  const l = v.last.skymap
  assert.equal(l.ok, false)
  assert.equal(l.finishedAt, 5000)
  assert.equal(l.checks.length, 2)
  assert.equal('logs' in l.checks[1], false)
  assert.equal(l.checks[1].detail, 'timeout . Call log: . - taking page screenshot') // one plain line, no colour codes
  const sum = setupSummary(v, 'skymap')
  assert.equal(sum.state, 'failed')
  assert.match(sum.text, /1 of 2 checks passed, nothing saved/)
  // persisted without the step in progress
  const saved = JSON.parse(disk.files['out/onboard/state.json'])
  assert.equal(saved.last.skymap.name, 'skymap')
  assert.equal('running' in saved, false)
})

test('the last result survives a restart; a bad file is ignored', async () => {
  const disk = fakeDisk(JSON.stringify({ last: { alpha: { repo: 'alpha', name: 'alpha', step: 'verify', ok: true, saved: true, checks: [{ name: 'a', ok: true, detail: '' }] }, '../bad': { ok: true } } }))
  const s = createSetupState(disk)
  const v = await s.view()
  assert.equal(setupSummary(v, 'alpha').state, 'saved')
  assert.equal('../bad' in v.last, false)
  const broken = createSetupState(fakeDisk('{not json'))
  assert.deepEqual(await broken.view(), { running: null, last: {} })
})

test('a proposal step summarises as proposed or failed', async () => {
  const s = createSetupState(fakeDisk())
  await s.begin({ repo: 'beta', name: 'beta', step: 'propose' })
  await s.end({ ok: true, usd: 0.0062 })
  let v = await s.view()
  assert.equal(setupSummary(v, 'beta').state, 'proposed')
  assert.equal(v.last.beta.usd, 0.0062)
  await s.begin({ repo: 'beta', name: 'beta', step: 'propose' })
  await s.end({ ok: false, error: 'the model answered with prose' })
  v = await s.view()
  assert.match(setupSummary(v, 'beta').text, /proposal failed: the model answered with prose/)
})

test('begin refuses an unknown step or a bad name; end without a step is refused', async () => {
  const s = createSetupState(fakeDisk())
  assert.equal((await s.begin({ repo: 'a', name: 'a', step: 'run' })).ok, false)
  assert.equal((await s.begin({ repo: 'a', name: 'Bad Name', step: 'verify' })).ok, false)
  assert.equal((await s.end({ ok: true })).ok, false)
  // a step whose repo is unknown still runs, but leaves no last result
  assert.equal((await s.begin({ repo: null, name: 'a', step: 'verify' })).ok, true)
  await s.end({ ok: true, saved: true })
  assert.deepEqual((await s.view()).last, {})
})

test('repoOfProposal takes the folder from the proposal\'s repo path', () => {
  assert.equal(repoOfProposal({ repo: '/Users/x/dev/behique-apps/skymap' }), 'skymap')
  assert.equal(repoOfProposal({ repo: '/Users/x/dev/behique-apps/skymap/' }), 'skymap')
  assert.equal(repoOfProposal({ repo: '/x/.hidden' }), null)
  assert.equal(repoOfProposal({}), null)
  assert.equal(repoOfProposal(null), null)
})
