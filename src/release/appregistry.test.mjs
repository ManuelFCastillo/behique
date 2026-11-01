// node --test src/release/appregistry.test.mjs   (offline)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appOfOpened, builtinApps, listApps } from './appregistry.mjs'
import { createGithub } from './github.mjs'

const gh = (rows, login = 'me') => createGithub({ run: async a => (a[0] === 'api' ? { code: 0, stdout: login, stderr: '' } : { code: 0, stdout: JSON.stringify(rows), stderr: '' }) })
const r = (name, extra = {}) => ({ name, owner: { login: 'me' }, description: 'd', isPrivate: true, isFork: false, isArchived: false, pushedAt: '2026-01-01T00:00:00Z', primaryLanguage: { name: 'Go' }, defaultBranchRef: { name: 'main' }, url: `https://github.com/me/${name}`, ...extra })

test('FreshRSS is built in, first, and ready; GitHub repos follow and are honestly not runnable', async () => {
  const { apps, github } = await listApps({ github: gh([r('alpha'), r('beta', { isFork: true, isPrivate: false })]) })
  assert.equal(apps[0].id, 'freshrss'); assert.equal(apps[0].kind, 'builtin'); assert.equal(apps[0].runnable, true)
  const repos = apps.slice(1); assert.equal(repos.length, 2)
  for (const a of repos) { assert.equal(a.kind, 'github'); assert.equal(a.runnable, false); assert.equal(a.status, 'needs-setup'); assert.match(a.statusText, /Needs setup/); assert.ok(a.id.startsWith('github:me/')) }
  assert.deepEqual([github.connected, github.login, github.count], [true, 'me', 2])
  assert.equal(new Set(apps.map(a => a.id)).size, apps.length, 'ids are unique')
  assert.equal(repos.find(a => a.label === 'beta').subtitle, 'public · Go · fork')
})

test('when GitHub is not connected the built-in app still works and the reason is shown', async () => {
  const off = createGithub({ run: async () => ({ code: 1, stdout: '', stderr: 'gh auth login', missing: false }) })
  const { apps, github } = await listApps({ github: off })
  assert.deepEqual(apps.map(a => a.id), ['freshrss']); assert.equal(github.connected, false); assert.match(github.error, /not connected/)
  assert.deepEqual((await listApps({})).apps.map(a => a.id), ['freshrss'], 'no GitHub reader at all is fine')
})

test('a report belongs to the right app', () => {
  assert.equal(appOfOpened({ adapter: 'freshrss' }), 'freshrss'); assert.equal(appOfOpened({ adapter: 'freshrss-scroll' }), 'freshrss')
  assert.equal(appOfOpened({ adapter: 'freshrss', app: 'github:me/alpha' }), 'github:me/alpha', 'an explicit app wins')
  assert.equal(appOfOpened({ adapter: 'mystery' }), null); assert.equal(appOfOpened(null), null)
})

test('built-in apps carry what the sidebar needs', () => {
  for (const a of builtinApps()) assert.ok(a.id && a.label && a.statusText && typeof a.runnable === 'boolean')
})

test('an app Behique set up itself is listed as ready, and its visual reports are filed under it', async () => {
  const { profileApp } = await import('./appregistry.mjs')
  const a = profileApp({ name: 'musicblocks', defaults: { good: 'v1', cand: 'v2' }, regions: { top: { x: 0, y: 0, w: 1, h: 1 } } })
  assert.equal(a.runnable, true); assert.equal(a.status, 'ready'); assert.equal(a.visual, true); assert.deepEqual(a.regions, ['top'])
  const l = await listApps({ profiles: [{ name: 'musicblocks' }] })
  assert.deepEqual(l.apps.map(x => x.id).slice(0, 2), ['freshrss', 'musicblocks'])
  assert.equal(appOfOpened({ kind: 'visual', adapter: 'visual-musicblocks' }), 'musicblocks')
  assert.equal(appOfOpened({ kind: 'visual', adapter: 'visual-../x' }), null, 'only plain names')
})

test('a repo already cloned into the apps folder says so, and still needs setup', async () => {
  const { apps } = await listApps({ github: gh([r('alpha'), r('beta')]), cloned: name => (name === 'alpha' ? '/apps/alpha' : null) })
  const alpha = apps.find(a => a.label === 'alpha'), beta = apps.find(a => a.label === 'beta')
  assert.equal(alpha.cloned, '/apps/alpha'); assert.equal(alpha.runnable, false); assert.equal(alpha.status, 'needs-setup')
  assert.match(alpha.statusText, /^Cloned, needs setup/); assert.equal(alpha.subtitle, 'private · Go · cloned')
  assert.equal(beta.cloned, null); assert.match(beta.statusText, /^Needs setup/)
  const { apps: safe } = await listApps({ github: gh([r('alpha')]), cloned: () => { throw new Error('disk') } })
  assert.equal(safe.find(a => a.label === 'alpha').cloned, null, 'a failing lookup never breaks the list')
})
