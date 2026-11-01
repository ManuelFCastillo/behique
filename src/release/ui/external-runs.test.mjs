// Tests for external runs: phases, run rows and recent case reading. Run with: node --test src/release/ui/external-runs.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCase, listCases } from '../evidence.mjs'
import { PHASES, phaseOf, externalRuns, recentCases } from './external-runs.mjs'

function makeCase(events) {
  const dir = mkdtempSync(join(tmpdir(), 'behique-ext-'))
  const c = openCase(join(dir, 'case'))
  for (const [type, data] of events) c.event(type, data)
  return { dir: join(dir, 'case'), events: c.read() }
}

function openedTs(events) {
  return events.find(e => e.type === 'case.opened').ts
}

describe('phaseOf', () => {
  it('empty case is starting', () => {
    assert.deepEqual(phaseOf([]), { phase: 'starting', pct: 0, lastType: null, lastAt: null, done: false, text: 'starting' })
  })

  it('no phased event is starting but keeps lastAt', () => {
    const { events } = makeCase([['artifact', { name: 'a' }], ['claim', { label: 'x' }]])
    const got = phaseOf(events)
    assert.equal(got.phase, 'starting')
    assert.equal(got.pct, 0)
    assert.equal(got.lastType, null)
    assert.equal(got.lastAt, events.at(-1).ts)
    assert.equal(got.done, false)
    assert.equal(got.text, 'starting')
  })

  it('covers each phase in the table', () => {
    const rows = [
      ['case.opened', 'recording the good version', 5],
      ['builds.compared', 'comparing the versions', 35],
      ['masking.summary', 'comparing the versions', 35],
      ['test.run', 'running tests', 60],
      ['shots.recorded', 'taking screenshots', 80],
      ['shots.failed', 'taking screenshots', 80],
      ['bisect.started', 'bisecting', 85],
      ['bisect.done', 'bisecting', 95],
      ['decision', 'done', 100],
    ]
    for (const [type, phase, pct] of rows) {
      const { events } = makeCase([['case.opened', {}], [type, {}]])
      const got = phaseOf(events)
      assert.equal(got.phase, phase, type)
      assert.equal(got.pct, pct, type)
      assert.equal(got.lastType, type, type)
      assert.equal(got.text, phase, type)
    }
  })

  it('counts test.exported, test.judged and bisect.step', () => {
    const a = makeCase([['case.opened', {}], ['test.exported', {}], ['test.exported', {}]])
    assert.equal(phaseOf(a.events).text, 'writing tests (2 so far)')
    const b = makeCase([['case.opened', {}], ['test.exported', {}], ['test.exported', {}], ['test.exported', {}], ['test.judged', {}], ['test.judged', {}]])
    assert.equal(phaseOf(b.events).text, 'running tests (2 of 3 judged)')
    const c = makeCase([['case.opened', {}], ['bisect.started', {}], ['bisect.step', { step: 1 }], ['bisect.step', { step: 2 }]])
    assert.equal(phaseOf(c.events).text, 'bisecting (step 2)')
  })

  it('closed case reports outcome and done', () => {
    const { events } = makeCase([['case.opened', {}], ['test.run', {}], ['case.closed', { outcome: 'no candidate defects' }]])
    const got = phaseOf(events)
    assert.equal(got.phase, 'done')
    assert.equal(got.pct, 100)
    assert.equal(got.lastType, 'case.closed')
    assert.equal(got.done, true)
    assert.equal(got.text, 'done: no candidate defects')
  })

  it('done is true even when decision follows the close', () => {
    const { events } = makeCase([['case.opened', {}], ['case.closed', { outcome: 'differences found' }], ['decision', { decision: 'hold' }]])
    const got = phaseOf(events)
    assert.equal(got.done, true)
    assert.equal(got.lastType, 'decision')
    assert.equal(got.phase, 'done')
  })

  it('artifact and claim events are skipped', () => {
    const { events } = makeCase([['case.opened', {}], ['builds.compared', {}], ['artifact', { name: 'x' }], ['claim', { label: 'y' }]])
    const got = phaseOf(events)
    assert.equal(got.lastType, 'builds.compared')
    assert.equal(got.phase, 'comparing the versions')
    assert.equal(got.lastAt, events.at(-1).ts)
  })

  it('PHASES table matches the spec', () => {
    assert.deepEqual(PHASES['case.opened'], { phase: 'recording the good version', pct: 5 })
    assert.deepEqual(PHASES['test.exported'], { phase: 'writing tests', pct: 45 })
    assert.deepEqual(PHASES['test.judged'], { phase: 'running tests', pct: 65 })
    assert.deepEqual(PHASES['bisect.step'], { phase: 'bisecting', pct: 90 })
    assert.deepEqual(PHASES['case.closed'], { phase: 'done', pct: 100 })
  })
})

describe('externalRuns', () => {
  it('excludes started ids and closed cases', () => {
    const open = makeCase([['case.opened', { app: 'mb', goodRef: 'g', candRef: 'c' }]])
    const closed = makeCase([['case.opened', { app: 'mb' }], ['case.closed', { outcome: 'no candidate defects' }]])
    const rows = externalRuns({ cases: [{ id: 'a', events: open.events }, { id: 'b', events: closed.events }], started: new Set(['a']) })
    assert.deepEqual(rows, [])
    const rows2 = externalRuns({ cases: [{ id: 'a', events: open.events }, { id: 'b', events: closed.events }], started: new Set() })
    assert.equal(rows2.length, 1)
    assert.equal(rows2[0].caseId, 'a')
    assert.equal(rows2[0].external, true)
  })

  it('orders newest first by case.opened ts', () => {
    const mk = (id) => {
      const { events } = makeCase([['case.opened', { app: 'mb' }]])
      return { id, events }
    }
    const older = mk('older')
    const newer = mk('newer')
    older.events[0].ts = '2026-01-01T00:00:00.000Z'
    newer.events[0].ts = '2026-02-01T00:00:00.000Z'
    const rows = externalRuns({ cases: [older, newer] })
    assert.deepEqual(rows.map(r => r.caseId), ['newer', 'older'])
    assert.equal(rows[0].startedAt, '2026-02-01T00:00:00.000Z')
  })

  it('reads app from app then adapter then unknown', () => {
    const withApp = makeCase([['case.opened', { app: 'mine', adapter: 'other' }]])
    const withAdapter = makeCase([['case.opened', { adapter: 'ad' }]])
    const withNeither = makeCase([['case.opened', {}]])
    const rows = externalRuns({ cases: [
      { id: 'x', events: withNeither.events },
      { id: 'y', events: withAdapter.events },
      { id: 'z', events: withApp.events },
    ] })
    const byId = Object.fromEntries(rows.map(r => [r.caseId, r.app]))
    assert.equal(byId.z, 'mine')
    assert.equal(byId.y, 'ad')
    assert.equal(byId.x, 'unknown')
  })

  it('marks a stale run with the minutes', () => {
    const { events } = makeCase([['case.opened', { app: 'mb' }], ['builds.compared', {}]])
    events.at(-1).ts = '2026-03-01T10:00:00.000Z'
    const now = Date.parse('2026-03-01T10:45:30.000Z')
    const rows = externalRuns({ cases: [{ id: 's', events }], now, staleMs: 30 * 60 * 1000 })
    assert.equal(rows[0].stale, true)
    assert.ok(rows[0].text.includes('comparing the versions'))
    assert.ok(rows[0].text.includes('no new events for 45 minutes, it may have been stopped'))
    const fresh = externalRuns({ cases: [{ id: 's', events }], now: Date.parse('2026-03-01T10:10:00.000Z') })
    assert.equal(fresh[0].stale, false)
    assert.equal(fresh[0].text, 'comparing the versions')
  })

  it('skips a case without case.opened and copies refs and phase', () => {
    const { events } = makeCase([['case.opened', { app: 'mb', goodRef: 'g1', candRef: 'c1' }], ['test.run', {}]])
    const noOpen = makeCase([['builds.compared', {}]])
    const rows = externalRuns({ cases: [{ id: 'nope', events: noOpen.events }, { id: 'yes', events }], now: Date.parse(events.at(-1).ts) })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].caseId, 'yes')
    assert.equal(rows[0].goodRef, 'g1')
    assert.equal(rows[0].candRef, 'c1')
    assert.equal(rows[0].phase, 'running tests')
    assert.equal(rows[0].pct, 60)
    assert.equal(rows[0].startedAt, openedTs(events))
    assert.equal(rows[0].lastAt, events.at(-1).ts)
  })
})

describe('recentCases', () => {
  it('takes the newest limit ids in reverse lexical order', () => {
    const seen = []
    const listCasesFake = () => ['2026-01-03t-a', '2026-01-01t-a', '2026-01-02t-a', '2026-01-04t-a']
    const openCaseFake = (dir) => ({ read: () => { seen.push(dir); return [{ type: 'case.opened' }] } })
    const out = recentCases({ root: '/root', listCases: listCasesFake, openCase: openCaseFake, limit: 2 })
    assert.deepEqual(out.map(c => c.id), ['2026-01-04t-a', '2026-01-03t-a'])
    assert.deepEqual(seen, [join('/root', '2026-01-04t-a'), join('/root', '2026-01-03t-a')])
    assert.deepEqual(out[0].events, [{ type: 'case.opened' }])
  })

  it('skips an unreadable folder and returns events', () => {
    const listCasesFake = () => ['2026-02-02t-b', '2026-02-01t-a']
    const openCaseFake = (dir) => {
      if (dir.endsWith('2026-02-02t-b')) throw new Error('gone')
      return { read: () => [{ type: 'x' }] }
    }
    const out = recentCases({ root: '/r', listCases: listCasesFake, openCase: openCaseFake })
    assert.deepEqual(out, [{ id: '2026-02-01t-a', events: [{ type: 'x' }] }])
  })

  it('reads real cases written with evidence openCase', () => {
    const root = mkdtempSync(join(tmpdir(), 'behique-recent-'))
    const ids = ['2026-05-01t-one', '2026-05-02t-two']
    for (const id of ids) {
      const c = openCase(join(root, id))
      c.event('case.opened', { app: 'mb', goodRef: 'g', candRef: 'c' })
    }
    const out = recentCases({ root, listCases, openCase, limit: 25 })
    assert.deepEqual(out.map(c => c.id), ['2026-05-02t-two', '2026-05-01t-one'])
    assert.equal(out[0].events[0].type, 'case.opened')
  })
})
