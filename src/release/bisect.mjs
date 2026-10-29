// Find the first change that makes an exported test fail, by binary search over the commits between two refs.
//   node src/release/bisect.mjs <goodRef> <badRef> [--dir out/regression/<good>-vs-<bad>] [--id R1] [--port 8300] [--runs 3]
// Each tested commit is built from a clean seeded install and the test is run on it once. A run is classified as:
//   good = the test passed
//   bad  = the test failed on the value assertion (the same failure the regression showed)
//   skip = anything else (build failed, element missing, timeout): says nothing about the regression, so it is
//          set aside and the search tries a neighbouring commit instead of guessing.
// The answer is only reported as verified if the parent of the first bad commit passes `runs` times in a row
// and the first bad commit fails `runs` times in a row.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runExported } from '../export.mjs'
import { startBuild } from './build.mjs'

const run = promisify(execFile)
const firstLine = s => String(s ?? '').split('\n').find(l => l.trim())?.trim().slice(0, 100) ?? ''

/** good / bad / skip for one run of the exported test. */
export function classify(r, id) {
  if (r.error) return { verdict: 'skip', why: 'runner error' }
  if (r.results[id] === true) return { verdict: 'good' }
  const msg = r.errors?.[id] ?? ''
  if (/expect\(received\)\.(toBe|toContain|toMatch)\(/.test(msg)) return { verdict: 'bad' }
  return { verdict: 'skip', why: firstLine(msg) || 'test failed for another reason' }
}

async function check({ adapter, ref, port, dir, id }) {
  let b
  try { b = await startBuild({ adapter, ref, port }) } catch (e) { return { verdict: 'skip', why: 'build failed: ' + firstLine(e.message) } }
  try { return classify(runExported(dir, new URL(b.base).origin), id) } finally { await b.stop() }
}

export async function bisect({ adapter, goodRef, badRef, dir, id = 'R1', port = 8300, runs = 3, log = console.log, test = check, onEvent = () => {} }) {
  const t0 = Date.now()
  const git = (...a) => run('git', ['-C', adapter.repo, ...a]).then(r => r.stdout.trim())
  const worktrees = async () => (await git('worktree', 'list', '--porcelain')).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
  const before = new Set(await worktrees())
  const C = (await git('rev-list', '--reverse', `${goodRef}..${badRef}`)).split('\n').filter(Boolean)
  const n = C.length
  if (!n) throw new Error(`there are no changes between ${goodRef} and ${badRef} to search (the old version must come before the new one)`)
  log(`bisect: ${n} changes between ${goodRef} and ${badRef}`)
  onEvent('started', { changes: n })
  if (+(await git('rev-list', '--merges', '--count', `${goodRef}..${badRef}`))) log('  note: the history has merge commits, so the search order is approximate')

  try {
    let lo = -1, hi = n - 1, step = 0 // lo = last known good (-1 is goodRef itself), hi = first known bad
    const skipped = new Set()
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      let pick = null // the middle commit, or the nearest one not already set aside
      for (let d = 0; d <= hi - lo && pick === null; d++) for (const c of [mid + d, mid - d]) if (c > lo && c < hi && !skipped.has(c)) { pick = c; break }
      if (pick === null) break
      step++
      const r = await test({ adapter, ref: C[pick], port, dir, id })
      const subject = (await git('log', '-1', '--format=%s', C[pick])).slice(0, 70)
      log(`  bisect step ${step}: ${C[pick].slice(0, 7)} (#${pick + 1} of ${n}) ${r.verdict}${r.why ? ` (${r.why})` : ''} | ${subject}`)
      if (r.verdict === 'good') lo = pick; else if (r.verdict === 'bad') hi = pick; else skipped.add(pick)
      log(`  bisect range: good through #${lo + 1}, bad from #${hi + 1}, of ${n}`)
      onEvent('step', { step, sha: C[pick].slice(0, 7), index: pick + 1, verdict: r.verdict, ...(r.why ? { why: r.why } : {}), subject, goodThrough: lo + 1, badFrom: hi + 1, changes: n })
    }
    const seconds = () => +((Date.now() - t0) / 1000).toFixed(1)
    if (hi - lo > 1) {
      log(`BISECT INCONCLUSIVE: the first bad change is one of ${hi - lo} (#${lo + 2} to #${hi + 1}); the ones in between could not be tested`)
      return { conclusive: false, verified: false, range: [lo + 2, hi + 1], changes: n, steps: step, seconds: seconds() }
    }

    const first = C[hi], parent = lo === -1 ? goodRef : C[lo]
    const info = await git('show', '-s', '--format=%an%n%ad%n%s', '--date=short', first).then(t => t.split('\n'))
    const files = (await git('diff-tree', '--no-commit-id', '--name-only', '-r', first)).split('\n').filter(Boolean)
    const origin = await git('remote', 'get-url', 'origin').catch(() => '')
    const url = /github\.com/.test(origin) ? `${origin.replace(/\.git$/, '')}/commit/${first}` : null
    log(`bisect: first bad change is #${hi + 1} of ${n}, found in ${step} steps`)
    log(`  commit: ${first}`); log(`  subject: ${info[2]}`); log(`  author: ${info[0]}`); log(`  date: ${info[1]}`)
    log(`  files: ${files.length}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', ...' : ''}`)
    if (url) log(`  url: ${url}`)

    onEvent('verifying', { commit: first.slice(0, 7), runs })
    const verify = async (ref, want) => {
      let ok = 0
      for (let i = 0; i < runs; i++) ok += (await test({ adapter, ref, port, dir, id })).verdict === want
      return ok
    }
    const okParent = await verify(parent, 'good'), okFirst = await verify(first, 'bad')
    log(`  verify parent ${parent.slice(0, 7)}: passed ${okParent}/${runs}`)
    log(`  verify ${first.slice(0, 7)}: failed ${okFirst}/${runs}`)
    const verified = okParent === runs && okFirst === runs
    log(verified ? `BISECT CONFIRMED: ${first.slice(0, 7)} is the first change that breaks it` : 'BISECT NOT CONFIRMED: the verification runs were not clean')
    return { conclusive: true, verified, commit: first, parent, subject: info[2], author: info[0], date: info[1], files, url, changes: n, steps: step, seconds: seconds() }
  } finally { // remove the checkouts this search created; keep the ones that were already there
    for (const w of await worktrees()) if (!before.has(w) && w.startsWith(adapter.workRoot)) await git('worktree', 'remove', '--force', w).catch(() => {})
  }
}

// Command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
  const [goodRef, badRef] = args.filter(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'))
  if (!goodRef || !badRef) { console.error('usage: node src/release/bisect.mjs <goodRef> <badRef> [--dir d] [--id R1] [--port N] [--runs N] [--adapter name]'); process.exit(2) }
  const adapter = (await import(`./adapters/${opt('adapter', 'freshrss')}.mjs`)).default
  const dir = opt('dir', join('out', 'regression', `${goodRef}-vs-${badRef}`.replace(/[^\w.-]/g, '_')))
  const r = await bisect({ adapter, goodRef, badRef, dir, id: opt('id', 'R1'), port: +opt('port', 8300), runs: +opt('runs', 3) })
  console.log(`done in ${r.seconds} s`)
  process.exit(r.verified ? 0 : 1)
}
