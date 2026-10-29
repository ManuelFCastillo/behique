// FreshRSS with long articles and "Stick the article to the top when opened" switched off: the setup in which upstream
// issue #9285 reported that scrolling changed in 1.30.0.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freshrssAdapter } from './freshrss.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
export default freshrssAdapter({ name: 'freshrss-scroll', feedDir: join(ROOT, 'bench/fixtures/freshrss-scroll'), expectedEntries: 8, config: { sticky_post: false } })
