// Tests for the dashboard onboard flow: a model proposes, code verifies, a person approves.
//   node --test src/release/ui/onboard-flow.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { listCandidates, resolveRepo, onboardPreview, onboardPropose, onboardVerify, listRefs, suggestPair } from './onboard-flow.mjs'

const APPS = '/apps'

function previewDeps(over = {}) {
  return {
    appsRoot: APPS,
    isGitRepo: async (p) => p.endsWith('/alpha'),
    listProfiles: async () => [],
    inspectRepo: async (path) => ({ path, isGit: true, tags: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'], hasIndexHtml: true, packageJson: { scripts: { dev: 'x', build: 'y' } } }),
    skillText: 'SKILL',
    buildMessages: (facts, skill, { good, cand }) => [{ role: 'system', content: skill }, { role: 'user', content: `${good}:${cand}:${facts.path}` }],
    projectCost: () => 0.01,
    provider: 'meta',
    keyPresent: true,
    ...over,
  }
}

const goodInput = { repo: 'alpha', name: 'myapp', good: 'v1', cand: 'v2' }

test('listCandidates filters and sorts', async () => {
  const entries = ['beta', 'alpha', '.hidden', 'w-tree', 'work', 'bad name!', 'a/b', 'gamma']
  const calls = []
  const res = await listCandidates({
    appsRoot: APPS,
    readdir: async () => entries,
    isGitRepo: async (p) => { calls.push(p); return p.endsWith('/alpha') || p.endsWith('/beta') },
    listProfiles: async () => ['beta'],
  })
  assert.deepEqual(res, [
    { name: 'alpha', path: join(APPS, 'alpha'), hasProfile: false },
    { name: 'beta', path: join(APPS, 'beta'), hasProfile: true },
  ])
})

test('resolveRepo accepts plain and rejects bad', async () => {
  const isGitRepo = async () => true
  assert.equal(await resolveRepo(APPS, 'alpha', { isGitRepo }), join(APPS, 'alpha'))
  for (const bad of ['..', 'a/b', '/abs', 'has space', 'nul\x00x', '', 42, null, '-lead', '.hidden']) {
    await assert.rejects(() => resolveRepo(APPS, bad, { isGitRepo }), Error)
  }
  await assert.rejects(() => resolveRepo(APPS, 'alpha', { isGitRepo: async () => false }), Error)
  try {
    await resolveRepo(APPS, '../escape-very-long-name-that-keeps-going-forever', { isGitRepo })
    assert.fail('should throw')
  } catch (e) {
    assert.ok(String(e.message).length < 120)
  }
})

test('onboardPreview calls no ask and fingerprints stably', async () => {
  let asked = 0
  const deps = previewDeps({ ask: async () => { asked += 1 } })
  const a = await onboardPreview(goodInput, deps)
  assert.equal(a.ok, true)
  assert.equal(asked, 0)
  assert.deepEqual(a.sent, deps.buildMessages(await deps.inspectRepo(join(APPS, 'alpha')), 'SKILL', { good: 'v1', cand: 'v2' }))
  const b = await onboardPreview(goodInput, deps)
  assert.equal(a.confirm, b.confirm)
  const c = await onboardPreview({ ...goodInput, good: 'v9' }, deps)
  assert.notEqual(a.confirm, c.confirm)
  const d = await onboardPreview(goodInput, previewDeps({ skillText: 'OTHER' }))
  assert.notEqual(a.confirm, d.confirm)
  assert.deepEqual(a.facts.tags.length <= 5, true)
  assert.deepEqual(a.facts.scripts, ['dev', 'build'])
  assert.equal(a.model, 'muse-spark-1.3')
})

test('a commit sha is a valid version, like a tag or a branch', async () => {
  const sha40 = 'a'.repeat(40)
  const r = await onboardPreview({ ...goodInput, good: '694d36c', cand: sha40 }, previewDeps())
  assert.equal(r.ok, true)
  assert.equal(r.sent[1].content, `694d36c:${sha40}:/apps/alpha`)
})

test('listRefs offers tags, the branch and recent commits, and suggests a pair', async () => {
  const deps = previewDeps({ inspectRepo: async (path) => ({ path, isGit: true, tags: [], branch: 'main', recent: [{ sha: '694d36c', subject: 'Data: nightly sky' }, { sha: 'd88b984', subject: 'Data: nightly sky' }] }) })
  const r = await listRefs({ repo: 'alpha' }, deps)
  assert.equal(r.ok, true)
  assert.deepEqual(r.tags, [])
  assert.equal(r.branch, 'main')
  assert.equal(r.recent.length, 2)
  assert.deepEqual(r.suggest, { good: 'd88b984', cand: 'main' })
  const missing = await listRefs({ repo: 'nope' }, deps)
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 404)
  const bad = await listRefs({ repo: '../etc' }, deps)
  assert.equal(bad.ok, false)
})

test('suggestPair prefers the two newest tags, then one tag against the branch, then the commit before HEAD against the branch', () => {
  assert.deepEqual(suggestPair({ tags: ['v2', 'v1'], branch: 'main' }), { good: 'v1', cand: 'v2' })
  assert.deepEqual(suggestPair({ tags: ['v1'], branch: 'main' }), { good: 'v1', cand: 'main' })
  assert.deepEqual(suggestPair({ tags: ['v1'], branch: null, recent: [{ sha: 'aaa' }] }), { good: 'v1', cand: 'aaa' })
  assert.deepEqual(suggestPair({ tags: [], branch: null, recent: [{ sha: 'aaa' }, { sha: 'bbb' }] }), { good: 'bbb', cand: 'aaa' })
  assert.deepEqual(suggestPair({ tags: [], branch: 'main', recent: [{ sha: 'aaa' }] }), { good: null, cand: null })
})

test('onboardPreview refusals and canSend', async () => {
  const noKey = await onboardPreview(goodInput, previewDeps({ keyPresent: false }))
  assert.equal(noKey.ok, true)
  assert.equal(noKey.canSend, false)
  assert.match(noKey.reason, /No API key/)
  assert.equal((await onboardPreview(goodInput, previewDeps({ listProfiles: async () => ['myapp'] }))).ok, false)
  assert.equal((await onboardPreview({ ...goodInput, name: 'Bad Name' }, previewDeps())).ok, false)
  for (const patch of [{ good: '' }, { cand: '' }, { good: '-x' }, { cand: 'a b' }, { good: 'x'.repeat(61) }]) {
    assert.equal((await onboardPreview({ ...goodInput, ...patch }, previewDeps())).ok, false)
  }
})

test('onboardPropose guards confirm, cost, writes once, forces name', async () => {
  const writes = []
  let asks = 0
  const mk = (over = {}) => previewDeps({
    ask: async (messages) => { asks += 1; return { text: '{}', pt: 1000, ct: 2000 } },
    proposeProfile: async ({ facts, skillText, ask, good, cand }) => {
      const r = await ask([{ role: 'system', content: skillText }, { role: 'user', content: `${good}:${cand}:${facts.path}` }]) // the same text previewDeps().buildMessages makes
      return { profile: { name: 'model-name', serve: { kind: 'static' } }, problems: [], usage: { pt: r.pt ?? 0, ct: r.ct ?? 0 } }
    },
    describeCommands: (p) => (p.serve.kind === 'static' ? ['serve: built-in static file server'] : ['serve: npm start']),
    writeFile: async (path, text) => { writes.push({ path, text }) },
    ...over,
  })
  const prev = await onboardPreview(goodInput, mk())
  // missing confirm
  asks = 0
  const bad = await onboardPropose(goodInput, mk())
  assert.equal(bad.ok, false)
  assert.equal(bad.status, 409)
  assert.equal(asks, 0)
  const wrong = await onboardPropose({ ...goodInput, confirm: 'deadbeefdeadbeef' }, mk())
  assert.equal(wrong.status, 409)
  assert.equal(asks, 0)
  // cost above max
  asks = 0
  const pricey = await onboardPropose({ ...goodInput, confirm: prev.confirm }, mk({ projectCost: () => 9 }))
  assert.equal(pricey.ok, false)
  assert.equal(asks, 0)
  // good: one ask, one write, name forced, static needs no approval, usd math
  asks = 0
  writes.length = 0
  const okp = await onboardPropose({ ...goodInput, confirm: prev.confirm }, mk())
  assert.equal(okp.ok, true)
  assert.equal(asks, 1)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, join('out', 'onboard', 'myapp.proposed.json'))
  assert.equal(okp.profile.name, 'myapp')
  assert.equal(okp.needsApproval, false)
  assert.equal(okp.usd, 1000 * 1.25e-6 + 2000 * 4.25e-6)
  // command needs approval
  const cmdDeps = mk({
    proposeProfile: async () => ({ profile: { name: 'x', serve: { kind: 'command', cmd: 'npm', args: ['start'] } }, problems: [], usage: { pt: 1, ct: 1 } }),
  })
  const prev2 = await onboardPreview(goodInput, cmdDeps)
  const okc = await onboardPropose({ ...goodInput, confirm: prev2.confirm }, cmdDeps)
  assert.equal(okc.needsApproval, true)
  // null profile writes nothing
  const nullDeps = mk({ proposeProfile: async () => ({ profile: null, problems: ['nope'], usage: { pt: 0, ct: 0 } }) })
  const prev3 = await onboardPreview(goodInput, nullDeps)
  writes.length = 0
  const nul = await onboardPropose({ ...goodInput, confirm: prev3.confirm }, nullDeps)
  assert.equal(nul.ok, false)
  assert.equal(nul.status, 502)
})

test('what is sent is exactly what was previewed: the propose step passes the real facts and checks the text at the moment of sending', async () => {
  const sentTexts = []
  const real = (deps, over = {}) => ({
    ...deps,
    ask: async messages => { sentTexts.push(messages); return { text: '{}', pt: 10, ct: 10 } },
    // like the real proposeProfile: the messages come from the facts it is given
    proposeProfile: async ({ facts, skillText, ask, good, cand }) => {
      const r = await ask(deps.buildMessages(facts, skillText, { good, cand }))
      return { profile: { name: 'x', serve: { kind: 'static' } }, problems: [], usage: { pt: r.pt, ct: r.ct } }
    },
    describeCommands: () => ['serve: built-in static file server'],
    writeFile: async () => {},
    ...over,
  })
  const deps = real(previewDeps())
  const prev = await onboardPreview(goodInput, deps)
  const done = await onboardPropose({ ...goodInput, confirm: prev.confirm }, deps)
  assert.equal(done.ok, true)
  assert.equal(sentTexts.length, 1)
  assert.deepEqual(sentTexts[0], prev.sent, 'the model received exactly the text the person reviewed')
  assert.match(JSON.stringify(sentTexts[0]), /alpha/, 'and it contains the repository facts, not undefined')
  // a proposer that builds a different text is stopped before anything is sent
  sentTexts.length = 0
  const sneaky = real(previewDeps(), { proposeProfile: async ({ ask }) => { await ask([{ role: 'user', content: 'something else' }]); return { profile: { serve: { kind: 'static' } }, problems: [], usage: {} } } })
  const r = await onboardPropose({ ...goodInput, confirm: prev.confirm }, sneaky)
  assert.equal(r.ok, false)
  assert.equal(sentTexts.length, 0, 'nothing was sent')
  assert.match(r.error, /nothing was sent/)
})

test('onboardPreview never returns the raw facts', async () => {
  const p = await onboardPreview(goodInput, previewDeps())
  assert.equal('raw' in p, false)
})

test('onboardVerify refuses a proposal named for another app and a name that is already saved', async () => {
  const files = { [join('out', 'onboard', 'myapp.proposed.json')]: JSON.stringify({ name: 'musicblocks', serve: { kind: 'static' } }) }
  let verified = 0, saved = 0
  const base = (over = {}) => ({
    readFile: async p => files[p], describeCommands: async () => ['serve: built-in static file server'], validateProfile: async () => [],
    verifyProfile: async () => { verified += 1; return { ok: true, checks: [] } }, saveProfile: async () => { saved += 1; return 'p' }, ...over,
  })
  const other = await onboardVerify({ name: 'myapp', good: 'v1', cand: 'v2' }, base())
  assert.equal(other.status, 400); assert.match(other.error, /different app/)
  files[join('out', 'onboard', 'myapp.proposed.json')] = JSON.stringify({ name: 'myapp', serve: { kind: 'static' } })
  const dup = await onboardVerify({ name: 'myapp', good: 'v1', cand: 'v2' }, base({ listProfiles: async () => ['myapp'] }))
  assert.equal(dup.status, 400); assert.match(dup.error, /already exists/)
  assert.equal(verified + saved, 0, 'nothing was verified or saved')
})

test('onboardVerify approvals, save rules, bad files', async () => {
  const staticProfile = { name: 'myapp', serve: { kind: 'static' } }
  const cmdProfile = { name: 'myapp', serve: { kind: 'command', cmd: 'npm', args: ['start'] } }
  const files = {}
  const base = (over = {}) => ({
    readFile: async (p) => { if (!(p in files)) throw new Error('missing ' + p); return files[p] },
    describeCommands: async (p) => (p.serve.kind === 'static' ? ['serve: built-in static file server'] : ['serve: npm start']),
    validateProfile: async () => [],
    verifyProfile: async () => ({ ok: true, checks: [{ name: 'a', ok: true, detail: 'd' }] }),
    saveProfile: async () => '/profiles/myapp.json',
    ports: [8301, 8302],
    log: () => {},
    ...over,
  })
  files[join('out', 'onboard', 'myapp.proposed.json')] = JSON.stringify(cmdProfile)
  const approvalTries = [{ hasKey: true, value: 'true' }, { hasKey: true, value: 1 }, { hasKey: false, value: undefined }]
  for (const t of approvalTries) {
    let verified = 0
    const input = t.hasKey
      ? { name: 'myapp', good: 'v1', cand: 'v2', approveCommands: t.value }
      : { name: 'myapp', good: 'v1', cand: 'v2' }
    const r = await onboardVerify(input, base({ verifyProfile: async () => { verified += 1 } }))
    assert.equal(r.status, 400)
    assert.equal(r.needsApproval, true)
    assert.ok(Array.isArray(r.commands))
    assert.match(r.error, /Approve them first/)
    assert.equal(verified, 0)
  }
  files[join('out', 'onboard', 'myapp.proposed.json')] = JSON.stringify(staticProfile)
  let verified = 0
  const s = await onboardVerify({ name: 'myapp', good: 'v1', cand: 'v2' }, base({ verifyProfile: async () => { verified += 1; return { ok: true, checks: [] } } }))
  assert.equal(s.ok, true)
  assert.equal(verified, 1)
  // failing verification never saves
  let saved = 0
  const f = await onboardVerify({ name: 'myapp', good: 'v1', cand: 'v2' }, base({ verifyProfile: async () => ({ ok: false, checks: [] }), saveProfile: async () => { saved += 1 } }))
  assert.equal(f.ok, false)
  assert.equal(f.status, 422)
  assert.equal(saved, 0)
  // success saves once
  saved = 0
  const g = await onboardVerify({ name: 'myapp', good: 'v1', cand: 'v2' }, base({ saveProfile: async () => { saved += 1; return 'p' } }))
  assert.equal(g.saved, true)
  assert.equal(saved, 1)
  // missing, bad json, invalid profile
  const m = await onboardVerify({ name: 'nope', good: 'v1', cand: 'v2' }, base())
  assert.equal(m.status, 404)
  files[join('out', 'onboard', 'bad.proposed.json')] = 'not json{'
  assert.equal((await onboardVerify({ name: 'bad', good: 'v1', cand: 'v2' }, base())).status, 400)
  files[join('out', 'onboard', 'myapp.proposed.json')] = JSON.stringify(staticProfile)
  assert.equal((await onboardVerify({ name: 'myapp', good: 'v1', cand: 'v2' }, base({ validateProfile: async () => ['oops'] }))).status, 400)
  // throwing collaborator becomes clean false
  const t = await onboardVerify({ name: 'myapp', good: 'v1', cand: 'v2' }, base({ readFile: async () => { throw new Error('boom') } }))
  assert.equal(t.ok, false)
  const t2 = await onboardVerify({ name: 'myapp', good: 'v1', cand: 'v2' }, base({ verifyProfile: async () => { throw new Error('boom') } }))
  assert.equal(t2.ok, false)
})
