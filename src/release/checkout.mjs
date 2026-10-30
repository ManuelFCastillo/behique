// Check out a git ref of the app under test as a scratch worktree (identified by commit sha, never by ref name).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function checkoutRef(adapter, ref) {
  const git = (...a) => run('git', ['-C', adapter.repo, ...a]).then(r => r.stdout.trim())
  const sha = await git('rev-parse', `${ref}^{commit}`)
  const dir = join(adapter.workRoot, 'w-' + sha.slice(0, 12))
  if (!existsSync(dir)) await git('worktree', 'add', '-q', '--detach', dir, sha)
  await run('git', ['-C', dir, 'clean', '-fdxq', '--', ...adapter.cleanPaths])
  return { sha, dir }
}
