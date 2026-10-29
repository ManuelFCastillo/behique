// Start the todo-app fixture, optionally with one planted bug applied to a private copy.
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(ROOT, 'bench/fixtures/todo-app')
export const MUTATIONS = JSON.parse(readFileSync(join(ROOT, 'bench/mutations.json'), 'utf8'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

export function applyMutation(dir, m) {
  const file = join(dir, m.file)
  const src = readFileSync(file, 'utf8')
  const hits = src.split(m.find).length - 1
  if (hits !== 1) throw new Error(`${m.id}: pattern found ${hits} times`)
  writeFileSync(file, src.replace(m.find, () => m.replace))
}

export async function startApp({ mutation = null, port, allowReset = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'behique-app-'))
  cpSync(FIXTURE, dir, { recursive: true })
  if (mutation) applyMutation(dir, mutation)
  const env = { ...process.env, PORT: String(port), DB_PATH: join(dir, 'test.db') }
  delete env.ALLOW_RESET
  if (allowReset) env.ALLOW_RESET = '1'
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: 'ignore' })
  const base = `http://localhost:${port}`
  let up = false
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(base + '/')).ok } catch { await sleep(100) }
  }
  if (!up) { child.kill(); throw new Error(`app did not start on ${port}`) }
  return { base, stop: async () => { child.kill(); rmSync(dir, { recursive: true, force: true }) } }
}
