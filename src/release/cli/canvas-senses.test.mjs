// node --test src/release/cli/canvas-senses.test.mjs   (offline: no browser, no network, no model)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCase } from '../evidence.mjs'
import { runAiStages, selectedStages } from './ai-stages.mjs'
import { compareControls, githubSlug, isPublicRepo, projectedUsd, qualifies, run } from './canvas-senses.mjs'

const PNG = Buffer.alloc(24); PNG.writeUInt32BE(2560, 16); PNG.writeUInt32BE(1600, 20)
const controls = [{ label: 'Play', kind: 'button', point: [0.1, 0.1] }, { label: 'Save', kind: 'icon', point: [0.2, 0.1] }, { label: 'Tempo', kind: 'slider', point: [0.3, 0.1], dragTo: [0.4, 0.1] }]
const vision = { discover: async (png, size, ask) => { const r = await ask('prompt', png); return { controls, dropped: 0, parseFailed: false, usage: { pt: r.pt, ct: r.ct } } } }
const caseDir = () => { const dir = mkdtempSync(join(tmpdir(), 'cv-')); const c = openCase(dir); c.event('case.opened', { goodRef: 'a', candRef: 'b', app: 'mb', adapter: 'mb', steps: [] }); c.event('case.closed', { outcome: 'no change' }); return dir }
const fakeBrowser = (verdicts, log = []) => ({
  screenshot: async base => { log.push('shot ' + base); return { png: PNG, settled: true } },
  probe: async (base, c) => { log.push(`probe ${base} ${c.label}`); return { verdict: verdicts(base, c), ready: true } },
})
const build = async ({ ref }) => ({ base: 'http://x/' + ref, stop: async () => {} })
const fakeAsk = log => async (messages, opts) => { log.push({ messages, opts }); return { text: '{}', model: 'fake', provider: 'meta', pt: 6000, ct: 1000, usage: { promptTokens: 6000, completionTokens: 1000 } } }
const baseDeps = (over = {}) => ({ needsSandbox: () => false, loadProfile: async () => ({ repo: '/r', regions: { toolbar: {} } }), profileToAdapter: p => p, isPublic: async () => ({ ok: true, slug: 'o/n' }), startBuild: build, vision, ...over })
const ctx = { app: 'mb', good: 'v1', cand: 'v2' }

test('qualifies: a profile with regions or anchors, or a case with a canvas comparison; not a plain web app', () => {
  assert.equal(qualifies({ regions: { a: {} } }), true)
  assert.equal(qualifies({ anchors: { a: {} } }), true)
  assert.equal(qualifies({}, [{ type: 'canvas.compared' }]), true)
  assert.equal(qualifies({}, []), false)
  assert.equal(qualifies(null, []), false)
})

test('githubSlug and isPublicRepo: public only when GitHub says so without a login; everything unknown is private', async () => {
  assert.equal(githubSlug('https://github.com/sugarlabs/musicblocks.git'), 'sugarlabs/musicblocks')
  assert.equal(githubSlug('git@github.com:a/b.git'), 'a/b'); assert.equal(githubSlug('https://example.com/a/b'), null)
  const run = url => async () => ({ stdout: url + '\n' })
  const f = (ok, body) => async () => ({ ok, status: ok ? 200 : 404, json: async () => body })
  assert.equal((await isPublicRepo('/r', { run: run('https://github.com/a/b.git'), fetchFn: f(true, { private: false }) })).ok, true)
  assert.equal((await isPublicRepo('/r', { run: run('https://github.com/a/b.git'), fetchFn: f(true, { private: true }) })).ok, false)
  assert.match((await isPublicRepo('/r', { run: run('https://github.com/a/b.git'), fetchFn: f(false, {}) })).why, /404/)
  assert.equal((await isPublicRepo('/r', { run: run('/srv/git/b'), fetchFn: f(true, { private: false }) })).ok, false)
  assert.equal((await isPublicRepo('/r', { run: run('https://github.com/a/b'), fetchFn: async () => { throw new Error('offline') } })).ok, false)
})

test('compareControls: unsteady controls are left out, a different reaction is reported, skipped is ignored', () => {
  const cs = [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }]
  const mk = (i, g, c, g2 = g, c2 = c) => [['good', 'A', g], ['good', 'B', g2], ['cand', 'A', c], ['cand', 'B', c2]].map(([side, run, verdict]) => ({ side, i, run, verdict, ready: true }))
  const rows = [...mk(0, 'changed', 'no_change'), ...mk(1, 'changed', 'changed'), ...mk(2, 'changed', 'no_change', 'no_change'), ...mk(3, 'skipped_blank', 'skipped_blank')]
  const r = compareControls(cs, rows)
  assert.deepEqual(r.differs.map(d => d.control.label), ['a'])
  assert.deepEqual(r.unstable.map(c => c.label), ['c'])
  assert.equal(r.compared, 2)
})

test('a profile that runs the repository\'s own code is refused when the sandbox is off', async () => {
  const had = process.env.BEHIQUE_SANDBOX; delete process.env.BEHIQUE_SANDBOX
  try { const r = await run({ caseDir: caseDir(), ask: fakeAsk([]), context: ctx, deps: baseDeps({ needsSandbox: () => true }) }); assert.match(r.notes[0], /sandbox is off/) } finally { if (had !== undefined) process.env.BEHIQUE_SANDBOX = had }
})

test('the stage skips, with a reason and without spending, for a non-canvas app and for a repository not confirmed public', async () => {
  const log = []
  const a = await run({ caseDir: caseDir(), ask: fakeAsk(log), context: ctx, deps: baseDeps({ loadProfile: async () => ({ repo: '/r' }) }) })
  assert.match(a.notes[0], /not a canvas app/)
  const b = await run({ caseDir: caseDir(), ask: fakeAsk(log), context: ctx, deps: baseDeps({ isPublic: async () => ({ ok: false, why: 'it is private' }) }) })
  assert.match(b.notes[0], /only public apps.*it is private/)
  const c = await run({ caseDir: caseDir(), ask: fakeAsk(log), context: ctx, maxUsd: 0.001, deps: baseDeps() })
  assert.match(c.notes[0], /over the remaining AI budget/)
  assert.equal(log.length, 0, 'no model call in any of the three')
})

test('one model call lists the controls; code clicks them on both versions and reports only a steady difference', async () => {
  const askLog = [], lines = [], browserLog = []
  const browser = fakeBrowser((base, c) => (c.label === 'Save' && base.endsWith('v2') ? 'no_change' : 'changed'), browserLog)
  const out = await run({ caseDir: caseDir(), ask: fakeAsk(askLog), context: { ...ctx, log: l => lines.push(l) }, deps: baseDeps({ browser }) })
  assert.equal(askLog.length, 1, 'exactly one model call')
  assert.match(lines[0], /ONE screenshot.*projected about \$0\.0\d\d/)
  assert.equal(browserLog.filter(l => l.startsWith('probe')).length, 2 * 2 * 2, 'two clickable controls x two versions x two runs; the slider is not clicked')
  assert.equal(out.items.length, 2)
  assert.match(out.items[0].text, /listed 3 controls.*1 were sliders/)
  assert.match(out.items[1].text, /"Save".*changed the picture on v1 and changed nothing on v2/)
  assert.equal(out.items[1].status, 'measured by code')
})

test('through the seam: its own flag, outside --ai, one counted call, a model.call event, and the cap applies', async () => {
  assert.deepEqual(selectedStages({ ai: true }).includes('canvas'), false)
  assert.deepEqual(selectedStages({ aiCanvas: true }), ['canvas'])
  const dir = caseDir(); const log = []
  const browser = fakeBrowser(() => 'changed')
  const load = async () => ({ run: o => run({ ...o, deps: baseDeps({ browser }) }) })
  const out = await runAiStages({ caseDir: dir, stages: ['canvas'], ask: fakeAsk(log), load, context: ctx })
  assert.equal(out.stages[0].status, 'ran'); assert.equal(log.length, 1)
  assert.ok(out.stages[0].spentUsd > 0 && Math.abs(out.stages[0].spentUsd - (6000 * 1.25e-6 + 1000 * 4.25e-6)) < 1e-6)
  assert.equal(openCase(dir).read().filter(e => e.type === 'model.call' && e.data.kind === 'canvas').length, 1)
  assert.ok(projectedUsd(1) < 0.03)
})
