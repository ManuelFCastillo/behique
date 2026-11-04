import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { pathToFileURL } from 'node:url'
import { createStaticServer } from './static-server.mjs'

export function parseTarget(text) {
  if (typeof text !== 'string') throw new Error('bad target')
  if (text.includes('/')) throw new Error('bad target')
  const idx = text.lastIndexOf(':')
  if (idx <= 0 || idx === text.length - 1) throw new Error('bad target')
  const host = text.slice(0, idx)
  const portText = text.slice(idx + 1)
  if (!host || host.includes(':')) throw new Error('bad target')
  if (!/^\d+$/.test(portText)) throw new Error('bad target')
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad target')
  return { host, port }
}

function normalizeMount(mount) {
  let m = String(mount ?? '')
  if (!m.startsWith('/')) m = '/' + m
  if (m.length > 1 && m.endsWith('/')) m = m.slice(0, -1)
  return m
}

function splitUrl(url) {
  const u = url ?? '/'
  const q = u.indexOf('?')
  if (q === -1) return { path: u, query: '' }
  return { path: u.slice(0, q), query: u.slice(q) }
}

export function createProxyServer({ dir, mount, target }) {
  const mountPath = normalizeMount(mount)
  const staticServer = createStaticServer(dir)
  const server = createServer((req, res) => {
    req.on('error', () => {
      try { res.destroy() } catch {}
    })
    res.on('error', () => {})
    const { path, query } = splitUrl(req.url ?? '/')
    const method = req.method ?? 'GET'

    if ((path === '/' || path === mountPath) && (method === 'GET' || method === 'HEAD')) {
      const location = mountPath + '/' + query
      res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
      res.end()
      return
    }

    const underMount = path === mountPath + '/' || path.startsWith(mountPath + '/')
    if (underMount) {
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      const stripped = path.slice(mountPath.length) + query
      req.url = stripped === '' ? '/' + query : stripped
      staticServer.emit('request', req, res)
      return
    }

    proxyHttp(req, res, target)
  })

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    const { path } = splitUrl(req.url ?? '/')
    const underMount = path === mountPath || path.startsWith(mountPath + '/')
    if (underMount) {
      try { socket.destroy() } catch {}
      return
    }
    let upstream
    try {
      upstream = netConnect(target.port, target.host)
    } catch {
      try { socket.destroy() } catch {}
      return
    }
    upstream.on('error', () => {
      try { socket.destroy() } catch {}
      try { upstream.destroy() } catch {}
    })
    socket.on('error', () => {
      try { upstream.destroy() } catch {}
    })
    socket.on('close', () => {
      try { upstream.destroy() } catch {}
    })
    upstream.on('close', () => {
      try { socket.destroy() } catch {}
    })
    upstream.on('connect', () => {
      const lines = []
      lines.push(`${req.method} ${req.url} HTTP/${req.httpVersion}`)
      const raw = req.rawHeaders ?? []
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const key = raw[i]
        let value = raw[i + 1]
        if (String(key).toLowerCase() === 'host') {
          value = `${target.host}:${target.port}`
        }
        lines.push(`${key}: ${value}`)
      }
      try {
        upstream.write(lines.join('\r\n') + '\r\n\r\n')
        if (head && head.length) upstream.write(head)
      } catch {
        try { socket.destroy() } catch {}
        try { upstream.destroy() } catch {}
        return
      }
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
  })

  server.on('clientError', (err, socket) => {
    try { socket.destroy() } catch {}
  })

  return server
}

function proxyHttp(req, res, target) {
  const originalHost = (req.headers && req.headers.host) || ''
  const headers = { ...req.headers }
  headers.host = `${target.host}:${target.port}`
  headers['x-forwarded-host'] = originalHost
  headers['x-forwarded-proto'] = 'http'

  let upstreamReq
  try {
    upstreamReq = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers,
        agent: false,
      },
      (upstreamRes) => {
        upstreamRes.on('error', () => {
          if (!res.headersSent) {
            try {
              res.writeHead(502, { 'Content-Type': 'text/plain' })
              res.end('bad gateway')
            } catch {}
          } else {
            try { res.destroy() } catch {}
          }
        })
        try {
          const raw = upstreamRes.rawHeaders
          if (Array.isArray(raw)) {
            res.writeHead(upstreamRes.statusCode, raw)
          } else {
            res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
          }
        } catch {
          try { res.destroy() } catch {}
          try { upstreamRes.destroy() } catch {}
          return
        }
        upstreamRes.pipe(res)
      }
    )
  } catch {
    if (!res.headersSent) {
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end('bad gateway')
      } catch {}
    }
    return
  }
  upstreamReq.on('error', () => {
    if (!res.headersSent) {
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end('bad gateway')
      } catch {}
    } else {
      try { res.destroy() } catch {}
    }
  })
  req.on('error', () => {
    try { upstreamReq.destroy() } catch {}
  })
  res.on('error', () => {
    try { upstreamReq.destroy() } catch {}
  })
  try {
    req.pipe(upstreamReq)
  } catch {
    try { upstreamReq.destroy() } catch {}
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = process.argv[2]
  const port = Number(process.argv[3])
  const mount = process.argv[4]
  const targetText = process.argv[5]
  if (!dir || !Number.isInteger(port) || !mount || !targetText) {
    console.error('usage: node proxy-server.mjs <dir> <port> <mount> <targetHost:targetPort>')
    process.exit(2)
  }
  let target
  try {
    target = parseTarget(targetText)
  } catch {
    console.error('bad target')
    process.exit(2)
  }
  const server = createProxyServer({ dir, mount, target })
  server.listen(port, '0.0.0.0', () => {
    console.log(`proxy-server on ${port}`)
  })
}
