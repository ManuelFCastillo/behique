// Turns the resolved catalog into the media folder on this machine: NFOs, posters, placeholder clips, credits.
//   node tools/jellyfin-seed/plan-media.mjs     after fetch-assets.mjs; needs ffmpeg
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyPlan, creditsMarkdown, ffmpegArgs, planTree } from './media.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', 'out', 'jellyfin-seed')
const catalog = JSON.parse(readFileSync(join(OUT, 'catalog.resolved.json'), 'utf8'))
const plan = planTree(catalog, { mediaRoot: join(OUT, 'media'), assetsDir: join(OUT, 'assets') })
console.log(applyPlan(plan))
for (const clip of plan.clips) {
  const r = spawnSync('ffmpeg', ffmpegArgs(clip, { title: clip.path.split('/').pop().replace(/\.mkv$/, '') }), { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${clip.path}: ${r.stderr}`)
}
writeFileSync(join(OUT, 'CREDITS.md'), creditsMarkdown(catalog))
const n = k => catalog.items.filter(i => i.kind === k)
writeFileSync(join(OUT, 'seed.json'), JSON.stringify({ user: 'demo', password: 'demo-demo', libraries: [{ name: 'Movies', kind: 'movies', path: '/media/Movies' }, { name: 'Shows', kind: 'tvshows', path: '/media/Shows' }], expected: { MovieCount: n('movie').length, SeriesCount: n('show').length, EpisodeCount: n('show').flatMap(s => s.seasons).flatMap(s => s.episodes).length } }, null, 2) + '\n')
console.log(plan.clips.length, 'clips')
