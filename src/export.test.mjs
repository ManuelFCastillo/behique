// node --test src/export.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRun, runnerArgs, specSource, writeExport } from './export.mjs'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGIN = 'http://127.0.0.1:8300'
const finding = (value, extra = {}) => ({
  id: 'R4', title: 't', expected: value, actual: 'other', start: '/', origin: ORIGIN,
  history: [{ type: 'click', selector: '.a' }],
  assert: { kind: 'attr', selector: 'xpath=/html/body/iframe[2]', name: 'src', op: 'contains', value },
  ...extra
})
// what the generated expected-value expression evaluates to when the test runs on `live`
const evaluate = (src, live) => {
  const m = src.match(/toContain\((.+)\)\n/)
  assert.ok(m, 'an expected-value expression is present')
  return new Function('live', 'return ' + m[1])(live)
}

test('an expected value that embeds the recording origin is compared against the live origin, plain and URL-encoded', () => {
  const value = `https://platform.twitter.com/widgets/tweet_button.html#original_referer=${encodeURIComponent(ORIGIN + '/')}&text=TodoMVC`
  const src = specSource(finding(value))
  assert.ok(src.includes('const live = new URL(page.url()).origin'))
  assert.ok(src.indexOf('const live') < src.indexOf('toContain('), 'live is defined before the assertion')
  assert.equal(evaluate(src, 'http://127.0.0.1:8302'), value.replace('8300', '8302'))
  assert.equal(evaluate(src, ORIGIN), value, 'on the recording port the value is unchanged')
  const plain = specSource(finding(`${ORIGIN}/share/abc`, { assert: { kind: 'text', selector: 'xpath=/html/body/a', op: 'contains', value: `${ORIGIN}/share/abc` } }))
  assert.equal(evaluate(plain, 'http://10.0.0.5:9000'), 'http://10.0.0.5:9000/share/abc')
})

test('values without the origin, findings without one, and patterns are written as recorded', () => {
  const same = specSource(finding('https://example.com/widget?x=1'))
  assert.ok(!same.includes('const live'))
  assert.ok(same.includes('toContain("https://example.com/widget?x=1")'))
  const noOrigin = specSource({ ...finding(`${ORIGIN}/x`), origin: undefined })
  assert.ok(!noOrigin.includes('const live'))
  assert.ok(specSource({ ...finding(`${ORIGIN}/x`), origin: 'not a url' }).includes(`toContain("${ORIGIN}/x")`))
  const pattern = specSource(finding(`${ORIGIN}/x`, { assert: { kind: 'attr', selector: 'xpath=/html/body', name: 'href', op: 'matches', value: `${ORIGIN}/x` } }))
  assert.ok(!pattern.includes('const live'))
  assert.ok(pattern.includes(`toMatch(new RegExp("${ORIGIN}/x"))`))
})

test('a class list is compared sorted, and a scroll area is asked whether it can scroll', () => {
  const cls = specSource(finding('a b', { assert: { kind: 'class_list', selector: 'xpath=/html/body/main[1]', op: 'equals', value: '!overflow-auto flex' } }))
  assert.ok(cls.includes(".split(/\\s+/).filter(Boolean))].sort().join(' '))"), 'the live class list is sorted like the recorded one')
  assert.ok(cls.includes('expect(String(classes)).toBe("!overflow-auto flex")'))
  const sc = specSource(finding('y', { assert: { kind: 'scrolls', selector: 'xpath=/html/body/main[1]' } }))
  assert.ok(sc.includes("e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)"))
  assert.ok(sc.includes('page.mouse.wheel(0, 240)'), 'the test turns the wheel over the area first, so a recording shows the attempt')
  assert.ok(sc.includes('expect(scrolls || moved).toBe(true)'), 'a toBe failure, which the bisect reads as bad')
  assert.ok(sc.includes("const recording = process.env.BEHIQUE_VIDEO === '1'") && sc.includes("__bq_wheel") && sc.includes("head: 'Mouse wheel'") && sc.includes("moved ? 'It scrolled' : 'It did not move'"), 'when recording, the page is marked before the wheel turns and again with what happened')
  assert.ok(sc.indexOf("head: 'Mouse wheel'") < sc.indexOf('page.mouse.wheel(0, 240)') && sc.indexOf('page.mouse.wheel(0, 240)') < sc.indexOf("'It scrolled'"), 'mark, wheel, verdict, in that order')
  new Function(sc.replace(/^import .*$/mg, '').replace(/\btest\(/, '(function(a,b){})(')) // the generated file parses
})

test('a test settles like the recorder before it checks, and holds the judged state when a recording is on', () => {
  const src = specSource(finding('a', { assert: { kind: 'text', selector: 'xpath=/html/body/p[1]', op: 'equals', value: 'a' } }))
  const body = src.split('\n')
  const settle = body.findIndex(l => l.includes("waitForLoadState('networkidle', { timeout: 5000 })")), check = body.findIndex(l => l.includes('toBe("a")'))
  assert.ok(settle > 0 && settle < check, 'network idle (bounded) comes before the check')
  assert.ok(body.some(l => l.includes("if (process.env.BEHIQUE_VIDEO === '1') await page.waitForTimeout(1500)")), 'the hold is only when recording')
  assert.ok(body.findIndex(l => l.trim() === '} finally {') > check, 'the hold runs after the check whether it passed or failed')
  const api = specSource(finding('', { assert: { kind: 'api', steps: [{ path: '/api/x', method: 'GET' }], status: 200 } }))
  assert.ok(!api.includes('networkidle'), 'an api check does not wait for the page')
})

test('runs can be recorded: a folder of their own per run, the video flag for the config, and the recording path read back from the report', () => {
  const plain = runnerArgs('/tmp/x', 'http://127.0.0.1:1', { only: 'R1' })
  assert.deepEqual(plain.args, ['test', 'R1.spec.js']); assert.equal(plain.output, null); assert.equal(plain.env.BEHIQUE_VIDEO, undefined)
  const rec = runnerArgs('/tmp/x', 'http://127.0.0.1:1', { only: 'R1', video: true })
  assert.equal(rec.env.BEHIQUE_VIDEO, '1'); assert.equal(rec.env.BASE_URL, 'http://127.0.0.1:1')
  assert.match(rec.output, /^\/tmp\/x\/test-results\/R1-[a-z0-9]+-[a-z0-9]+$/)
  assert.deepEqual(rec.args.slice(0, 3), ['test', 'R1.spec.js', '--output']); assert.equal(rec.args[3], rec.output)
  assert.notEqual(runnerArgs('/tmp/x', 'http://127.0.0.1:1', { only: 'R1', video: true }).output, rec.output, 'two runs in flight never share a folder')
  const report = { suites: [{ specs: [{ file: 'R1.spec.js', ok: false, tests: [{ results: [{ error: { message: 'expect(x).toBe(true)' }, attachments: [{ name: 'video', contentType: 'video/webm', path: '/tmp/x/test-results/R1-a-b/video.webm' }] }] }] }, { file: 'R2.spec.js', ok: true, tests: [{ results: [{ attachments: [] }] }] }] }] }
  const r = parseRun({ stdout: JSON.stringify(report), stderr: '' })
  assert.deepEqual(r.results, { R1: false, R2: true })
  assert.deepEqual(r.videos, { R1: '/tmp/x/test-results/R1-a-b/video.webm' })
  const dir = mkdtempSync(join(tmpdir(), 'exp-')); writeExport(dir, [])
  assert.ok(readFileSync(join(dir, 'playwright.config.js'), 'utf8').includes("video: process.env.BEHIQUE_VIDEO === '1' ? 'on' : 'off'"), 'recording is off unless Behique asks for it')
})
