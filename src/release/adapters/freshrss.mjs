// How to install, seed and serve FreshRSS (the app under test for the two-release demo).
// An adapter is plain data plus two functions, so another app only needs another file like this one.
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const HOME = join(homedir(), 'dev/freshrss-spike')

const CLIPBOARD = `'sharing' =>
  array (
    0 =>
    array (
      'type' => 'clipboard',
      'url' => '~LINK~',
      'name' => 'Clipboard',
      'method' => 'GET',
      'field' => '',
      'help' => '',
      'form' => 'simple',
      'HTMLtag' => 'button',
    ),
  ),`

/** The FreshRSS adapter. A scenario is a feed fixture plus optional user settings; everything else is shared. */
export function freshrssAdapter({ name = 'freshrss', feedDir = join(ROOT, 'bench/fixtures/freshrss'), expectedEntries = 3, config = {} } = {}) {
  return {
  name,
  repo: join(HOME, 'repo'),          // full clone; each build is a git worktree of it
  workRoot: HOME,
  cleanPaths: ['data'],              // wiped before every install so each build starts from the same state
  feed: { dir: feedDir, port: 8400 }, // fixed articles, served locally
  basePath: '/i',                    // the page the explorer opens: http://127.0.0.1:<port>/i/
  expectedEntries,

  async prepare(dir, { port, feedUrl }) {
    // 1.30.0 refuses to fetch from internal addresses unless allowed (older builds ignore this variable).
    const env = { ...process.env, INTERNAL_HOST_ALLOWLIST: new URL(feedUrl).host }
    const php = (...a) => run('php', a, { cwd: dir, env })
    const sql = q => run('sqlite3', [join(dir, 'data/users/demo/db.sqlite'), q]).then(r => r.stdout.trim())
    await php('cli/do-install.php', '--default-user', 'demo', '--auth-type', 'none', '--db-type', 'sqlite', '--base-url', `http://127.0.0.1:${port}`, '--language', 'en')
    await php('cli/create-user.php', '--user', 'demo', '--password', 'demopass123')
    // A fresh install subscribes to external feeds: delete them so the data does not depend on the internet.
    await sql('DELETE FROM entrytag; DELETE FROM entry; DELETE FROM feed; DELETE FROM tag; DELETE FROM category WHERE id>1;')
    // The Share menu is empty until a sharing service is configured: add Clipboard (a known configuration, not discovered).
    const cfg = join(dir, 'data/users/demo/config.php')
    const src = readFileSync(cfg, 'utf8')
    const patched = src.replace(/'sharing' => \s*array \(\s*\),/, () => CLIPBOARD)
    if (patched === src) throw new Error('could not add the Clipboard share service to config.php')
    // A scenario can switch user settings (for example sticky_post: false); each must already exist in the default config.
    let out = patched
    for (const [k, v] of Object.entries(config)) {
      const re = new RegExp(`'${k}' => [^,\\n]+,`)
      if (!re.test(out)) throw new Error(`setting ${k} not found in config.php`)
      out = out.replace(re, `'${k}' => ${JSON.stringify(v)},`)
    }
    writeFileSync(cfg, out)
    const opml = join(tmpdir(), 'behique-freshrss-feeds.opml')
    writeFileSync(opml, `<?xml version="1.0"?><opml version="2.0"><head><title>seed</title></head><body><outline text="Spike"><outline type="rss" text="Spike Feed" xmlUrl="${feedUrl}" htmlUrl="${feedUrl}"/></outline></body></opml>`)
    await php('cli/import-for-user.php', '--user', 'demo', '--filename', opml)
    await php('cli/actualize-user.php', '--user', 'demo')
    return { entries: Number(await sql('SELECT count(*) FROM entry')) }
  },

  serve: (dir, port) => ({ cmd: 'php', args: ['-S', `127.0.0.1:${port}`, '-t', 'p'] }),
  }
}

export default freshrssAdapter()
