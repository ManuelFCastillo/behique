// The runner check-bench.mjs needs: start a node script, collect its output lines, stop it when it runs too long.
//   const runner = spawnRunner({ root }); await runner(['src/release/check-app.mjs', app, good, cand], { timeoutMs, env })
import { spawn } from 'node:child_process'

export function spawnRunner({ root, node = 'node' } = {}) {
  return (argv, { timeoutMs = 1_200_000, env = {} } = {}) => new Promise((resolve, reject) => {
    const child = spawn(node, argv, { cwd: root, env: { ...process.env, ...env } })
    const lines = []
    let timedOut = false
    // one line buffer per stream: a half line on stdout must not be glued to a half line on stderr
    const rest = { out: '', err: '' }
    const taker = key => d => { rest[key] += String(d); const parts = rest[key].split('\n'); rest[key] = parts.pop(); for (const l of parts) lines.push(l) }
    child.stdout.on('data', taker('out')); child.stderr.on('data', taker('err'))
    // a cancel makes check-app stop its builds (it handles SIGTERM); if it does not exit in 10 s it is killed
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10_000).unref() }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); for (const k of ['out', 'err']) if (rest[k]) lines.push(rest[k]); resolve({ code: code ?? 1, lines, timedOut }) })
  })
}
