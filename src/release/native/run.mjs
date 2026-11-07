// Build a checkout and run one case of a command profile into a fresh folder. No shell is used anywhere: every command
// is an argument list passed straight to the operating system.
//   node --test src/release/native/run.test.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { expand } from './profile.mjs'

const MAX_STREAM = 8 * 1024 * 1024 // keep at most 8 MB of each output stream

/** Run one argument list. Resolves with what happened; never rejects for a failing program. */
export function runArgv(argv, { cwd, env = {}, timeoutMs = 600000 } = {}) {
  return new Promise(res => {
    const t0 = Date.now()
    let out = Buffer.alloc(0), err = Buffer.alloc(0), timedOut = false, settled = false
    const keep = (buf, chunk) => (buf.length >= MAX_STREAM ? buf : Buffer.concat([buf, chunk]).subarray(0, MAX_STREAM))
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true })
    } catch (e) {
      return res({ exitCode: null, signal: null, timedOut: false, stdout: '', stderr: '', ms: 0, spawnError: e.message })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', c => { out = keep(out, c) })
    child.stderr.on('data', c => { err = keep(err, c) })
    const done = extra => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      res({ stdout: out.toString('utf8'), stderr: err.toString('utf8'), timedOut, ms: Date.now() - t0, ...extra })
    }
    child.on('error', e => done({ exitCode: null, signal: null, spawnError: e.message }))
    child.on('close', (code, signal) => done({ exitCode: code, signal }))
  })
}

/** Build a checkout with the profile's steps, in order, stopping at the first failure. */
export async function buildCheckout(profile, src, { log = () => {} } = {}) {
  const build = resolve(src, profile.build.dir)
  mkdirSync(build, { recursive: true })
  const vars = { src: resolve(src), build }
  const steps = []
  for (const step of profile.build.steps) {
    const argv = step.map(a => expand(a, vars))
    log(`build: ${argv.join(' ')}`)
    const r = await runArgv(argv, { cwd: build, env: expandEnv(profile.env, vars), timeoutMs: 3 * 3600e3 })
    steps.push({ argv, exitCode: r.exitCode, ms: r.ms, timedOut: r.timedOut, spawnError: r.spawnError, tail: tail(r.stdout + r.stderr) })
    if (r.exitCode !== 0) return { ok: false, build, steps }
  }
  return { ok: true, build, steps }
}

function expandEnv(env = {}, vars) {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expand(v, vars)]))
}

const tail = s => String(s).split('\n').slice(-40).join('\n')

/** Glob pattern ("*.asc", "out/*_vel.asc", "**\/*.tif") to a regular expression over "/"-separated relative paths. */
export function globToRegex(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++ }
    else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function walk(dir, root = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, root, acc)
    else if (st.isFile()) acc.push(relative(root, p).split(sep).join('/'))
  }
  return acc
}

/**
 * Run one case in a fresh folder: write its input files, run its command there, collect output files that match its
 * patterns (input files excluded). Returns { exitCode, timedOut, stdout, stderr, ms, runDir, outputs: {path: Buffer} }.
 */
export async function runCase(profile, kase, { src, build, runDir }) {
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  const vars = { src: resolve(src), build: resolve(build ?? join(src, profile.build.dir)), run: resolve(runDir) }
  const inputs = new Set()
  for (const [name, text] of Object.entries(kase.files ?? {})) {
    const p = join(runDir, name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, expand(text, vars))
    inputs.add(name.split(sep).join('/'))
  }
  const argv = kase.command.map(a => expand(a, vars))
  const r = await runArgv(argv, { cwd: runDir, env: expandEnv(profile.env, vars), timeoutMs: kase.timeoutMs ?? 600000 })
  const patterns = (kase.outputs ?? []).map(globToRegex)
  const outputs = {}
  if (existsSync(runDir)) {
    for (const rel of walk(runDir).sort()) {
      if (inputs.has(rel) || !patterns.some(re => re.test(rel))) continue
      outputs[rel] = readFileSync(join(runDir, rel))
    }
  }
  return { ...r, argv, runDir, outputs }
}
