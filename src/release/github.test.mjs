// node --test src/release/github.test.mjs   (offline: gh is faked, nothing touches GitHub)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGithub, explain, normalize } from './github.mjs'

const row = (o = {}) => ({ name: 'app', owner: { login: 'me' }, nameWithOwner: 'me/app', description: 'A web app', isPrivate: false, isFork: false, isArchived: false, visibility: 'PUBLIC', pushedAt: '2026-10-01T10:00:00Z', primaryLanguage: { name: 'TypeScript' }, defaultBranchRef: { name: 'main' }, url: 'https://github.com/me/app', ...o })
const fakeGh = ({ rows = [row()], login = 'me', whoFail = null, listFail = null, calls = [] } = {}) => async args => {
  calls.push(args)
  if (args[0] === 'api') return whoFail ?? { code: 0, stdout: login + '\n', stderr: '' }
  return listFail ?? { code: 0, stdout: JSON.stringify(rows), stderr: '' }
}

test('a repo is normalised, sorted newest first, and the odd ones are handled', async () => {
  const gh = createGithub({ run: fakeGh({ rows: [
    row({ name: 'old', pushedAt: '2025-01-01T00:00:00Z' }),
    row({ name: 'new', pushedAt: '2026-10-20T00:00:00Z', isPrivate: true, visibility: 'PRIVATE', isFork: true }),
    row({ name: 'bare', primaryLanguage: null, description: null, defaultBranchRef: null, pushedAt: null }),
  ] }) })
  const r = await gh.repos()
  assert.equal(r.connected, true); assert.equal(r.login, 'me')
  assert.deepEqual(r.repos.map(x => x.name), ['new', 'old', 'bare'], 'newest push first, never-pushed last')
  assert.deepEqual([r.repos[0].private, r.repos[0].fork, r.repos[0].fullName], [true, true, 'me/new'])
  assert.deepEqual([r.repos[2].language, r.repos[2].description, r.repos[2].defaultBranch, r.repos[2].pushedAt], [null, '', null, null])
})

test('GitHub data is treated as untrusted: bad names are dropped, bad links removed, long text cut', () => {
  assert.equal(normalize(row({ name: '../x' })), null); assert.equal(normalize(row({ name: 'a b' })), null)
  assert.equal(normalize(row({ owner: { login: 'x/y' } })), null); assert.equal(normalize({}), null); assert.equal(normalize(null), null)
  assert.equal(normalize(row({ url: 'javascript:alert(1)' })).url, null)
  assert.equal(normalize(row({ url: 'https://evil.example/me/app' })).url, null)
  assert.equal(normalize(row({ url: 'https://github.com/me/app/../../x' })).url, null)
  assert.equal(normalize(row()).url, 'https://github.com/me/app')
  assert.equal(normalize(row({ description: 'x'.repeat(900) })).description.length, 300)
  assert.equal(normalize(row({ description: 'a\n\n  b' })).description, 'a b', 'one line')
  assert.equal(normalize(row({ pushedAt: 'not a date' })).pushedAt, null)
})

test('it only ever asks gh for two fixed read-only things, with no input from anywhere', async () => {
  const calls = []; await createGithub({ run: fakeGh({ calls }) }).repos()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], ['api', 'user', '--jq', '.login'])
  assert.deepEqual(calls[1].slice(0, 5), ['repo', 'list', '--limit', '200', '--json'])
  const allowedPairs = new Set(['api user', 'repo list']), allowedFlags = new Set(['--jq', '--limit', '--json'])
  for (const c of calls) {
    assert.ok(allowedPairs.has(c.slice(0, 2).join(' ')), `only read-only command pairs: ${c.slice(0, 2)}`)
    for (const a of c.filter(x => x.startsWith('-'))) assert.ok(allowedFlags.has(a), `only read-only flags: ${a}`)
    for (const a of c) assert.ok(!/^(-X|--method|-f|-F|--field|--raw-field|--input|--hostname|--paginate)$/.test(a), `no write-capable flag: ${a}`)
  }
  assert.match(calls[1][5], /^[A-Za-z,]+$/, 'the --json value is a plain list of field names')
})

test('not installed, not logged in, timeouts and odd errors become one clear sentence, never a token', () => {
  assert.match(explain({ missing: true }), /not installed/)
  assert.match(explain({ stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }), /not connected/)
  assert.match(explain({ stderr: 'HTTP 401: Bad credentials' }), /not connected/)
  assert.match(explain({ timedOut: true }), /did not answer in time/)
  const e = explain({ stderr: 'oops with token gho_ABCDEF1234567890abcdef and Bearer abc.def.ghi' })
  assert.ok(!/gho_ABC|abc\.def/.test(e)); assert.match(e, /\*\*\*\*/)
})

test('a failure reports why, lists nothing, and is not cached', async () => {
  let fail = { code: 1, stdout: '', stderr: 'To log in, run: gh auth login' }, calls = 0
  const gh = createGithub({ run: async a => { calls++; return fail.code && a[0] === 'api' ? fail : { code: 0, stdout: a[0] === 'api' ? 'me' : JSON.stringify([row()]), stderr: '' } } })
  const bad = await gh.repos(); assert.deepEqual([bad.connected, bad.repos.length], [false, 0]); assert.match(bad.error, /not connected/)
  fail = { code: 0 }; const ok = await gh.repos()
  assert.equal(ok.connected, true); assert.equal(ok.repos.length, 1, 'a refresh after logging in works immediately, nothing stale was kept')
})

test('a short cache: the second call is free, refresh asks again, and it expires', async () => {
  let t = 1000; const calls = []
  const gh = createGithub({ run: fakeGh({ calls }), ttlMs: 60_000, now: () => t })
  await gh.repos(); await gh.repos(); assert.equal(calls.length, 2, 'cached')
  await gh.repos({ refresh: true }); assert.equal(calls.length, 4, 'refresh asks again')
  t += 61_000; await gh.repos(); assert.equal(calls.length, 6, 'expired')
})

test('unreadable output from GitHub is reported, not thrown', async () => {
  const r = await createGithub({ run: async a => (a[0] === 'api' ? { code: 0, stdout: 'me', stderr: '' } : { code: 0, stdout: '<html>', stderr: '' }) }).repos()
  assert.equal(r.connected, true); assert.equal(r.repos.length, 0); assert.match(r.error, /unreadable/)
})
