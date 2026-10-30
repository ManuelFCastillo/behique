// Tests for runOnboard with fakes only.
//   node --test src/release/onboard/onboard.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnboard } from './onboard.mjs'

function goodProfile() {
  return { name: 'x', repo: '/tmp/r', workRoot: '/tmp/w', serve: { kind: 'static' } }
}

function baseDeps(over = {}) {
  return {
    inspectRepo: async (repoPath) => ({
      path: repoPath, isGit: true, tags: ['v1'], branch: 'main',
      headSubject: 'hi', topLevel: ['index.html'], packageJson: { name: 'a', scripts: { start: 'x' } },
      lockfile: null, hasIndexHtml: true, hasDockerfile: false, hasMakefile: false, readme: null,
    }),
    proposeProfile: async () => ({ profile: goodProfile(), problems: [], usage: { pt: 10, ct: 10 }, raw: '{}', messages: [] }),
    verifyProfile: async () => ({ ok: true, checks: [{ name: 'builds the good version', ok: true, detail: 'abc in 1.0s' }], floor: { n: 3, changed: 0 } }),
    saveProfile: (p) => `/tmp/profiles/${p.name}.json`,
    describeCommands: (p) => ['serve: built-in static file server'],
    ask: async () => ({ text: '{}', pt: 1, ct: 1 }),
    skillText: 'skill',
    writeFile: (path, content) => {},
    now: () => 0,
    ...over,
  }
}

function baseOptions(over = {}) {
  return { repoPath: '/tmp/r', name: 'demo', good: 'v1', cand: 'v2', ...over }
}

test('usage errors give code 2', async () => {
  const res = await runOnboard({ name: 'demo' }, baseDeps())
  assert.equal(res.code, 2)
  assert.match(res.lines.join('\n').toLowerCase(), /usage/)
})

test('dry-run calls neither ask nor verifyProfile', async () => {
  let asked = 0
  let verified = 0
  const deps = baseDeps({ ask: async () => { asked += 1 }, verifyProfile: async () => { verified += 1 } })
  const res = await runOnboard(baseOptions({ propose: true, dryRun: true }), deps)
  assert.equal(res.code, 0)
  assert.equal(asked, 0)
  assert.equal(verified, 0)
  assert.match(res.lines.join('\n').toLowerCase(), /cost/)
})

test('proposal over the cost cap is refused', async () => {
  let proposed = 0
  const deps = baseDeps({ proposeProfile: async () => { proposed += 1 } })
  const res = await runOnboard(baseOptions({ propose: true, maxCost: 0 }), deps)
  assert.equal(res.code, 2)
  assert.equal(proposed, 0)
})

test('proposal with problems stops with code 1 and saves nothing', async () => {
  let saved = 0
  const deps = baseDeps({
    proposeProfile: async () => ({ profile: goodProfile(), problems: ['bad serve'], usage: { pt: 1, ct: 1 }, raw: '{}', messages: [] }),
    saveProfile: () => { saved += 1 },
  })
  const res = await runOnboard(baseOptions({ propose: true, approve: true, maxCost: 999 }), deps)
  assert.equal(res.code, 1)
  assert.equal(saved, 0)
})

test('without approve nothing is verified and nothing is saved', async () => {
  let verified = 0
  let saved = 0
  const deps = baseDeps({
    verifyProfile: async () => { verified += 1 },
    saveProfile: () => { saved += 1 },
  })
  const res = await runOnboard(baseOptions({ propose: true, maxCost: 999 }), deps)
  assert.equal(res.code, 0)
  assert.equal(verified, 0)
  assert.equal(saved, 0)
})

test('with approve and passing report the profile is saved once', async () => {
  let saved = 0
  const deps = baseDeps({ saveProfile: (p) => { saved += 1; return `/p/${p.name}.json` } })
  const res = await runOnboard(baseOptions({ propose: true, approve: true, maxCost: 999 }), deps)
  assert.equal(res.code, 0)
  assert.equal(saved, 1)
  assert.match(res.lines.join('\n'), /saved profile to/)
})

test('with failing report it is not saved and code is 1', async () => {
  let saved = 0
  const deps = baseDeps({
    verifyProfile: async () => ({ ok: false, checks: [{ name: 'builds the good version', ok: false, detail: 'boom' }], floor: null }),
    saveProfile: () => { saved += 1 },
  })
  const res = await runOnboard(baseOptions({ propose: true, approve: true, maxCost: 999 }), deps)
  assert.equal(res.code, 1)
  assert.equal(saved, 0)
  assert.match(res.lines.join('\n').toLowerCase(), /not saved/)
})

test('command list is printed before anything is verified', async () => {
  const order = []
  const deps = baseDeps({
    describeCommands: (p) => { order.push('describe'); return ['serve: x'] },
    verifyProfile: async () => { order.push('verify'); return { ok: true, checks: [], floor: null } },
    saveProfile: () => '/p/x.json',
  })
  const res = await runOnboard(baseOptions({ propose: true, approve: true, maxCost: 999 }), deps)
  assert.deepEqual(order, ['describe', 'verify'])
  const idx = res.lines.findIndex((l) => l.includes('Commands this profile would run:'))
  assert.ok(idx >= 0)
})

test('profile file with invalid content gives code 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-'))
  const file = join(dir, 'bad.json')
  writeFileSync(file, JSON.stringify({ name: 'BAD NAME', repo: '', workRoot: '', serve: {} }), 'utf8')
  const res = await runOnboard(baseOptions({ profile: file }), baseDeps())
  assert.equal(res.code, 2)
})
