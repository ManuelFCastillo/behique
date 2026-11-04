// Read-only recording and tests: the steps of a crawled flow must see the app exactly as it was seeded.
//   node --test src/release/readonly.test.mjs
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { specSource } from '../export.mjs'
import { recordRun } from './facts.mjs'

const finding = (extra = {}) => ({ id: 'R1', title: 't', expected: 'a', actual: 'b', start: '/', history: [{ type: 'click', selector: '#go' }], assert: { kind: 'attr', selector: 'css=#go', name: 'title', op: 'equals', value: 'x' }, ...extra })

describe('the exported test', () => {
  it('blocks every request but GET and HEAD, before the page loads, when the finding is read-only', () => {
    const src = specSource(finding({ readOnly: true }))
    assert.match(src, /page\.route\('\*\*\/\*'/)
    assert.ok(src.indexOf("page.route('**/*'") < src.indexOf('page.goto('), 'blocked before the first load')
  })
  it('refuses other hosts for an ordinary finding too, without the method rule', () => {
    const src = specSource(finding())
    assert.match(src, /page\.route\('\*\*\/\*'/)
    assert.ok(src.indexOf("page.route('**/*'") < src.indexOf('page.goto('), 'refused before the first load')
    assert.ok(!src.includes('loginWrites'))
  })
})

describe('recordRun', () => {
  let srv, base; const seen = []
  before(async () => {
    srv = createServer((req, res) => {
      seen.push(req.method + ' ' + req.url)
      if (req.url === '/save' || req.method !== 'GET') { res.writeHead(200); return res.end('saved') }
      if (req.url.startsWith('/page')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<title>x</title><p id="c"></p><script>document.getElementById("c").textContent=localStorage.getItem("k")?"again":"first";localStorage.setItem("k","1")</script>') }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<button id="go" onclick="fetch(\'/save\',{method:\'POST\'}).then(()=>{document.title=\'saved\'}).catch(()=>{document.title=\'blocked\'})">Go</button>')
    })
    await new Promise(r => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`
  })
  after(() => srv.close())

  it('lets a click that would save something go through by default', async () => {
    seen.length = 0
    await recordRun(base, [{ type: 'click', selector: '#go' }])
    assert.ok(seen.includes('POST /save'))
  })
  it('stops it in read-only mode, and the page carries on', async () => {
    seen.length = 0
    const steps = await recordRun(base, [{ type: 'click', selector: '#go' }], { readOnly: true })
    assert.ok(!seen.some(s => s.startsWith('POST')), seen.join(', '))
    assert.equal(steps.length, 2)
  })
  it('a step that cannot be performed is recorded as a fact instead of stopping the run', async () => {
    const steps = await recordRun(base, [{ type: 'click', selector: '#nope', timeout: 300 }, { type: 'click', selector: '#go' }], { readOnly: true })
    assert.equal(steps.length, 3)
    assert.match(steps[1].facts['step@error'], /.+/)
    assert.equal(steps[2].facts['step@error'], undefined)
  })

  it('starts a new flow with no cookies and no storage left by the one before', async () => {
    const steps = await recordRun(base + '/page', [{ type: 'click', selector: '#c' }, { type: 'goto', path: '/' }, { type: 'click', selector: '#c' }], { readOnly: true })
    const text = i => steps[i].facts['body/p[1]#text']
    assert.equal(text(0), 'first')
    assert.equal(text(2), 'first', 'after the flow boundary the page is opened with empty storage')
    const without = await recordRun(base + '/page', [{ type: 'click', selector: '#c' }, { type: 'reload' }], { readOnly: true })
    assert.equal(without[2].facts['body/p[1]#text'], 'again', 'a reload inside a flow keeps it (the test would show the difference)')
  })
})
