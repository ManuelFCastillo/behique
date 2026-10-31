// A full release check (crawl, then compare good and candidate) on the apps of the set-up bench, one after the other, with one table at the end.
//   BEHIQUE_SANDBOX=docker:ssh://hardac2 BEHIQUE_SANDBOX_MEMORY_MB=10240 node bench/check-bench.mjs [name ...] [--bisect] [--timeout-min 25]
// Apps come from bench/onboard-bench.json (name, good, cand); their profiles from out/onboard-bench/profiles (the repaired ones, made by the repair run).
// Writes out/check-bench/<time>.json and .md. The crawl quality of each app is read from the crawl file the run wrote (src/release/crawl/summary.mjs).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderTable, runAll } from '../src/release/check-bench.mjs'
import { spawnRunner } from '../src/release/check-runner.mjs'
import { renderSummary, summarizeCrawl } from '../src/release/crawl/summary.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = n => args.includes('--' + n)
const opt = (n, d) => (flag(n) ? args[args.indexOf('--' + n) + 1] : d)
const names = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const CASES = JSON.parse(readFileSync(join(ROOT, 'bench', 'onboard-bench.json'), 'utf8'))
const chosen = CASES.filter(c => !names.length || names.includes(c.name))
const profileDir = opt('profiles', join(ROOT, 'out', 'onboard-bench', 'profiles'))
if (!existsSync(profileDir)) { console.error(`no profiles at ${profileDir}: run the set-up bench repair first`); process.exit(2) }

const env = { BEHIQUE_PROFILE_DIR: profileDir }
const newestCrawl = app => {
  const dir = join(ROOT, 'out', 'crawl')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter(f => f.startsWith(app + '-') && f.endsWith('.crawl.json')).map(f => join(dir, f))
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0] ?? null
}

const crawlQuality = {}
const results = await runAll({
  jobs: chosen.map(c => ({ app: c.name, good: c.good, cand: c.cand })),
  runner: spawnRunner({ root: ROOT }),
  cleanup: async () => {}, // each run stops its own builds; a crashed sandbox is removed with src/release/sandbox/clean.mjs
  bisect: flag('bisect'),
  timeoutMs: Number(opt('timeout-min', 25)) * 60_000,
  env,
  onResult: (r, i) => {
    console.log(`\n[${i + 1}/${chosen.length}] ${r.app}: ${r.outcome} (${r.seconds} s)${r.error ? ' | ' + r.error : ''}`)
    const f = newestCrawl(r.app)
    if (f) {
      try { const s = summarizeCrawl(JSON.parse(readFileSync(f, 'utf8'))); crawlQuality[r.app] = s; renderSummary(s).forEach(l => console.log('  ' + l)) } catch { /* no summary */ }
    }
  },
})

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = join(ROOT, 'out', 'check-bench'); mkdirSync(outDir, { recursive: true })
const table = renderTable(results)
const quality = Object.values(crawlQuality).map(s => `| ${s.app} | ${s.quality} | ${s.states} | ${s.distinctStates} | ${s.flows} | ${s.steps} | ${s.reasons.join(' ')} |`)
const md = `${table}\n\n## Crawl quality\n\n| App | Quality | Pages | Distinct | Flows | Steps | Notes |\n|---|---|---|---|---|---|---|\n${quality.join('\n')}\n`
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ results, crawlQuality }, null, 2) + '\n')
writeFileSync(join(outDir, `${stamp}.md`), md)
console.log('\n' + md)
console.log(`saved out/check-bench/${stamp}.{json,md}`)
