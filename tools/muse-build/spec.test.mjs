// node --test tools/muse-build/spec.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFiles, parseSpec, pathProblem, scan, validateSpec } from './spec.mjs'

const SPEC = `---
part: demo
owns:
  - src/a/one.mjs
  - src/a/one.test.mjs
context: [docs/x.md, src/y.mjs]
test: node --test src/a/one.test.mjs
allow: [child_process]
---
Build it.
`

test('a spec header is read into lists and fields, and the body is kept', () => {
  const s = parseSpec(SPEC)
  assert.equal(s.part, 'demo'); assert.deepEqual(s.owns, ['src/a/one.mjs', 'src/a/one.test.mjs']); assert.deepEqual(s.context, ['docs/x.md', 'src/y.mjs'])
  assert.equal(s.test, 'node --test src/a/one.test.mjs'); assert.deepEqual(s.allow, ['child_process']); assert.equal(s.body, 'Build it.')
  assert.deepEqual(validateSpec(s), [])
  assert.throws(() => parseSpec('no header'), /must start with/)
})

test('paths are kept inside the repository and never reach environment files', () => {
  for (const bad of ['/etc/passwd', '../x.mjs', 'src/../../x', '.env', 'src/.env.local', 'node_modules/a.js', 'other/x.mjs', '']) assert.ok(pathProblem(bad), bad)
  for (const ok of ['src/a/b.mjs', 'docs/specs/x.md', 'bench/x.mjs', 'tools/muse-build/x.mjs']) assert.equal(pathProblem(ok), null, ok)
  const s = parseSpec(SPEC.replace('src/a/one.mjs', '.env').replace('node --test src/a/one.test.mjs', 'node x.mjs; rm -rf /'))
  const bad = validateSpec(s).join(' ')
  assert.match(bad, /environment files are never touched/); assert.match(bad, /no shell operators/)
})

test('file blocks are read from an answer, with an optional code fence removed', () => {
  const answer = 'Here you go.\n=== FILE: src/a/one.mjs ===\nexport const a = 1\n=== END FILE ===\ntext\n=== FILE: src/a/two.mjs ===\n```js\nexport const b = 2\n```\n=== END FILE ===\n'
  assert.deepEqual(parseFiles(answer), [{ path: 'src/a/one.mjs', content: 'export const a = 1\n' }, { path: 'src/a/two.mjs', content: 'export const b = 2\n' }])
  assert.deepEqual(parseFiles('nothing here'), [])
})

test('the scan flags risky patterns unless the spec allows them', () => {
  const f = [{ path: 'src/a.mjs', content: "import { execFile } from 'node:child_process'\nrmSync(x)\nfetch('https://evil.example/x')\nconst k = process.env.KEY" }]
  assert.deepEqual(scan(f).map(x => x.pattern).sort(), ['child_process', 'deletes', 'env_files', 'external_network'])
  assert.deepEqual(scan(f, ['child_process', 'deletes', 'env_files', 'external_network']), [])
  assert.deepEqual(scan([{ path: 'a', content: "fetch('http://127.0.0.1:8300/')" }]), [])
})
