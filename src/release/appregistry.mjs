// The apps Behique can show in the sidebar: the ones built in (FreshRSS) and the user's GitHub repositories.
// A GitHub repo is listed so it can be picked and looked at, but it is NOT runnable: Behique does not yet know how to
// install it, start it, seed it or which buttons to click (FreshRSS has all of that, written by hand). Until a repo
// has that setup it is honestly labelled "needs setup", and nothing is cloned or executed.
import { APPS } from './scenarios.mjs'

export const builtinApps = () => Object.entries(APPS).map(([id, a]) => ({
  id, kind: 'builtin', label: a.label, subtitle: 'built in', runnable: true, status: 'ready',
  statusText: 'Ready: install, seed data and click steps are defined, so checks can run.',
}))

export const githubApp = r => ({
  id: `github:${r.fullName}`, kind: 'github', label: r.name, owner: r.owner, fullName: r.fullName,
  subtitle: [r.private ? 'private' : 'public', r.language, r.fork ? 'fork' : null].filter(Boolean).join(' · '),
  description: r.description, private: r.private, fork: r.fork, archived: r.archived, language: r.language,
  pushedAt: r.pushedAt, defaultBranch: r.defaultBranch, url: r.url,
  runnable: false, status: 'needs-setup',
  statusText: 'Needs setup: Behique does not yet know how to install, start or click through this repo, so no check can run on it.',
})

/** The sidebar's list: built-in apps first, then the connected account's repos (if any), plus the connection state. */
export async function listApps({ github, refresh = false } = {}) {
  const g = github ? await github.repos({ refresh }) : { connected: false, login: null, repos: [], error: null, fetchedAt: null }
  return {
    apps: [...builtinApps(), ...(g.connected ? g.repos.map(githubApp) : [])],
    github: { connected: g.connected, login: g.login, error: g.error, fetchedAt: g.fetchedAt, count: g.repos.length },
  }
}

/** Which app a saved report belongs to, so the reports list can follow the sidebar selection. */
export function appOfOpened(opened) {
  if (opened?.app) return opened.app
  const fromAdapter = String(opened?.adapter ?? '').split('-')[0]
  return APPS[fromAdapter] ? fromAdapter : null
}
