// Read-only view of the user's GitHub repositories, through the GitHub CLI's EXISTING login.
// Behique never sees, stores or logs the token: it asks `gh` (which keeps it in the system keychain) for two fixed,
// read-only things and nothing else:
//     gh api user                      who is connected
//     gh repo list --limit N --json    the repositories of that account
// No argument is ever built from user input. Whatever GitHub returns is treated as data: names are validated,
// descriptions are cut, and a URL is only passed on if it is a plain https://github.com/<owner>/<name> link.
import { execFile } from 'node:child_process'

const FIELDS = 'name,nameWithOwner,description,isPrivate,isFork,isArchived,pushedAt,primaryLanguage,url,defaultBranchRef,owner,visibility,diskUsage'
const NAME = /^[A-Za-z0-9._-]{1,100}$/
const URL_OK = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/
export const MAX_REPOS = 200
const scrub = s => String(s ?? '').replace(/\bgh[a-z]_[A-Za-z0-9_*]+/g, '****').replace(/Bearer\s+\S+/gi, 'Bearer ****').slice(0, 300)

/** Runs `gh` with fixed arguments. Resolves to { code, stdout, stderr, missing, timedOut }; never throws. */
export const ghRunner = (env = process.env) => args => new Promise(resolve => {
  execFile('gh', args, { timeout: 30_000, maxBuffer: 20e6, env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: err?.code === 'ENOENT', timedOut: Boolean(err?.killed) })
  })
})

/** A short, safe, human sentence for a failed `gh` call. */
export function explain(res) {
  if (res.missing) return 'The GitHub CLI (gh) is not installed on this machine.'
  if (res.timedOut) return 'GitHub did not answer in time.'
  const text = res.stderr || res.stdout
  if (/not logged in|gh auth login|authentication|HTTP 401|bad credentials/i.test(text)) return 'GitHub is not connected. Run "gh auth login" in a terminal, then refresh.'
  return scrub(String(text).split('\n').find(l => l.trim()) ?? 'GitHub returned an error.')
}

/** One repository row from GitHub, or null if it cannot be trusted. */
export function normalize(row) {
  const owner = row?.owner?.login, name = row?.name
  if (!NAME.test(owner ?? '') || !NAME.test(name ?? '')) return null
  return {
    owner, name, fullName: `${owner}/${name}`,
    description: String(row.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    private: row.isPrivate === true || row.visibility === 'PRIVATE', fork: row.isFork === true, archived: row.isArchived === true,
    language: typeof row.primaryLanguage?.name === 'string' ? row.primaryLanguage.name.slice(0, 40) : null,
    pushedAt: Number.isFinite(Date.parse(row.pushedAt)) ? row.pushedAt : null,
    defaultBranch: NAME.test(row.defaultBranchRef?.name ?? '') ? row.defaultBranchRef.name : null,
    sizeKb: Number.isFinite(row.diskUsage) && row.diskUsage >= 0 ? row.diskUsage : null, // what GitHub reports as the repository's size
    url: URL_OK.test(row.url ?? '') ? row.url : null,
  }
}

/**
 * A reader with a short cache, so the sidebar can be opened often without asking GitHub every time.
 * Only successful answers are cached: after "gh auth login" a refresh works at once.
 */
export function createGithub({ run = ghRunner(), ttlMs = 60_000, now = () => Date.now() } = {}) {
  let cache = null
  return {
    /** { connected, login, repos, error, fetchedAt } */
    async repos({ refresh = false } = {}) {
      if (!refresh && cache && now() - cache.at < ttlMs) return cache.value
      const who = await run(['api', 'user', '--jq', '.login'])
      if (who.code !== 0) return { connected: false, login: null, repos: [], error: explain(who), fetchedAt: null }
      const login = NAME.test(who.stdout.trim()) ? who.stdout.trim() : null
      const list = await run(['repo', 'list', '--limit', String(MAX_REPOS), '--json', FIELDS])
      if (list.code !== 0) return { connected: true, login, repos: [], error: explain(list), fetchedAt: null }
      let rows
      try { rows = JSON.parse(list.stdout) } catch { return { connected: true, login, repos: [], error: 'GitHub returned something unreadable.', fetchedAt: null } }
      const repos = (Array.isArray(rows) ? rows : []).map(normalize).filter(Boolean)
        .sort((a, b) => (Date.parse(b.pushedAt) || 0) - (Date.parse(a.pushedAt) || 0))
      const value = { connected: true, login, repos, error: null, fetchedAt: new Date(now()).toISOString() }
      cache = { at: now(), value }
      return value
    },
  }
}
