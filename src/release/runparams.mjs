// Validate the parameters of a run started from the dashboard. Everything in here is untrusted input: it ends up on a
// command line and in git calls, so it is checked against a strict pattern, resolved in the real repository, and only
// then passed on as separate arguments (never through a shell).
import { execFile } from 'node:child_process'

// a plain tag or branch name: starts with a letter or digit (so never an option), no spaces, no "..", at most 60 characters
export const REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,59}$/

/** A git runner for one repository: resolves to { code, out } and never throws. */
export const gitIn = repo => args => new Promise(resolve => execFile('git', ['-C', repo, ...args], { maxBuffer: 5e6 }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout ?? '').trim() })))

/** Returns { ok: true, params, note } or { ok: false, error }. `git` is injectable so the rules can be tested without a repository. */
export async function validateRun(input, { scenarios, git }) {
  const bad = error => ({ ok: false, error })
  const sc = scenarios[input?.scenario]
  if (!sc) return bad('Choose one of the known cases.')
  if (input.app && input.app !== sc.app) return bad('That case belongs to a different app.')
  const sha = {}
  for (const [key, label] of [['goodRef', 'old'], ['candRef', 'new']]) {
    const ref = String(input[key] ?? '').trim()
    if (!REF.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) return bad(`The ${label} version "${ref.slice(0, 30)}" is not a valid tag or branch name.`)
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (r.code !== 0 || !r.out) return bad(`There is no ${label} version "${ref}" in the repository.`)
    sha[key] = r.out
  }
  const goodRef = String(input.goodRef).trim(), candRef = String(input.candRef).trim()
  let bisect = input.bisect !== false, note = null
  if (sha.goodRef === sha.candRef) { bisect = false; note = 'The two versions are the same, so there is nothing to search; this is a clean-run check.' }
  else if (bisect) {
    const a = await git(['merge-base', '--is-ancestor', sha.goodRef, sha.candRef])
    if (a.code !== 0) return bad('For the search, the old version must come before the new one in the history. Switch them, or untick the search to compare anyway.')
  }
  return { ok: true, note, params: { scenario: input.scenario, app: sc.app, goodRef, candRef, goodSha: sha.goodRef, candSha: sha.candRef, bisect } }
}
