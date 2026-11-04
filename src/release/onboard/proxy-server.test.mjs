import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProxyServer, parseTarget } from './proxy-server.mjs'

function listen0(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, host, () => {
      resolve(server.address().port)
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    } catch {}
    server.close(() => resolve())
  })
}

function httpFetch(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { Connection: 'close', ...headers }, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks),
          })
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })
    let data = Buffer.alloc(0)
    sock.on('data', (c) => {
      data = Buffer.concat([data, c])
    })
    sock.on('close', () => resolve(data.toString('latin1')))
    sock.on('error', reject)
  })
}

test('proxy server behaviour', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-test-'))
  writeFileSync(join(dir, 'index.html'), '<h1>hello</h1>')
  writeFileSync(join(dir, 'app.js'), 'console.log(1)')

  const seen = []
  let upstreamHit = 0
  const upstreamSockets = new Set()
  const upstream = createServer((req, res) => {
    upstreamHit++
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        xfh: req.headers['x-forwarded-host'],
        xfp: req.headers['x-forwarded-proto'],
        body,
      })
      if (req.url === '/submit') {
        const big = Buffer.alloc(1024 * 1024, 'x')
        res.writeHead(201, [
          'Content-Type',
          'application/octet-stream',
          'Set-Cookie',
          'a=1',
          'Set-Cookie',
          'b=2',
        ])
        res.end(big)
        return
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'X-Head': 'yes' })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(`upstream:${req.method}:${req.url}`)
    })
  })
  upstream.on('connection', (sock) => {
    upstreamSockets.add(sock)
    sock.on('close', () => upstreamSockets.delete(sock))
  })
  upstream.on('upgrade', (req, socket, head) => {
    upstreamSockets.add(socket)
    socket.on('close', () => upstreamSockets.delete(socket))
    socket.on('error', () => {})
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
    )
    if (head && head.length) socket.write(head)
    socket.on('data', (c) => socket.write(c))
  })
  const upstreamPort = await listen0(upstream)

  const proxy = createProxyServer({
    dir,
    mount: '/web',
    target: { host: '127.0.0.1', port: upstreamPort },
  })
  const proxyPort = await listen0(proxy)

  // 302 from / and /web keeping query
  {
    const r = await httpFetch(proxyPort, '/?a=1')
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, '/web/?a=1')
  }
  {
    const r = await httpFetch(proxyPort, '/web?x=1')
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, '/web/?x=1')
  }
  {
    const r = await httpFetch(proxyPort, '/')
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, '/web/')
  }

  // /web/ serves index
  {
    const r = await httpFetch(proxyPort, '/web/')
    assert.equal(r.status, 200)
    assert.match(r.body.toString(), /hello/)
  }

  // /web/app.js?v=1 js type
  {
    const r = await httpFetch(proxyPort, '/web/app.js?v=1')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /javascript/)
    assert.match(r.body.toString(), /console/)
  }

  // missing file under mount is 404 and does not reach upstream
  {
    upstreamHit = 0
    const r = await httpFetch(proxyPort, '/web/nope.js')
    assert.equal(r.status, 404)
    assert.equal(upstreamHit, 0)
  }

  // POST under mount is 405
  {
    const r = await httpFetch(proxyPort, '/web/', { method: 'POST' })
    assert.equal(r.status, 405)
  }

  // /Users/Public?x=1 reaches upstream with path/query and host rewritten
  {
    seen.length = 0
    const r = await httpFetch(proxyPort, '/Users/Public?x=1')
    assert.equal(r.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/Users/Public?x=1')
    assert.equal(seen[0].host, `127.0.0.1:${upstreamPort}`)
    assert.ok(seen[0].xfh)
    assert.equal(seen[0].xfp, 'http')
  }

  // POST body intact, status, 1MB body, two set-cookie
  {
    const payload = Buffer.from('hello-body-123')
    const r = await httpFetch(proxyPort, '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': String(payload.length) },
      body: payload,
    })
    assert.equal(r.status, 201)
    assert.equal(r.body.length, 1024 * 1024)
    const last = seen[seen.length - 1]
    assert.deepEqual(last.body, payload)
    const cookies = r.headers['set-cookie']
    assert.ok(Array.isArray(cookies))
    assert.equal(cookies.length, 2)
  }

  // HEAD passes through
  {
    const r = await httpFetch(proxyPort, '/head-me', { method: 'HEAD' })
    assert.equal(r.status, 200)
    assert.equal(r.headers['x-head'], 'yes')
    assert.equal(r.body.length, 0)
  }

  // raw traversal stays inside dir
  {
    const raw = await rawGet(proxyPort, '/web/../../etc/passwd')
    const statusLine = raw.split('\r\n')[0]
    assert.match(statusLine, /40[34]/)
    assert.doesNotMatch(raw, /root:/)
  }

  // WebSocket-style upgrade reaches upstream and echoes both ways
  {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { sock.destroy() } catch {}
        reject(new Error('upgrade timeout'))
      }, 5000)
      const sock = netConnect(proxyPort, '127.0.0.1', () => {
        sock.write(
          'GET /chat HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\n\r\n'
        )
      })
      let buf = Buffer.alloc(0)
      let got101 = false
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c])
        if (!got101 && buf.includes('101')) {
          got101 = true
          sock.write('ping-bytes')
        } else if (got101 && buf.includes('ping-bytes')) {
          clearTimeout(timer)
          sock.destroy()
        }
      })
      sock.on('close', () => {
        clearTimeout(timer)
        if (got101 && buf.includes('ping-bytes')) resolve()
        else reject(new Error('upgrade echo failed: ' + buf.toString('latin1').slice(0, 200)))
      })
      sock.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  // parseTarget accepts and rejects
  {
    assert.deepEqual(parseTarget('jellyfin:8096'), { host: 'jellyfin', port: 8096 })
    assert.deepEqual(parseTarget('a:1'), { host: 'a', port: 1 })
    assert.deepEqual(parseTarget('a:65535'), { host: 'a', port: 65535 })
    assert.throws(() => parseTarget('a:0'))
    assert.throws(() => parseTarget('a:65536'))
    assert.throws(() => parseTarget('a:abc'))
    assert.throws(() => parseTarget('a/b:80'))
    assert.throws(() => parseTarget('noport'))
    assert.throws(() => parseTarget(':80'))
    assert.throws(() => parseTarget('h:80/extra'))
    assert.throws(() => parseTarget(''))
  }

  // upstream down gives 502 and server keeps answering
  {
    for (const s of [...upstreamSockets]) {
      try { s.destroy() } catch {}
    }
    await closeServer(upstream)
    const r = await httpFetch(proxyPort, '/Users/Public?x=1')
    assert.equal(r.status, 502)
    const r2 = await httpFetch(proxyPort, '/web/')
    assert.equal(r2.status, 200)
  }

  await closeServer(proxy)
})
