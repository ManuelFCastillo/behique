// Serves the canvas fixture. PORT from the environment; no state, no API.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p !== '/' && p !== '/index.html') { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(fs.readFileSync(path.join(__dirname, 'index.html')))
}).listen(Number(process.env.PORT || 0), '127.0.0.1')
