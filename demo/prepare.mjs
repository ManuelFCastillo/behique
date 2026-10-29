// Put the demo in a known clean state before a recording take.
//   node demo/prepare.mjs [--keep <caseId>,<caseId>] [--generate]
// Reports are append-only (a Ship/Hold press or an AI guess can never be undone), so a take needs fresh ones.
//   - every report in out/evidence is MOVED (not deleted) to out/evidence-archive/<stamp>/, except those named in --keep
//   - --generate then runs the full check for both scenarios (about 100 s each) so there is exactly one fresh report of each
//   - finally it prints what is there: scenario, decisions, AI guesses, whether the record is intact, and the basics a take needs
// It refuses to run while a check is running (port 8300) or the demo server reports a job in progress.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { ENV, PROVIDERS } from '../src/llm.mjs'
import { listCases, openCase, summarize } from '../src/release/evidence.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
const keep = new Set((opt('keep', '') ?? '').split(',').filter(Boolean))
const ROOT = join(import.meta.dirname, '..'), EVIDENCE = join(ROOT, 'out/evidence')
const listening = port => new Promise(res => { const s = createConnection({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })

for (const p of [8300, 8301, 8302, 8400, 8401, 8402]) if (await listening(p)) { console.error(`port ${p} is in use: a check or a hand-test build is still running. Stop it first.`); process.exit(1) }
const busy = await fetch('http://127.0.0.1:8790/api/busy', { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null)
if (busy?.reason) { console.error('the demo server says: ' + busy.reason); process.exit(1) }

const have = listCases(EVIDENCE)
const unknown = [...keep].filter(k => !have.includes(k))
if (unknown.length) { console.error('--keep names no such report: ' + unknown.join(', ')); process.exit(2) }
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const moved = have.filter(id => !keep.has(id))
if (moved.length) {
  const dest = join(ROOT, 'out/evidence-archive', stamp); mkdirSync(dest, { recursive: true })
  for (const id of moved) renameSync(join(EVIDENCE, id), join(dest, id))
  console.log(`archived ${moved.length} report(s) to out/evidence-archive/${stamp}/ (moved, not deleted)`)
}
if (keep.size) console.log(`kept: ${[...keep].join(', ')}`)

if (args.includes('--generate')) {
  for (const sc of ['share', 'scroll']) {
    process.stdout.write(`generating ${sc} (about 100 s)... `)
    const r = spawnSync('node', ['src/release/confirm.mjs', '1.29.1', '1.30.0', '--scenario', sc, '--bisect'], { cwd: ROOT, encoding: 'utf8', timeout: 400_000 })
    const ok = r.status === 0 && /BISECT CONFIRMED/.test(r.stdout)
    console.log(ok ? 'done, bisect confirmed' : 'FAILED\n' + (r.stdout + r.stderr).split('\n').slice(-8).join('\n'))
    if (!ok) process.exit(1)
  }
}

console.log('\nreports now:')
for (const id of listCases(EVIDENCE).reverse()) {
  const c = openCase(join(EVIDENCE, id)), s = summarize(c.read())
  console.log(`  ${id}  ${(s.opened?.scenario?.name ?? 'no scenario (older)').padEnd(22)} decisions ${s.decisions.length}  AI guesses ${s.claims.filter(k => k.label === 'ai_hypothesis').length}/3  intact ${c.verify().ok}`)
}
console.log('\nbasics:')
console.log(`  model key for the AI step: ${ENV[PROVIDERS.meta.keyEnv] ? 'set' : 'MISSING'}`)
console.log(`  demo server on :8790: ${busy ? 'running and idle' : 'NOT running (start the "demo" preview, or: node demo/server.mjs)'}`)
console.log(`  checks and hand-test ports (8300-8302, 8400-8402): free`)
