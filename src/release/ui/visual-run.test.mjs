// Tests for the dashboard visual-run helpers: validation, argv and progress. Offline only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { caseIdOf, validateVisualRun, visualArgv, visualProgress } from './visual-run.mjs'

function makeDeps({ profiles, ancestor = true } = {}) {
  const store = profiles ?? {
    music: {
      repo: '/repo/music',
      defaults: { good: 'v1', cand: 'v2' },
      regions: { toolbar: { x: 0, y: 0, w: 10, h: 10 } },
    },
  }
  const shas = { v1: 'aaa', v2: 'bbb', v3: 'ccc', same: 'zzz' }
  const git = repoPath => async args => {
    if (args[0] === 'rev-parse') {
      const ref = String(args[args.length - 1]).replace(/\^\{commit\}$/, '')
      if (shas[ref]) return { code: 0, out: shas[ref] }
      return { code: 1, out: '' }
    }
    if (args[0] === 'merge-base') {
      const [ , , good, cand] = args
      if (!ancestor) return { code: 1, out: '' }
      if (good === 'aaa' && cand === 'bbb') return { code: 0, out: '' }
      return { code: 1, out: '' }
    }
    return { code: 1, out: '' }
  }
  return {
    listProfiles: async () => Object.keys(store),
    loadProfile: async name => {
      if (!store[name]) throw new Error('missing')
      return store[name]
    },
    git,
  }
}

test('validateVisualRun success with explicit refs', async () => {
  const r = await validateVisualRun({ app: 'music', goodRef: 'v1', candRef: 'v2', bisect: true }, makeDeps())
  assert.equal(r.ok, true)
  assert.equal(r.params.app, 'music')
  assert.equal(r.params.goodSha, 'aaa')
  assert.equal(r.params.candSha, 'bbb')
  assert.equal(r.params.bisect, true)
  assert.equal(r.params.region, null)
})

test('validateVisualRun success using profile defaults and region', async () => {
  const r = await validateVisualRun({ app: 'music', region: 'toolbar' }, makeDeps())
  assert.equal(r.ok, true)
  assert.equal(r.params.goodRef, 'v1')
  assert.equal(r.params.candRef, 'v2')
  assert.equal(r.params.region, 'toolbar')
})

test('validateVisualRun unknown and missing app', async () => {
  const deps = makeDeps()
  const a = await validateVisualRun({ app: 'nope', goodRef: 'v1', candRef: 'v2' }, deps)
  assert.equal(a.ok, false)
  assert.equal(a.error, 'Choose one of the apps that has been set up.')
  const b = await validateVisualRun({ goodRef: 'v1', candRef: 'v2' }, deps)
  assert.equal(b.ok, false)
})

test('validateVisualRun invalid refs', async () => {
  const deps = makeDeps()
  const bad = await validateVisualRun({ app: 'music', goodRef: 'bad ref', candRef: 'v2' }, deps)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /old version/)
  const lock = await validateVisualRun({ app: 'music', goodRef: 'v1', candRef: 'x.lock' }, deps)
  assert.equal(lock.ok, false)
  assert.match(lock.error, /new version/)
  const dots = await validateVisualRun({ app: 'music', goodRef: 'a..b', candRef: 'v2' }, deps)
  assert.equal(dots.ok, false)
  const nores = await validateVisualRun({ app: 'music', goodRef: 'v1', candRef: 'ghost' }, deps)
  assert.equal(nores.ok, false)
  assert.match(nores.error, /There is no new version/)
})

test('validateVisualRun same sha gives bisect false and note', async () => {
  const deps = makeDeps()
  const r = await validateVisualRun({ app: 'music', goodRef: 'v1', candRef: 'v1' }, deps)
  assert.equal(r.ok, true)
  assert.equal(r.params.bisect, false)
  assert.ok(typeof r.note === 'string' && r.note.length > 0)
})

test('validateVisualRun ancestor rule', async () => {
  const r1 = await validateVisualRun({ app: 'music', goodRef: 'v2', candRef: 'v1' }, makeDeps({ ancestor: false }))
  assert.equal(r1.ok, false)
  assert.match(r1.error, /old version must come before/)
  const r2 = await validateVisualRun({ app: 'music', goodRef: 'v2', candRef: 'v1', bisect: false }, makeDeps({ ancestor: false }))
  assert.equal(r2.ok, true)
  assert.equal(r2.params.bisect, false)
})

test('validateVisualRun regions', async () => {
  const deps = makeDeps()
  const bad = await validateVisualRun({ app: 'music', goodRef: 'v1', candRef: 'v2', region: 'nope' }, deps)
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'That region is not in this app\'s profile.')
  const noRegions = makeDeps({ profiles: { plain: { repo: '/r', defaults: { good: 'v1', cand: 'v2' }, regions: {} } } })
  const c = await validateVisualRun({ app: 'plain', goodRef: 'v1', candRef: 'v2', region: 'toolbar' }, noRegions)
  assert.equal(c.ok, false)
  assert.equal(c.error, 'That region is not in this app\'s profile.')
})

test('validateVisualRun loadProfile throwing has no path', async () => {
  const deps = makeDeps()
  deps.loadProfile = async () => { throw new Error('profile "music" not found at /some/dir/music.json') }
  const r = await validateVisualRun({ app: 'music', goodRef: 'v1', candRef: 'v2' }, deps)
  assert.equal(r.ok, false)
  assert.ok(!r.error.includes('/some/dir'))
})

test('validateVisualRun non-object and wrong types never throw', async () => {
  const deps = makeDeps()
  for (const inp of [null, undefined, 42, 'x', [], { app: 7 }, { app: 'music', goodRef: 5, candRef: [] }]) {
    const r = await validateVisualRun(inp, deps)
    assert.equal(r.ok, false)
  }
})

test('visualArgv exact output for full request', () => {
  const out = visualArgv({ app: 'music', goodRef: 'v1', candRef: 'v2', bisect: true, region: 'toolbar' }, { ports: [8301, 8302] })
  assert.deepEqual(out, ['src/release/visual/check.mjs', 'music', 'v1', 'v2', '--bisect', '--region', 'toolbar', '--ports', '8301,8302'])
})

test('visualArgv flags only when set', () => {
  const out = visualArgv({ app: 'music', goodRef: 'v1', candRef: 'v2', bisect: false, region: null })
  assert.deepEqual(out, ['src/release/visual/check.mjs', 'music', 'v1', 'v2', '--ports', '8301,8302'])
})

test('visualArgv rejects unsafe elements', () => {
  assert.throws(() => visualArgv({ app: 'bad app', goodRef: 'v1', candRef: 'v2' }), Error)
  assert.throws(() => visualArgv({ app: 'a;b', goodRef: 'v1', candRef: 'v2' }), Error)
  assert.throws(() => visualArgv({ app: 'music', goodRef: '-v1', candRef: 'v2' }), Error)
  assert.throws(() => visualArgv({ app: 'music', goodRef: 'v1', candRef: 'v2', region: 'a b' }), Error)
  assert.throws(() => visualArgv({ app: 'music', goodRef: 'v1', candRef: 'v2', region: '--help' }), Error)
  assert.throws(() => visualArgv({ app: 'music', goodRef: 'v1', candRef: 'v2' }, { ports: [80, 8302] }), Error)
  assert.throws(() => visualArgv({ app: 'music', goodRef: 'v1', candRef: 'v2' }, { ports: [8301] }), Error)
})

test('visualProgress phases', () => {
  assert.deepEqual(visualProgress([]), { phase: 'starting', fraction: 0, text: 'Starting' })
  assert.deepEqual(visualProgress(['junk', 'hello']), { phase: 'starting', fraction: 0, text: 'Starting' })
  assert.equal(visualProgress(['progress: building both versions']).phase, 'building')
  assert.equal(visualProgress(['progress: building both versions', 'progress: taking pictures']).phase, 'pictures')
  assert.equal(visualProgress(['progress: measuring noise']).fraction, 0.35)
  assert.equal(visualProgress(['progress: comparing regions']).phase, 'comparing')
  assert.equal(visualProgress(['progress: recording']).fraction, 0.95)
})

test('visualProgress search fraction narrows', () => {
  const wide = visualProgress(['progress: searching', 'bisect range: good through #1, bad from #9, of 10'])
  const narrow = visualProgress(['progress: searching', 'bisect range: good through #1, bad from #9, of 10', 'bisect range: good through #4, bad from #6, of 10', 'bisect step a: x good | s'])
  assert.equal(wide.phase, 'searching')
  assert.ok(narrow.fraction > wide.fraction)
  assert.match(narrow.text, /Searching 10 code changes/)
  const none = visualProgress(['progress: searching'])
  assert.equal(none.text, 'Searching for the first change')
})

test('visualProgress case and failure overrides', () => {
  const done = visualProgress(['progress: building both versions', 'case abc123', 'outcome: ok'])
  assert.deepEqual(done, { phase: 'done', fraction: 1, text: 'Finished' })
  const failed = visualProgress(['progress: taking pictures', 'could not take settled pictures'])
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.fraction, 0.2)
  const usage = visualProgress(['usage: something went wrong'])
  assert.equal(usage.phase, 'failed')
  // case wins over an earlier failure
  const both = visualProgress(['bisect failed: bad', 'case xyz'])
  assert.equal(both.phase, 'done')
})

test('caseIdOf', () => {
  assert.equal(caseIdOf([]), null)
  assert.equal(caseIdOf(['hello']), null)
  assert.equal(caseIdOf(['case abc-1.2_x']), 'abc-1.2_x')
  assert.equal(caseIdOf(['case a/b']), null)
  assert.equal(caseIdOf(['case first', 'junk', 'case second']), 'second')
})
