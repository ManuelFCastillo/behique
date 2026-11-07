// Check out and build one version of a native program from a git ref, identified by commit sha (never by ref name).
//   node --test src/release/native/versions.test.mjs
// Each commit gets its own git worktree under workRoot. A build that finished with the same steps is not repeated: a
// record of it (.behique-build.json, keyed by sha and a hash of the steps) sits in the build folder. A failed build is
// never reused, and a changed profile build section always rebuilds.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { sha } from '../evidence.mjs'
import { buildCheckout } from './run.mjs'

const run = promisify(execFile)
const RECORD = '.behique-build.json'

export const stepsKey = profile => sha(JSON.stringify({ dir: profile.build.dir, steps: profile.build.steps, env: profile.env ?? {} }))

/** Resolve a ref to a full commit sha in the profile's repository. */
export async function resolveRef(repo, ref) {
  const { stdout } = await run('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`])
  return stdout.trim()
}

/** A clean worktree of `sha` under workRoot (made once, then reused; untracked files outside the build folder removed). */
export async function worktreeFor(repo, sha, workRoot, buildDir) {
  mkdirSync(workRoot, { recursive: true })
  const dir = resolve(workRoot, `w-${sha.slice(0, 12)}`)
  if (!existsSync(dir)) await run('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', dir, sha])
  await run('git', ['-C', dir, 'clean', '-fdxq', '-e', buildDir])
  return dir
}

/** Check out and build `ref`. Returns { ref, sha, src, build, ok, reused, steps }. */
export async function prepareVersion(profile, ref, { workRoot, log = () => {} }) {
  const sha = await resolveRef(profile.repo, ref)
  const src = await worktreeFor(profile.repo, sha, workRoot, profile.build.dir)
  const build = join(src, profile.build.dir)
  const key = stepsKey(profile), recordPath = join(build, RECORD)
  if (existsSync(recordPath)) {
    try {
      const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
      if (rec.ok && rec.sha === sha && rec.key === key) { log(`build: reusing ${sha.slice(0, 12)} (built ${rec.at})`); return { ref, sha, src, build, ok: true, reused: true, steps: rec.steps } }
    } catch { /* an unreadable record is ignored and the build runs */ }
  }
  log(`build: ${ref} (${sha.slice(0, 12)})`)
  const r = await buildCheckout(profile, src, { log })
  writeFileSync(recordPath, JSON.stringify({ ok: r.ok, sha, key, at: new Date().toISOString(), steps: r.steps.map(s => ({ argv: s.argv, exitCode: s.exitCode, ms: s.ms })) }, null, 1))
  return { ref, sha, src, build, ok: r.ok, reused: false, steps: r.steps }
}
