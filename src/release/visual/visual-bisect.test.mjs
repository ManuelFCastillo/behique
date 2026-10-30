// Offline tests for visualBisect with a real temp git repo and fake builds and pictures.
// Run: node --test src/release/visual/visual-bisect.test.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { bisect } from '../bisect.mjs'
import { blank, diff, encode, paint, scaleBox } from '../../senses/pixels.mjs'
import { visualBisect } from './visual-bisect.mjs'

const W = 64
const H = 32
const EDGE = { x: 0, y: 0, w: 8, h: 32 }
const WORK = { x: 32, y: 8, w: 16, h: 16 }
const STRIP = { x: 2, y: 2, w: 4, h: 28 }

function profile() {
  return {
    viewport: { width: W, height: H, deviceScaleFactor: 1 },
    regions: { edge: EDGE },
    anchors: { work: WORK },
  }
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'vb-repo-'))
  const workRoot = mkdtempSync(join(tmpdir(), 'vb-work-'))
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'])
  const shas = []
  for (let i = 0; i < 9; i++) {
    writeFileSync(join(repo, 'file.txt'), `line ${i}\n`)
    execFileSync('git', ['-C', repo, 'add', 'file.txt'])
    execFileSync('git', ['-C', repo, 'commit', '-qm', `commit ${i}`])
    shas.push(git('rev-parse', 'HEAD'))
  }
  execFileSync('git', ['-C', repo, 'tag', 'good', shas[0]])
  execFileSync('git', ['-C', repo, 'tag', 'bad', shas[8]])
  const adapter = { name: 'test', repo, workRoot, cleanPaths: ['.does-not-exist'], feed: null, basePath: '' }
  return { repo, workRoot, adapter, shas, git }
}

function pngFor(idx, K, brokenIdx) {
  const img = blank(W, H, [255, 255, 255, 255])
  if (K !== null && idx >= K) paint(img, STRIP, [0, 0, 0, 255])
  if (brokenIdx !== null && idx === brokenIdx) paint(img, WORK, [0, 0, 0, 255])
  return encode(img)
}

function fakes(ctx, { K, brokenIdx = null, failIdx = null }) {
  const starts = []
  const stops = []
  const shaToIdx = new Map(ctx.shas.map((s, i) => [s, i]))
  const idxOfSha = sha => {
    if (shaToIdx.has(sha)) return shaToIdx.get(sha)
    const full = ctx.git('rev-parse', `${sha}^{commit}`)
    return shaToIdx.get(full)
  }
  const startBuildFn = async ({ ref }) => {
    const sha = ctx.git('rev-parse', `${ref}^{commit}`)
    const idx = idxOfSha(sha)
    if (failIdx !== null && idx === failIdx) throw new Error('boom failed\nsecond line')
    starts.push(sha)
    return { ref, sha, base: `fake://${sha}`, stop: async () => { stops.push(sha) } }
  }
  const pictureFn = async baseOrUrl => {
    const arg = typeof baseOrUrl === 'string' ? baseOrUrl : baseOrUrl
    const sha = String(arg).replace(/^fake:\/\//, '')
    const idx = idxOfSha(sha)
    return { png: pngFor(idx, K, brokenIdx), settled: true, ms: 1, errors: [], blocked: [] }
  }
  const floorFn = async () => ({ n: 3, changed: 0, regions: { edge: 0, work: 0 } })
  return { starts, stops, startBuildFn, pictureFn, floorFn }
}

test('finds the first bad commit and returns evidence', async () => {
  const ctx = makeRepo()
  const K = 5
  const f = fakes(ctx, { K })
  const tested = new Set()
  const pictureFn = async (...a) => {
    const sha = String(a[0]).replace(/^fake:\/\//, '')
    tested.add(sha)
    return f.pictureFn(...a)
  }
  const r = await visualBisect({
    adapter: ctx.adapter,
    profile: profile(),
    goodRef: 'good',
    badRef: 'bad',
    region: 'edge',
    port: 8300,
    runs: 2,
    loads: 3,
    log: () => {},
    onEvent: () => {},
    deps: { ...f, pictureFn, bisectFn: bisect },
  })
  assert.equal(r.conclusive, true)
  assert.equal(r.verified, true)
  assert.equal(r.commit, ctx.shas[K])
  assert.equal(r.region, 'edge')
  assert.ok(r.reference)
  assert.ok(r.pictures.parent)
  assert.ok(r.pictures.first)
  const inFirst = diff(r.pictures.parent, r.pictures.first, { region: scaleBox(EDGE, 1) }).inRegion
  assert.ok(inFirst > 0, 'first differs from parent inside the region')
  const inParent = diff(r.reference, r.pictures.parent, { region: scaleBox(EDGE, 1) }).inRegion
  assert.equal(inParent, 0, 'parent matches the reference')
  assert.equal(r.reports.parent.above, false)
  assert.equal(r.reports.first.above, true)
  assert.ok(tested.size < 9, `tested ${tested.size} commits, should be fewer than all 9`)
  assert.ok(tested.size <= 6, `tested ${tested.size} commits, should be about log2 plus verification`)
  assert.equal(f.starts.length, f.stops.length, 'every started build was stopped')
})

test('a commit that breaks an anchor is skipped via a neighbour', async () => {
  const ctx = makeRepo()
  const K = 5
  const brokenIdx = 6
  const f = fakes(ctx, { K, brokenIdx })
  const r = await visualBisect({
    adapter: ctx.adapter,
    profile: profile(),
    goodRef: 'good',
    badRef: 'bad',
    region: 'edge',
    port: 8300,
    runs: 2,
    log: () => {},
    onEvent: () => {},
    deps: { ...f, bisectFn: bisect },
  })
  assert.equal(r.conclusive, true)
  assert.equal(r.commit, ctx.shas[K])
  assert.equal(f.starts.length, f.stops.length)
})

test('a failing build is skipped the same way', async () => {
  const ctx = makeRepo()
  const K = 5
  const f = fakes(ctx, { K, failIdx: 6 })
  const r = await visualBisect({
    adapter: ctx.adapter,
    profile: profile(),
    goodRef: 'good',
    badRef: 'bad',
    region: 'edge',
    port: 8300,
    runs: 2,
    log: () => {},
    onEvent: () => {},
    deps: { ...f, bisectFn: bisect },
  })
  assert.equal(r.conclusive, true)
  assert.equal(r.commit, ctx.shas[K])
  assert.equal(f.starts.length, f.stops.length)
})

test('no difference throws the nothing to bisect error and still stops builds', async () => {
  const ctx = makeRepo()
  const f = fakes(ctx, { K: null })
  await assert.rejects(
    () => visualBisect({ adapter: ctx.adapter, profile: profile(), goodRef: 'good', badRef: 'bad', region: 'edge', log: () => {}, deps: { ...f, bisectFn: bisect } }),
    /nothing to bisect/
  )
  assert.equal(f.starts.length, f.stops.length)
  assert.ok(f.starts.length >= 2)
})

test('a broken candidate throws the broken error', async () => {
  const ctx = makeRepo()
  const K = 5
  const f = fakes(ctx, { K, brokenIdx: 8 })
  await assert.rejects(
    () => visualBisect({ adapter: ctx.adapter, profile: profile(), goodRef: 'good', badRef: 'bad', region: 'edge', log: () => {}, deps: { ...f, bisectFn: bisect } }),
    /looks broken/
  )
  assert.equal(f.starts.length, f.stops.length)
})

test('an unknown region name throws', async () => {
  const ctx = makeRepo()
  const f = fakes(ctx, { K: 5 })
  await assert.rejects(
    () => visualBisect({ adapter: ctx.adapter, profile: profile(), goodRef: 'good', badRef: 'bad', region: 'nope', log: () => {}, deps: { ...f, bisectFn: bisect } }),
    /unknown region/
  )
  assert.equal(f.starts.length, f.stops.length)
})
