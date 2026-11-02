// Tests for the crawler against a local fixture server. No network or model.
// Run with: node --test src/release/crawl/run.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Session } from '../../session.mjs'
import { crawlApp } from './run.mjs'

const seen = []
let deleted = false

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`

const indexHtml = () => page('Home', `
<h1>Home</h1>
<nav><a href="/about">About</a><a href="/products">Products</a></nav>
<button id="menu">Menu</button><span id="holder"></span>
<script>
document.getElementById('menu').addEventListener('click', () => {
  if (!document.getElementById('settings-link')) {
    const a = document.createElement('a')
    a.href = '/settings'
    a.id = 'settings-link'
    a.textContent = 'Settings'
    document.getElementById('holder').appendChild(a)
  }
})
</script>
<button id="del">Delete all</button>
<script>
document.getElementById('del').addEventListener('click', () => { fetch('/api/delete', { method: 'POST' }) })
</script>
<a href="http://example.invalid/">Docs</a>
<a href="mailto:someone@example.com">Email us</a>
`)

const aboutHtml = () => page('About', `<h1>About</h1><a href="/">Home</a>`)
const settingsHtml = () => page('Settings', `<h1>Settings</h1><a href="/">Home</a>`)
const productsHtml = () => page('Products', `
<h1>Products</h1>
<div role="tab" tabindex="0">Red</div><div role="tab" tabindex="0">Green</div><div role="tab" tabindex="0">Blue</div>
<p id="out">Pick a color</p>
<script>
for (const t of document.querySelectorAll('[role="tab"]')) {
  t.addEventListener('click', () => {
    document.getElementById('out').textContent = t.textContent + ' selected'
    try { history.pushState({}, '', '?tab=' + t.textContent.trim().toLowerCase()) } catch {}
  })
}
</script>
<a href="/">Home</a>
`)

const server = http.createServer((req, res) => {
  seen.push({ method: req.method, path: req.url.split('?')[0] })
  if (req.url.startsWith('/api/delete')) {
    if (req.method === 'POST') deleted = true
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  let html = null
  if (req.url === '/' || req.url.startsWith('/?')) html = indexHtml()
  else if (req.url.startsWith('/about')) html = aboutHtml()
  else if (req.url.startsWith('/settings')) html = settingsHtml()
  else if (req.url.startsWith('/products')) html = productsHtml()
  else { res.writeHead(404); res.end('no'); return }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(html)
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
after(() => server.close())

const selText = s => JSON.stringify(s).toLowerCase()

test('crawls safely and finds flows', async () => {
  const r = await crawlApp(base, { maxDepth: 2, maxPaths: 40, log: () => {} })
  const blob = selText(r.steps)
  assert.match(blob, /about/)
  assert.match(blob, /products/)
  assert.match(blob, /menu/)
  assert.match(blob, /settings/)
  assert.match(blob, /red|green|blue/)
  assert.ok(!blob.includes('delete all'), 'never clicks Delete all')
  assert.ok(!blob.includes('docs'), 'never clicks Docs')
  assert.ok(!blob.includes('email us'), 'never clicks mailto')
  assert.equal(deleted, false)
  for (const e of seen) assert.ok(['GET', 'HEAD'].includes(e.method), `only GET/HEAD, saw ${e.method}`)
  assert.ok(r.states.length >= 5)
  assert.equal(new Set(r.states.map(s => s.key)).size, r.states.length)
  const s = new Session(base, { viewport: { width: 1280, height: 900 } })
  try {
    await s.open()
    for (const a of r.steps) await s.act(a)
  } finally { await s.close() }
  const r2 = await crawlApp(base, { maxDepth: 2, maxPaths: 40, log: () => {} })
  assert.deepEqual(r2.steps, r.steps)
  let prev = null
  let sawGoto = false
  for (const st of r.steps) {
    if (st.type === 'goto') {
      if (prev && prev.type === 'goto') assert.notEqual(prev.path, st.path, 'never the same load twice in a row') // two direct loads of different pages may follow each other
      sawGoto = true
    }
    prev = st
  }
  if (r.flows.length > 1) assert.ok(sawGoto, 'has a goto between flows')
  // Every page the clicks reached is also loaded directly, once, after the click flows.
  const direct = r.flows.filter(f => f.direct)
  assert.ok(direct.length >= 1, 'has direct loads')
  assert.ok(direct.every(f => f.path.length === 1 && f.path[0].type === 'goto' && f.path[0].path !== '/'))
  assert.equal(new Set(direct.map(f => f.path[0].path)).size, direct.length, 'each page loaded directly once')
  assert.ok(r.flows.findIndex(f => f.direct) > r.flows.findLastIndex(f => !f.direct))
})

test('maxPaths stops early', async () => {
  const r = await crawlApp(base, { maxDepth: 2, maxPaths: 3, log: () => {} })
  assert.equal(r.stoppedBy, 'paths')
  assert.ok(r.stats.tried <= 3)
})

test('budget stops without throwing', async () => {
  const r = await crawlApp(base, { budgetMs: 1, log: () => {} })
  assert.equal(r.stoppedBy, 'budget')
})

test('disappearing element counts as failed', async () => {
  let n = 0
  const srv = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      n += 1
      const html = n === 1
        ? page('T', `<h1>T</h1><button id="gone">Gone</button>`)
        : page('T', `<h1>T</h1>`)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(html)
      return
    }
    res.writeHead(404); res.end('no')
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  try {
    const b = `http://127.0.0.1:${srv.address().port}`
    const r = await crawlApp(b, { maxDepth: 1, maxPaths: 10, log: () => {} })
    assert.ok(r.stats.failed >= 1, `expected a failed path, got ${JSON.stringify(r.stats)}`)
    assert.ok(r.stoppedBy === 'done' || r.stoppedBy === 'paths')
  } finally { srv.close() }
})
