// Gives the sandbox's copy of a repository one git commit of its own. The checkout is copied in without its .git (size, and nothing
// private travels), and a build that reads last-update dates from git (Docusaurus showLastUpdateTime, VitePress lastUpdated) fails
// without a repository. Every file is committed as copied, so every page's date is the build's own and the same on both versions.
// Runs inside the install container, in /work, as the first install step of a profile with serve.gitHistory: true.
import { spawnSync } from 'node:child_process'

const run = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=behique', '-c', 'user.email=behique@localhost', '-c', 'commit.gpgsign=false', ...args], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: process.env.HOME || '/work/.home' },
  })
  if (r.error || r.status !== 0) { console.error(`git ${args[0]} failed: ${(r.error?.message || r.stderr || r.stdout || '').trim()}`); process.exit(1) }
  return r
}
run('init', '-q', '-b', 'main')
run('add', '-A', '.')
run('commit', '-q', '--no-verify', '-m', 'behique: the checkout as copied into the sandbox')
console.log('git history: one commit, every file as copied')
