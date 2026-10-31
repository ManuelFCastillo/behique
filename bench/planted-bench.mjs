// Measure whether a release check finds changes we KNOW are there: a small static app with nine planted changes and one comment-only change.
//   node bench/planted-bench.mjs [--only m-data-attr,noop] [--keep]       (runs on this machine: the app is our own code)
// Builds a git repo in out/planted/repo (base commit, one tag per candidate, each differing from base by exactly one change), writes a profile,
// runs check-app (crawl, then compare) base against each candidate, and scores it with src/release/planted.mjs. Free: no model is called.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAll } from '../src/release/check-bench.mjs'
import { spawnRunner } from '../src/release/check-runner.mjs'
import { planHistory, scorePlanted } from '../src/release/planted.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null
const OUT = join(ROOT, 'out', 'planted')
const REPO = join(OUT, 'repo'), WORK = join(OUT, 'work'), PROFILES = join(OUT, 'profiles')
rmSync(OUT, { recursive: true, force: true }); for (const d of [REPO, WORK, PROFILES]) mkdirSync(d, { recursive: true })

// the history: base, then one tag per candidate, each made from base alone
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { stdio: 'pipe' }).toString().trim()
const history = planHistory()
git('init', '-q', '-b', 'main'); git('config', 'user.email', 'planted@example.com'); git('config', 'user.name', 'planted')
const writeAll = files => { for (const [p, t] of Object.entries(files)) writeFileSync(join(REPO, p), t) }
writeAll(history[0].files); git('add', '-A'); git('commit', '-q', '-m', history[0].message); git('tag', 'base')
for (const h of history.slice(1)) {
  git('checkout', '-q', '--detach', 'base'); writeAll(h.files); git('add', '-A'); git('commit', '-q', '-m', h.message); git('tag', h.tag)
}
git('checkout', '-q', 'main')

writeFileSync(join(PROFILES, 'planted.json'), JSON.stringify({
  name: 'planted', repo: REPO, workRoot: WORK, defaults: { good: 'base', cand: 'noop' },
  serve: { kind: 'static' }, ready: { path: '/', timeoutMs: 15000 },
}, null, 2))

const tags = history.slice(1).map(h => h.tag).filter(t => !only || only.has(t))
const results = await runAll({
  jobs: tags.map(t => ({ app: 'planted', good: 'base', cand: t })),
  runner: spawnRunner({ root: ROOT }),
  cleanup: async () => {},
  timeoutMs: 10 * 60_000,
  env: { BEHIQUE_PROFILE_DIR: PROFILES },
  onResult: (r, i) => console.log(`[${i + 1}/${tags.length}] ${r.cand}: ${r.outcome}, control ${r.controlDifferences ?? '-'}, candidate ${r.candidateDifferences ?? '-'}, confirmed ${r.confirmed}/${r.total} (${r.seconds} s)${r.error ? ' | ' + r.error : ''}`),
})
const score = scorePlanted(results.map(r => ({ ...r, tag: r.cand })))
console.log('\n' + score.lines)
mkdirSync(join(ROOT, 'out', 'check-bench'), { recursive: true })
writeFileSync(join(ROOT, 'out', 'check-bench', 'planted-latest.json'), JSON.stringify({ score, results }, null, 2) + '\n')
