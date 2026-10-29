// node --test src/release/scenarios.test.mjs   (offline: no build is started and no model is called)
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { specSource } from '../export.mjs'
import { SCENARIOS } from './scenarios.mjs'

test('every scenario points at an adapter and a steps file that exist and are usable', async () => {
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    assert.ok(existsSync(sc.steps), `${name}: steps file`)
    const steps = JSON.parse(readFileSync(sc.steps, 'utf8'))
    assert.ok(Array.isArray(steps) && steps.length >= 2, `${name}: has steps`)
    const a = (await import(`./adapters/${sc.adapter}.mjs`)).default
    assert.equal(a.name, sc.adapter); assert.ok(existsSync(a.feed.dir + '/feed.xml'), `${name}: feed fixture`)
    assert.ok(sc.about.length > 40 && sc.upstream.url.includes(String(sc.upstream.issue)), `${name}: honest description with its upstream issue`)
  }
})

test('the scroll scenario says plainly that it is not a confirmed bug', () => {
  assert.match(SCENARIOS.scroll.about, /could not reproduce/); assert.match(SCENARIOS.scroll.about, /for a person to decide/)
})

test('a scroll test measures the page before and after the LAST action and uses no absolute position', () => {
  const src = specSource({ id: 'R1', title: 't', expected: 'e', actual: 'a', start: '/i/',
    history: [{ type: 'click', selector: '.a' }, { type: 'scroll', selector: '.b' }, { type: 'click', selector: '.c' }],
    assert: { kind: 'scroll_delta', value: 0 } })
  const at = s => src.indexOf(s)
  assert.ok(at('.a') < at('.b') && at('.b') < at('const before') && at('const before') < at('".c"') && at('".c"') < at('const after'), 'order: earlier steps, measure, last action, measure')
  assert.match(src, /expect\(after - before\)\.toBe\(0\)/); assert.match(src, /scrollIntoView/)
})

test('other tests are generated exactly as before (no scroll code)', () => {
  const src = specSource({ id: 'R1', title: 't', expected: 'e', actual: 'a', history: [{ type: 'click', selector: '.a' }], assert: { kind: 'attr', selector: 'xpath=/html/body', name: 'x', op: 'equals', value: 'v' } })
  assert.ok(!src.includes('readScroll')); assert.match(src, /getAttribute\("x"\)/)
})
