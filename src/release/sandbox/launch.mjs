// Runs INSIDE the sandbox container: start the app, and make a server that listens only on localhost reachable from outside the container.
//   node /work/.behique/launch.mjs <port> -- <command> [args...]
// Many dev servers (vite, vitepress, webpack) bind 127.0.0.1 and ignore HOST. This relays <container address>:<port> to the app's own localhost port.
// If the app already listens on every address the relay cannot bind and quietly does nothing. The command is run with its argument array: no shell.
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { networkInterfaces } from 'node:os'

const [portText, dashes, ...cmd] = process.argv.slice(2)
const port = Number(portText)
if (!Number.isInteger(port) || port < 1 || port > 65535 || dashes !== '--' || cmd.length === 0) {
  console.error('usage: node launch.mjs <port> -- <command> [args...]')
  process.exit(2)
}

const address = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
if (address) {
  const relay = createServer(client => {
    // the app may listen on 127.0.0.1 or on ::1 (node resolves "localhost" either way): try both
    const tryTo = host => {
      const up = connect({ host, port })
      up.once('connect', () => { client.pipe(up); up.pipe(client) })
      up.once('error', () => { if (host === '127.0.0.1') tryTo('::1'); else client.destroy() })
      client.on('error', () => up.destroy()); client.on('close', () => up.destroy()); up.on('close', () => client.destroy())
    }
    tryTo('127.0.0.1')
  })
  relay.on('error', () => {}) // EADDRINUSE: the app listens on every address already
  relay.listen(port, address)
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' })
child.on('error', e => { console.error(`could not start ${cmd[0]}: ${e.message}`); process.exit(127) })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
