// A release check of any app Behique knows (a saved profile, or a built-in one), with no hand-written steps:
// crawl the good version for click paths, then compare what both versions show along those paths.
//   node src/release/check-app.mjs <app> <goodRef> <candRef> [--bisect] [--max-findings 5] [--recrawl]
// Step 1 is `crawl/cli.mjs` (read-only, no model). Step 2 is `confirm.mjs --steps` (facts, tests, findings, screenshots, optional bisect).
// A crawl of the same commit with the same options is reused from out/crawl (the app has not changed, so its click paths have not); --recrawl crawls again.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutRef } from './checkout.mjs'
import { crawlLimits, resolveApp } from './crawl/cli.mjs'
import { crawlFileStem, pickCrawl, reuseNote, startPathOf, withStart } from './crawl/reuse.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const pos = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const [app, goodRef, candRef] = pos
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
if (!app || !goodRef || !candRef) { console.error('usage: node src/release/check-app.mjs <app> <goodRef> <candRef> [--bisect] [--max-findings 5] [--recrawl]'); process.exit(2) }

let resolved
try { resolved = await resolveApp(app) } catch (e) { console.error(String(e.message)); process.exit(2) }

let child = null
process.on('SIGTERM', () => { child?.kill('SIGTERM'); setTimeout(() => process.exit(130), 3000).unref() }) // a cancel stops whichever step is running

/** Run a node script, pass its output through line by line, and resolve with { code, lines }. */
const step = argv => new Promise(resolve => {
  child = spawn('node', argv, { cwd: ROOT })
  const lines = []
  let buf = ''
  const take = d => { buf += String(d); const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) { lines.push(l); console.log(l) } }
  child.stdout.on('data', take); child.stderr.on('data', take)
  child.on('close', code => { if (buf) { lines.push(buf); console.log(buf) } resolve({ code, lines }) })
})

/** The steps file of a saved crawl of this exact commit, or null (no crawl, different options, no steps, or --recrawl). */
async function savedCrawl() {
  if (args.includes('--recrawl')) return null
  try {
    const { sha } = await checkoutRef(resolved.adapter, goodRef)
    const stem = crawlFileStem(app, sha)
    if (!stem) return null
    const file = join(ROOT, 'out', 'crawl', `${stem}.crawl.json`), stepsFile = join(ROOT, 'out', 'crawl', `${stem}.steps.json`)
    if (!existsSync(file) || !existsSync(stepsFile)) return null
    const pick = pickCrawl([JSON.parse(readFileSync(file, 'utf8'))], { app, sha, options: withStart(crawlLimits(resolved), startPathOf(resolved)) })
    if (!pick) return null
    const found = pick.record
    return { stepsFile: stepsFile.replace(ROOT + '/', ''), note: reuseNote(found), states: Array.isArray(found.states) ? found.states.length : 0, flows: Array.isArray(found.flows) ? found.flows.length : 0, steps: found.steps.length }
  } catch { return null } // anything odd about the saved file: crawl again
}

console.log(`step 1 of 2: crawling ${app} ${goodRef} for click paths`)
const saved = await savedCrawl()
let stepsFile
if (saved) {
  console.log(saved.note)
  console.log(`${saved.states} page states, ${saved.flows} flows, ${saved.steps} steps (from the saved crawl)`) // the same shape the crawl prints, for the dashboard's progress
  console.log(`steps: ${saved.stepsFile}`)
  stepsFile = saved.stepsFile
} else {
  const crawl = await step(['src/release/crawl/cli.mjs', app, goodRef])
  const stepsLine = crawl.lines.map(l => l.match(/^steps: (\S+)$/)).filter(Boolean).at(-1)
  if (crawl.code !== 0 || !stepsLine) { console.log('the crawl did not produce any steps, so there is nothing to compare'); process.exit(crawl.code || 1) }
  stepsFile = stepsLine[1]
}
console.log(`step 2 of 2: comparing ${goodRef} and ${candRef} along the crawled steps`)
const confirm = await step(['src/release/confirm.mjs', goodRef, candRef, ...(resolved.kind === 'profile' ? ['--app', app] : ['--adapter', resolved.adapter.name]), '--steps', stepsFile, '--read-only', '--max-findings', opt('max-findings', '5'), ...(args.includes('--bisect') ? ['--bisect'] : [])])
process.exit(confirm.code)
