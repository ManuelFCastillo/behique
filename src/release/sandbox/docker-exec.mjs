// The one place that starts the `docker` program for a sandbox: an argument array, no shell, an optional stdin buffer, a timeout.
// Where docker runs is decided by DOCKER_HOST only: unset means the local engine (OrbStack on a Mac), `ssh://hardac2` means that machine.
import { spawn } from 'node:child_process'

/** `target` is '' or 'local' (the local engine) or an ssh://, unix:// or tcp:// address. Anything else is refused. */
export function dockerHostFor(target) {
  if (target === undefined || target === null || target === '' || target === 'local') return null
  if (typeof target === 'string' && /^(ssh|unix|tcp):\/\/[A-Za-z0-9@._:\/-]{1,200}$/.test(target)) return target
  throw new Error(`Unknown docker target: ${String(target).slice(0, 60)}`)
}

export function makeDocker({ target, spawnFn = spawn, bin = 'docker', baseEnv = process.env } = {}) {
  const host = dockerHostFor(target)
  const env = { ...baseEnv }
  if (host) env.DOCKER_HOST = host
  else delete env.DOCKER_HOST
  return function docker(args, { input, timeoutMs = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) { reject(new Error('docker arguments must be an array of strings')); return }
      const child = spawnFn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', err = '', done = false
      const finish = fn => { if (done) return; done = true; clearTimeout(timer); fn() }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish(() => reject(new Error(`docker ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`))) }, timeoutMs)
      child.stdout.on('data', d => { out = (out + d).slice(-200_000) })
      child.stderr.on('data', d => { err = (err + d).slice(-200_000) })
      child.on('error', e => finish(() => reject(e)))
      child.on('close', code => finish(() => resolve({ code: code ?? 1, stdout: out, stderr: err })))
      child.stdin.on('error', () => {}) // a container that exits before reading everything closes the pipe
      if (input !== undefined) child.stdin.end(input); else child.stdin.end()
    })
  }
}
