// Remove sandboxes a crashed run left behind (containers, networks, volumes labelled behique=1 that are older than N minutes).
//   node src/release/sandbox/clean.mjs [--target ssh://hardac2] [--minutes 120]
import { makeDocker } from './docker-exec.mjs'
import { cleanStale } from './sandbox.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
const target = opt('target', (process.env.BEHIQUE_SANDBOX ?? '').replace(/^docker:?/, ''))
const minutes = Number(opt('minutes', 120))
if (!Number.isFinite(minutes) || minutes < 0) { console.error('usage: node src/release/sandbox/clean.mjs [--target ssh://hardac2] [--minutes 120]'); process.exit(2) }
const r = await cleanStale({ docker: makeDocker({ target }), olderThanMinutes: minutes })
console.log(`removed ${r.removed.containers} containers, ${r.removed.networks} networks, ${r.removed.volumes} volumes (older than ${minutes} min, ${target || 'local engine'})`)
