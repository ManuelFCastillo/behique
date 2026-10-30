// Tests for the static file server: files, index, overrides, errors, methods.
//   node --test src/release/onboard/static-server.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { createStaticServer } from './static-server.mjs'

function start(dir, overrides) {
  const server = createStaticServer(dir, overrides)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function portOf(server) {
  return server.address().port
}

function rawRequest(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function get(port, path, method = 'GET') {
  return rawRequest(port, path, method)
}

describe('static server', () => {
  it('serves a file, a directory index, an override, 404, traversal, bad escapes, 405 and HEAD', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behique-static-'))
    writeFileSync(join(dir, 'hello.txt'), 'hi there')
    writeFileSync(join(dir, 'app.js'), 'console.log(1)')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'index.html'), '<h1>sub</h1>')
    const overrides = { '/env.js': 'window.MB_ENV="development";' }
    const server = await start(dir, overrides)
    const port = portOf(server)
    try {
      const base = `http://127.0.0.1:${port}`
      let r = await fetch(base + '/hello.txt')
      assert.equal(r.status, 200)
      assert.equal(await r.text(), 'hi there')
      assert.equal(r.headers.get('cache-control'), 'no-store')

      r = await fetch(base + '/sub')
      // directory without trailing slash still resolves to index.html
      // some setups redirect, ours serves directly
      assert.equal(r.status, 200)
      assert.match(await r.text(), /sub/)

      r = await fetch(base + '/env.js')
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('content-type'), 'application/javascript')
      assert.match(await r.text(), /MB_ENV/)

      r = await fetch(base + '/missing.txt')
      assert.equal(r.status, 404)

      r = await fetch(base + '/..%2f..%2fetc%2fpasswd')
      assert.equal(r.status, 403)

      const raw = await rawRequest(port, '/../x')
      assert.equal(raw.status, 403)

      const bad = await rawRequest(port, '/%E0%A4%A')
      assert.equal(bad.status, 400)

      const post = await get(port, '/hello.txt', 'POST')
      assert.equal(post.status, 405)

      const head = await get(port, '/hello.txt', 'HEAD')
      assert.equal(head.status, 200)
      assert.equal(head.body.length, 0)

      const q = await fetch(base + '/hello.txt?x=1')
      assert.equal(q.status, 200)
      assert.equal(await q.text(), 'hi there')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('returns a server that is not yet listening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behique-static2-'))
    const server = createStaticServer(dir)
    assert.equal(server.listening, false)
  })
})
