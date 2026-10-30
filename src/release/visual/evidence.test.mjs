// Tests for the visual check evidence case. Offline, synthetic pictures only.
// Run: node --test src/release/visual/evidence.test.mjs
import { strict as assert } from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openCase, summarize } from '../evidence.mjs'
import { buildViewModel } from '../viewmodel.mjs'
import { blank, encode, paint } from '../../senses/pixels.mjs'
import { recordVisualCase } from './evidence.mjs'

function pics({ same = false } = {}) {
  const ref = encode(blank(20, 10, [255, 255, 255, 255]))
  const cand = same
    ? encode(blank(20, 10, [255, 255, 255, 255]))
    : encode(paint(blank(20, 10, [255, 255, 255, 255]), { x: 1, y: 1, w: 4, h: 3 }, [0, 0, 0, 255]))
  return { ref, cand }
}

function profile() {
  return { name: 'demoapp', viewport: { width: 10, height: 5, deviceScaleFactor: 1 }, regions: { top: { x: 0, y: 0, w: 10, h: 5 } }, anchors: {} }
}

function floorFor(regions = { top: 0 }) {
  return { n: 3, changed: 0, regions }
}

function baseArgs(root, over = {}) {
  const { ref, cand } = pics()
  return {
    evidenceRoot: root,
    profile: profile(),
    goodRef: 'v1',
    candRef: 'v2',
    goodSha: 'aaaaaaa',
    candSha: 'bbbbbbb',
    reference: ref,
    candidate: cand,
    floor: floorFor(),
    reports: [{ name: 'top', region: { x: 0, y: 0, w: 10, h: 5 }, changed: 12, inRegion: 12, above: true }],
    now: new Date('2026-10-29T21:41:31.000Z'),
    ...over,
  }
}

function readBack(root, caseId) {
  return openCase(join(root, caseId)).read()
}

test('differences without bisect: claims, artifacts, outcome, viewmodel', () => {
  const root = mkdtempSync(join(tmpdir(), 'vis-'))
  const { caseId, outcome, ok } = recordVisualCase(baseArgs(root))
  assert.equal(outcome, 'differences found')
  assert.equal(ok, true)
  const events = readBack(root, caseId)
  const sum = summarize(events)
  assert.ok(sum.opened && sum.opened.kind === 'visual')
  assert.ok(events.some(e => e.type === 'case.closed'))
  const labels = sum.claims.map(c => c.label)
  assert.ok(labels.includes('statistical'))
  assert.ok(labels.includes('verified_fact'))
  assert.ok(sum.claims.every(c => c.by === 'code'))
  for (const cl of sum.claims.filter(c => c.label === 'verified_fact' || c.label === 'reproduced_failure')) {
    for (const h of cl.evidence) assert.ok(sum.artifacts[h], `missing evidence ${h}`)
  }
  const names = Object.values(sum.artifacts).map(a => a.name)
  assert.ok(names.includes('good-picture.png'))
  assert.ok(names.includes('candidate-picture.png'))
  assert.ok(names.includes('diff-top.png'))
  assert.ok(names.includes('floor.json'))
  const media = Object.fromEntries(Object.values(sum.artifacts).map(a => [a.name, a.mediaType]))
  assert.equal(media['good-picture.png'], 'image/png')
  assert.equal(media['floor.json'], 'application/json')
  const vm = buildViewModel(openCase(join(root, caseId)))
  assert.equal(vm.verdict, 'inconclusive')
})

test('verified bisect gives regression proven and hold', () => {
  const root = mkdtempSync(join(tmpdir(), 'vis-'))
  const { ref, cand } = pics()
  const bisect = {
    conclusive: true,
    verified: true,
    commit: 'abcdef123456',
    parent: '0000000',
    subject: 'change toolbar',
    files: ['a.js', 'b.js'],
    region: 'top',
    runs: 3,
    log: ['line one'],
    pictures: { parent: ref, first: cand },
    reports: {},
  }
  const args = baseArgs(root, { bisect, region: 'top' })
  const { caseId, outcome, ok } = recordVisualCase(args)
  assert.equal(outcome, 'regression proven')
  assert.equal(ok, true)
  const events = readBack(root, caseId)
  const sum = summarize(events)
  const rep = sum.claims.find(c => c.label === 'reproduced_failure')
  assert.ok(rep)
  assert.ok(rep.text.includes('abcdef1'))
  assert.ok(rep.text.includes('3 of 3 runs'))
  const bArt = Object.values(sum.artifacts).find(a => a.name === 'bisect.json')
  assert.ok(bArt)
  const raw = JSON.parse(readFileSync(join(root, caseId, 'artifacts', bArt.hash)))
  assert.ok(raw.result)
  assert.deepEqual(raw.log, ['line one'])
  assert.ok(Object.values(sum.artifacts).some(a => a.name === 'parent-picture.png'))
  assert.ok(Object.values(sum.artifacts).some(a => a.name === 'first-bad-picture.png'))
  const vm = buildViewModel(openCase(join(root, caseId)))
  assert.equal(vm.verdict, 'hold')
})

test('nothing differs gives no candidate defects and ship', () => {
  const root = mkdtempSync(join(tmpdir(), 'vis-'))
  const { ref, cand } = pics({ same: true })
  const args = baseArgs(root, {
    reference: ref,
    candidate: cand,
    reports: [{ name: 'top', region: { x: 0, y: 0, w: 10, h: 5 }, changed: 0, inRegion: 0, above: false }],
  })
  const { caseId, outcome, ok } = recordVisualCase(args)
  assert.equal(outcome, 'no candidate defects')
  assert.equal(ok, true)
  const events = readBack(root, caseId)
  assert.equal(buildViewModel(openCase(join(root, caseId))).verdict, 'ship')
  const sum = summarize(events)
  assert.ok(!Object.values(sum.artifacts).some(a => a.name.startsWith('diff-')))
})

test('not verified and not conclusive bisect wording', () => {
  const root = mkdtempSync(join(tmpdir(), 'vis-'))
  const { ref, cand } = pics()
  const mk = bisect => recordVisualCase(baseArgs(root, { bisect, region: 'top', now: new Date(`2026-10-29T21:41:${30 + Math.floor(Math.random() * 20)}Z`) }))
  const r1 = mk({ conclusive: true, verified: false, commit: 'abc0000', subject: 'maybe', region: 'top', pictures: null })
  assert.equal(r1.outcome, 'differences found')
  const s1 = summarize(readBack(root, r1.caseId))
  const sus1 = s1.claims.find(c => c.label === 'suspected_cause')
  assert.ok(sus1 && sus1.text.includes('not clean'))
  const r2 = mk({ conclusive: false, verified: false, range: ['a', 'b', 'c'], region: 'top' })
  const s2 = summarize(readBack(root, r2.caseId))
  const sus2 = s2.claims.find(c => c.label === 'suspected_cause')
  assert.ok(sus2 && sus2.text.includes('one of 3'))
})
