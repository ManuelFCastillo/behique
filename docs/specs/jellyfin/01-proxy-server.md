---
part: jellyfin-proxy-server
owns:
  - src/release/onboard/proxy-server.mjs
  - src/release/onboard/proxy-server.test.mjs
context:
  - src/release/onboard/static-server.mjs
test: node --test src/release/onboard/proxy-server.test.mjs
allow: []
---
# Part 01: serve a built web client and proxy everything else to a sidecar

Some web clients, such as jellyfin-web, are a static bundle that must talk to a server on the same origin. In Behique's sandbox the browser reaches one port only, on the app container, and the server is a sidecar on an internal Docker network with the alias `jellyfin`. So the app container runs this small server.

## Interface

`src/release/onboard/proxy-server.mjs`, ESM, Node built-ins only plus `./static-server.mjs`.

Command line: `node proxy-server.mjs <dir> <port> <mount> <targetHost:targetPort>`, for example `node proxy-server.mjs /work/dist 8300 /web jellyfin:8096`. It listens on 0.0.0.0 and prints one line, `proxy-server on <port>`. The command line part runs only when the file is run directly, the way `static-server.mjs` checks it.

Export `createProxyServer({ dir, mount, target })`, returning an unstarted `http.Server`. `target` is `{ host, port }`. Export `parseTarget(text)`, which returns `{ host, port }` for `host:port` and throws on anything else, including a port outside 1 to 65535 or a value containing `/`.

## Behaviour

1. `GET` or `HEAD` of `/` answers 302 to `<mount>/`. So does `<mount>` without the slash. A query string on these is kept.
2. `GET` or `HEAD` of a path under `<mount>/` is served from `dir` by an internal `createStaticServer(dir)`: strip the mount from `req.url`, keeping the query, and call `staticServer.emit('request', req, res)`. Traversal protection is the static server's job; add a test that `/web/../../etc/passwd` sent raw does not leave `dir`.
3. Any other method under `<mount>/` answers 405.
4. Everything else is proxied to the target with `http.request`: same method, path with query, and headers, with `host` replaced by `<host>:<port>`. Add `x-forwarded-host` with the original host and `x-forwarded-proto: http`. Stream both bodies with `pipe`, never buffer them, since images and media can be large. The status code and headers come back unchanged, including several `set-cookie` values. Use `res.writeHead(status, upstream.rawHeaders)` or an equivalent that keeps repeated headers.
5. If the target cannot be reached, or fails before headers were sent, answer 502 with a short text body. If it fails after headers were sent, destroy the response. Never crash the process on a socket error from either side: attach error handlers on every stream and socket.
6. WebSocket upgrades on `server.on('upgrade')` for paths outside the mount: open a TCP connection to the target with `net.connect`, write the request line and the original headers from `req.rawHeaders` with `host` replaced, write any `head` bytes, then pipe both ways. On error destroy both sockets. An upgrade under the mount destroys the socket.
7. Requests to the target use a fresh connection (`agent: false`).

## Tests

`node:test`, no outside network: start a fake upstream `http.createServer` and the proxy on port 0 of 127.0.0.1, with a temp directory for `dir` holding `index.html` and `app.js`. Cover: 302 from `/` and from `/web` keeping the query; `/web/` serves index.html; `/web/app.js?v=1` serves the file with a JavaScript type; a missing file under the mount is 404 and does not reach upstream; POST under the mount is 405; `/Users/Public?x=1` reaches upstream with path and query intact and the `host` rewritten; POST body reaches upstream intact and the response status, a body of 1 MB and two `set-cookie` headers come back; a HEAD passes through; upstream down gives 502 and the server keeps answering; raw traversal stays inside `dir`; a WebSocket-style upgrade reaches a fake upstream that answers `101` and echoes bytes both ways, tested with `net.connect`; `parseTarget` accepts and rejects. Close every server and socket so the test process exits by itself.
