// Static file server for apps that need no build: serves a checkout as plain files with optional overrides.
//   node src/release/onboard/static-server.mjs <dir> <port> [overridesJson]
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
}

export function contentTypeFor(path) {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function createStaticServer(dir, overrides = {}) {
  const root = resolve(dir)
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const raw = (req.url ?? '/').split('?')[0]
    let path
    try {
      path = decodeURIComponent(raw)
    } catch {
      res.writeHead(400, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    if (Object.prototype.hasOwnProperty.call(overrides, path)) {
      const body = overrides[path]
      const headers = { 'Content-Type': contentTypeFor(path), 'Cache-Control': 'no-store' }
      res.writeHead(200, headers)
      if (req.method === 'GET') res.end(body)
      else res.end()
      return
    }
    const rel = path.startsWith('/') ? path.slice(1) : path
    const joined = join(root, rel)
    const normalized = normalize(joined)
    if (normalized !== root && !normalized.startsWith(root + sep)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    let file = normalized
    try {
      const st = statSync(file)
      if (st.isDirectory()) file = join(file, 'index.html')
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    if (!existsSync(file)) {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    let st
    try {
      st = statSync(file)
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    if (!st.isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    // A resolved path that escaped via symlink or odd join still must stay inside root plus index case
    const resolved = resolve(file)
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    let body
    try {
      body = readFileSync(file)
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': contentTypeFor(file), 'Cache-Control': 'no-store' })
    if (req.method === 'GET') res.end(body)
    else res.end()
  })
  return server
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = process.argv[2]
  const port = Number(process.argv[3])
  if (!dir || !Number.isInteger(port)) {
    console.error('usage: node static-server.mjs <dir> <port> [overridesJson]')
    process.exit(2)
  }
  let overrides = {}
  if (process.argv[4]) overrides = JSON.parse(process.argv[4])
  const server = createStaticServer(dir, overrides)
  server.listen(port, '127.0.0.1')
}
