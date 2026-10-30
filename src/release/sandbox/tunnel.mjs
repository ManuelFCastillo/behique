// Make a container's address reachable at 127.0.0.1:<port> on this machine, so nothing else in Behique has to know where the app runs.
//   forwardLocal: this machine reaches the container directly (OrbStack): a small TCP forwarder.
//   sshTunnel: the container is on another machine: `ssh -L` to that machine's address for the container.
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/

export function forwardLocal({ listenPort, host, port }) {
  if (!IPV4.test(host)) return Promise.reject(new Error('The app address is not an IPv4 address.'))
  return new Promise((resolve, reject) => {
    const sockets = new Set()
    const srv = createServer(client => {
      const up = connect(port, host)
      sockets.add(client); sockets.add(up)
      const drop = () => { client.destroy(); up.destroy(); sockets.delete(client); sockets.delete(up) }
      client.on('error', drop); up.on('error', drop); client.on('close', drop); up.on('close', drop)
      client.pipe(up); up.pipe(client)
    })
    srv.once('error', reject)
    srv.listen(listenPort, '127.0.0.1', () => resolve({ close: async () => { for (const s of sockets) s.destroy(); await new Promise(r => srv.close(r)) } }))
  })
}

export function sshTunnel({ sshHost, listenPort, host, port, spawnFn = spawn, waitMs = 8000 }) {
  if (!HOST.test(sshHost)) return Promise.reject(new Error('Not a valid ssh host name.'))
  if (!IPV4.test(host)) return Promise.reject(new Error('The app address is not an IPv4 address.'))
  // a connection of its own (no ControlMaster): a multiplexed client hands the forward to the shared master and exits, so it could never be closed
  const args = ['-N', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-L', `127.0.0.1:${listenPort}:${host}:${port}`, sshHost]
  const child = spawnFn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr?.on('data', d => { err = (err + d).slice(-500) })
  return new Promise((resolve, reject) => {
    let exited = false
    child.on('exit', () => { exited = true })
    child.on('error', reject)
    const t0 = Date.now()
    const check = () => {
      if (exited) { reject(new Error(`The ssh tunnel stopped: ${err.trim().split('\n')[0] || 'no message'}`)); return }
      const s = connect(listenPort, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve({ close: async () => { try { child.kill() } catch {} } }) })
      s.once('error', () => { s.destroy(); if (Date.now() - t0 > waitMs) { try { child.kill() } catch {} reject(new Error('The ssh tunnel did not open in time.')) } else setTimeout(check, 150) })
    }
    check()
  })
}
