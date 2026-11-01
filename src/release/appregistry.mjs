// The apps Behique can show in the sidebar: the ones built in (FreshRSS) and the user's GitHub repositories.
// A GitHub repo is listed so it can be picked and looked at, but it is NOT runnable: Behique does not yet know how to
// install it, start it, seed it or which buttons to click (FreshRSS has all of that, written by hand). Until a repo
// has that setup it is honestly labelled "needs setup", and nothing is cloned or executed.
import { APPS } from './scenarios.mjs'

export const builtinApps = () => Object.entries(APPS).map(([id, a]) => ({
  id, kind: 'builtin', label: a.label, subtitle: 'built in', runnable: true, status: 'ready',
  statusText: 'Ready: install, seed data and click steps are defined, so checks can run.',
}))

/** An app Behique set up itself (a saved profile): runnable by picture, no hand-written adapter. */
export const profileApp = p => ({
  id: p.name, kind: 'profile', visual: true, label: p.label ?? p.name, subtitle: 'set up by Behique', runnable: true, status: 'ready',
  statusText: 'Ready: Behique set this app up. A visual check compares pictures of two versions and can search for the first change.',
  defaults: p.defaults ?? null, regions: Object.keys(p.regions ?? {}),
})

/** The folder a profile's repo lives in: the last segment of its `repo` path, or null. */
export const profileFolder = p => {
  const s = typeof p?.repo === 'string' ? p.repo.replace(/\/+$/, '').split('/').pop() : ''
  return s && !s.startsWith('.') ? s : null
}

/**
 * The saved profile that was set up from the repo of this name, if any: the profile whose repo folder is that name,
 * else the profile named the same. The sidebar then links the GitHub entry to the runnable app instead of saying
 * "needs setup" about a repo Behique already set up.
 */
export function profileForRepo(name, profiles = []) {
  if (typeof name !== 'string' || !name) return null
  const byFolder = profiles.find(p => profileFolder(p) === name)
  return byFolder ?? profiles.find(p => p?.name === name && !profileFolder(p)) ?? null // by name only when the profile says nothing about its repo
}

/**
 * `cloned` is the folder the repo was already cloned into (by the page, or by hand), or null: it changes the wording, not the status.
 * `profile` is the saved profile set up from this repo, or null: with one, the entry points at that app (`profileId`) and is "set up".
 */
export const githubApp = (r, cloned = null, profile = null) => ({
  id: `github:${r.fullName}`, kind: 'github', label: r.name, owner: r.owner, fullName: r.fullName,
  subtitle: [r.private ? 'private' : 'public', r.language, r.fork ? 'fork' : null, profile ? 'set up' : cloned ? 'cloned' : null].filter(Boolean).join(' · '),
  description: r.description, private: r.private, fork: r.fork, archived: r.archived, language: r.language,
  pushedAt: r.pushedAt, defaultBranch: r.defaultBranch, url: r.url, cloned: cloned || null,
  profileId: profile ? profile.name : null,
  runnable: false, status: profile ? 'set-up' : 'needs-setup',
  statusText: profile
    ? `Set up as the app "${profile.name}": checks on this repo run there.`
    : cloned
      ? 'Cloned, needs setup: the repo is in the apps folder, but Behique does not yet know how to install, start or click through it. Use Set up an app.'
      : 'Needs setup: Behique does not yet know how to install, start or click through this repo, so no check can run on it.',
})

/**
 * The sidebar's list: built-in apps first, then the connected account's repos (if any), plus the connection state.
 * `cloned(name)` answers with the folder a repo of that name is already cloned into, or null (the page never guesses from the name).
 * A repo that a saved profile was set up from is linked to that app.
 */
export async function listApps({ github, refresh = false, profiles = [], cloned = () => null } = {}) {
  const g = github ? await github.repos({ refresh }) : { connected: false, login: null, repos: [], error: null, fetchedAt: null }
  const clonedOf = r => { try { return cloned(r.name) ?? null } catch { return null } }
  return {
    apps: [...builtinApps(), ...profiles.map(profileApp), ...(g.connected ? g.repos.map(r => githubApp(r, clonedOf(r), profileForRepo(r.name, profiles))) : [])],
    github: { connected: g.connected, login: g.login, error: g.error, fetchedAt: g.fetchedAt, count: g.repos.length },
  }
}

/** Which app a saved report belongs to, so the reports list can follow the sidebar selection. */
export function appOfOpened(opened) {
  if (opened?.app) return opened.app
  if (opened?.kind === 'visual' && /^visual-[a-z0-9-]+$/.test(String(opened.adapter))) return opened.adapter.slice(7) // a visual check is filed under the app it checked
  const fromAdapter = String(opened?.adapter ?? '').split('-')[0]
  return APPS[fromAdapter] ? fromAdapter : null
}
