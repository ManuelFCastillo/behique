// Remove sandboxes a crashed run left behind (containers, networks, volumes labelled behique=1 that are older than N minutes),
// then prune the build cache (bq-cache:* images): the newest 4 per app stay, plus anything under 14 days old.
//   node src/release/sandbox/clean.mjs [--target ssh://hardac2] [--minutes 120] [--keep 4] [--days 14]
import { makeDocker } from './docker-exec.mjs'
import { cleanStale, pruneCache } from './sandbox.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
const target = opt('target', (process.env.BEHIQUE_SANDBOX ?? '').replace(/^docker:?/, ''))
const minutes = Number(opt('minutes', 120))
if (!Number.isFinite(minutes) || minutes < 0) { console.error('usage: node src/release/sandbox/clean.mjs [--target ssh://hardac2] [--minutes 120]'); process.exit(2) }
const docker = makeDocker({ target })
const r = await cleanStale({ docker, olderThanMinutes: minutes })
console.log(`removed ${r.removed.containers} containers, ${r.removed.networks} networks, ${r.removed.volumes} volumes (older than ${minutes} min, ${target || 'local engine'})`)
const keep = Number(opt('keep', 4)), days = Number(opt('days', 14))
const c = await pruneCache({ docker, keepPerApp: Number.isInteger(keep) && keep >= 1 ? keep : 4, maxAgeDays: Number.isFinite(days) && days >= 0 ? days : 14 })
console.log(c.ok ? `build cache: ${c.images} images, kept ${c.kept}, removed ${c.removed}` : `build cache: could not list images: ${c.error}`)
