// Find the click paths of an app by crawling it, and write them as the steps a release check replays.
//   node src/release/crawl/cli.mjs <app> [ref] [--port 8300] [--max-depth 2] [--max-paths 40] [--max-flows 20] [--budget 120] [--out out/crawl]
// <app> is a saved profile (an app Behique set up itself) or a built-in app (freshrss). The crawl runs on ONE version (default: the app's
// good version), never changes the app (no request but GET, nothing typed, dialogs dismissed) and calls no model. It writes
//   <out>/<app>-<sha12>.steps.json    the list of actions, the file `confirm.mjs --steps` reads
//   <out>/<app>-<sha12>.crawl.json    what it found: states, flows, counts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startBuild, stopAll } from '../build.mjs'
import { listProfileNames, loadProfile, profileToAdapter } from '../onboard/profile.mjs'
import { APPS } from '../scenarios.mjs'
import { crawlApp } from './run.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The adapter and default good version of an app, from a saved profile or the built-in list. */
export async function resolveApp(name) {
  if (listProfileNames().includes(name)) {
    const profile = loadProfile(name)
    return { adapter: profileToAdapter(profile), defaultRef: profile.defaults?.good ?? null, kind: 'profile' }
  }
  if (APPS[name]) return { adapter: (await import(`../adapters/${APPS[name].adapter}.mjs`)).default, defaultRef: APPS[name].defaults.good, kind: 'builtin' }
  throw new Error(`unknown app "${String(name).slice(0, 30)}"; saved apps: ${listProfileNames().join(', ') || 'none'}; built in: ${Object.keys(APPS).join(', ')}`)
}

export async function runCrawlCli(argv, { log = console.log } = {}) {
  const args = argv.slice(2)
  const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
  const pos = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  const [app, refArg] = pos
  if (!app) { log('usage: node src/release/crawl/cli.mjs <app> [ref] [--port 8300] [--max-depth 2] [--max-paths 40] [--max-flows 20] [--budget 120] [--out out/crawl]'); return { code: 2 } }
  let resolved
  try { resolved = await resolveApp(app) } catch (e) { log(String(e.message)); return { code: 2 } }
  const ref = refArg ?? resolved.defaultRef
  if (!ref) { log('no version given and the app has no default: pass a tag or branch'); return { code: 2 } }
  const num = (name, d) => { const v = Number(opt(name, d)); return Number.isFinite(v) && v > 0 ? v : d }
  const options = { maxDepth: num('max-depth', 2), maxPaths: num('max-paths', 40), maxFlows: num('max-flows', 20), budgetMs: num('budget', 120) * 1000 }
  let build
  try {
    build = await startBuild({ adapter: resolved.adapter, ref, port: num('port', 8300) })
    log(`crawling ${app} ${ref} (${build.sha.slice(0, 12)}) at ${build.base}`)
    const found = await crawlApp(build.base, { ...options, log: l => log(`  ${l}`) })
    const outDir = join(ROOT, opt('out', 'out/crawl'))
    mkdirSync(outDir, { recursive: true })
    const stem = `${app}-${build.sha.slice(0, 12)}`
    const stepsFile = join(outDir, `${stem}.steps.json`)
    writeFileSync(stepsFile, JSON.stringify(found.steps, null, 2) + '\n')
    writeFileSync(join(outDir, `${stem}.crawl.json`), JSON.stringify({ app, ref, sha: build.sha, options, stoppedBy: found.stoppedBy, ms: found.ms, stats: found.stats, states: found.states.map(s => ({ url: s.url, title: s.title, path: s.path.map(a => a.label ?? a.type) })), flows: found.flows.map(f => f.path.map(a => a.label ?? a.type)), steps: found.steps }, null, 2) + '\n')
    log(`${found.states.length} page states, ${found.flows.length} flows, ${found.steps.length} steps (stopped: ${found.stoppedBy}, ${(found.ms / 1000).toFixed(0)} s)`)
    log(`steps: ${stepsFile.replace(ROOT + '/', '')}`)
    return { code: 0, stepsFile, found }
  } catch (e) {
    log(`the crawl failed: ${String(e.message).split('\n')[0]}`)
    return { code: 1 }
  } finally {
    await build?.stop().catch(() => {})
    await stopAll().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await runCrawlCli(process.argv)
  process.exit(r.code)
}
