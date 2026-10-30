// node --test tools/muse-build/build.test.mjs   (offline: a fake model and a fake test runner, in a temp repository)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildMessages, runBuild } from './build.mjs'

const llm = { estCost: (pt, ct) => pt * 1.25e-6 + ct * 4.25e-6, PROVIDERS: { meta: { model: 'fake-muse' } } }
const SPEC = (extra = '') => `---\npart: demo\nowns:\n  - src/demo/a.mjs\n  - src/demo/a.test.mjs\ncontext:\n  - docs/ctx.md\ntest: node --test src/demo/a.test.mjs\n${extra}---\nBuild a.\n`
function repo(specText = SPEC()) {
  const root = mkdtempSync(join(tmpdir(), 'muse-build-'))
  mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(join(root, 'src/demo'), { recursive: true })
  writeFileSync(join(root, 'docs/ctx.md'), 'context text'); writeFileSync(join(root, 'docs/specs/demo.md'), specText)
  return root
}
const answer = files => files.map(([p, c]) => `=== FILE: ${p} ===\n${c}\n=== END FILE ===`).join('\n')
const good = [['src/demo/a.mjs', 'export const a = 1'], ['src/demo/a.test.mjs', 'export const t = 1']]
const opts = root => ({ specPath: 'docs/specs/demo.md', root, maxCost: 5 })

test('a dry run reads the spec, shows a projection and sends nothing', async () => {
  const root = repo(); let asked = 0
  const r = await runBuild({ ...opts(root), dryRun: true }, { llm, ask: async () => { asked++ } })
  assert.equal(r.code, 0); assert.equal(asked, 0); assert.match(r.lines.join('\n'), /2 files to write, 1 context files.*projection for one round/s); assert.match(r.lines.at(-1), /dry run/)
})

test('only owned files are written, the rest are rejected, and a passing test ends the build', async () => {
  const root = repo(); let tested = 0
  const r = await runBuild(opts(root), { llm, ask: async () => ({ text: answer([...good, ['src/other.mjs', 'x']]), pt: 1000, ct: 500 }), runTest: async () => { tested++; return { code: 0, output: 'ok' } } })
  assert.equal(r.code, 0); assert.equal(tested, 1); assert.equal(existsSync(join(root, 'src/other.mjs')), false)
  assert.equal(readFileSync(join(root, 'src/demo/a.mjs'), 'utf8'), 'export const a = 1\n')
  assert.deepEqual(r.report.rounds[0].rejected, [{ path: 'src/other.mjs', why: 'not an owned file' }]); assert.equal(r.report.passed, true)
  assert.ok(readdirSync(join(root, 'out/muse-build')).some(f => f.startsWith('demo-')))
})

test('a failing test sends its output back and the next round can fix it', async () => {
  const root = repo(); const seen = []
  let n = 0
  const ask = async messages => { seen.push(messages.map(m => m.content).join('\n')); return { text: answer(good), pt: 800, ct: 400 } }
  const r = await runBuild(opts(root), { llm, ask, runTest: async () => (++n === 1 ? { code: 1, output: 'AssertionError: nope' } : { code: 0, output: 'ok' }) })
  assert.equal(r.code, 0); assert.equal(seen.length, 2); assert.match(seen[1], /AssertionError: nope/); assert.match(seen[1], /Your previous attempt wrote these files/)
})

test('risky patterns the spec did not allow stop the build before any test runs, and --run-only runs it after review', async () => {
  const root = repo(); let tested = 0
  const risky = [['src/demo/a.mjs', "import { rmSync } from 'node:fs'\nrmSync('/x')"], good[1]]
  const r = await runBuild(opts(root), { llm, ask: async () => ({ text: answer(risky), pt: 1, ct: 1 }), runTest: async () => { tested++; return { code: 0, output: '' } } })
  assert.equal(r.code, 1); assert.equal(tested, 0); assert.match(r.lines.join('\n'), /NOT running the tests/); assert.equal(r.report.status, 'needs review')
  const again = await runBuild({ ...opts(root), runOnlyFlag: true }, { llm, runTest: async () => { tested++; return { code: 0, output: '' } } })
  assert.equal(again.code, 0); assert.equal(tested, 1)
  // allowed by the spec: the same code goes through to the tests
  const root2 = repo(SPEC('allow: [deletes]\n'))
  const ok = await runBuild(opts(root2), { llm, ask: async () => ({ text: answer(risky), pt: 1, ct: 1 }), runTest: async () => ({ code: 0, output: '' }) })
  assert.equal(ok.code, 0)
})

test('the cost cap stops the loop before a round that could pass it', async () => {
  const root = repo(); let asked = 0
  const r = await runBuild({ ...opts(root), maxCost: 0.02 }, { llm, ask: async () => { asked++; return { text: answer(good), pt: 20000, ct: 2000 } }, runTest: async () => ({ code: 1, output: 'no' }) })
  assert.equal(r.code, 1); assert.ok(asked <= 1); assert.equal(r.report.status, 'cost cap')
})

test('a spec that owns an environment file, or lists a missing context file, is refused before anything is sent', async () => {
  const root = repo(SPEC().replace('src/demo/a.mjs', '.env')); let asked = 0
  const r = await runBuild(opts(root), { llm, ask: async () => { asked++ } })
  assert.equal(r.code, 2); assert.equal(asked, 0); assert.match(r.lines.join('\n'), /environment files are never touched/)
  const root2 = repo(SPEC().replace('docs/ctx.md', 'docs/missing.md'))
  assert.match((await runBuild(opts(root2), { llm })).lines.join('\n'), /context files not found: docs\/missing\.md/)
})

test('a tracked file with uncommitted changes is not overwritten without --force', async () => {
  const root = repo(); const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' })
  g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'a'); writeFileSync(join(root, 'src/demo/a.mjs'), 'old\n'); g('add', '-A'); g('commit', '-q', '-m', 'x')
  writeFileSync(join(root, 'src/demo/a.mjs'), 'my hand edit\n')
  const r = await runBuild(opts(root), { llm, ask: async () => ({ text: answer(good), pt: 1, ct: 1 }), runTest: async () => ({ code: 0, output: '' }) })
  assert.equal(readFileSync(join(root, 'src/demo/a.mjs'), 'utf8'), 'my hand edit\n'); assert.match(JSON.stringify(r.report.rounds[0].rejected), /uncommitted changes/)
  await runBuild({ ...opts(root), force: true }, { llm, ask: async () => ({ text: answer(good), pt: 1, ct: 1 }), runTest: async () => ({ code: 0, output: '' }) })
  assert.equal(readFileSync(join(root, 'src/demo/a.mjs'), 'utf8'), 'export const a = 1\n')
})

test('the prompt carries the spec, the owned file list, the acceptance command and the context, and never a long dash instruction in reverse', () => {
  const m = buildMessages({ part: 'p', body: 'BODY', owns: ['src/a.mjs'], test: 'node --test x', context: [] }, [{ path: 'docs/c.md', content: 'CTX' }])
  const text = m.map(x => x.content).join('\n')
  assert.match(text, /BODY/); assert.match(text, /src\/a\.mjs/); assert.match(text, /node --test x/); assert.match(text, /--- docs\/c\.md ---\nCTX/); assert.equal(m[0].role, 'system')
})
