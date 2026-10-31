// node --test src/export.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { specSource } from './export.mjs'

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
