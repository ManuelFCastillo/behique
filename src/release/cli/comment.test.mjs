// node --test src/release/cli/comment.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { MARKER, commentBody, createArgs, listArgs, postComment, updateArgs } from './comment.mjs'

const result = { app: 'umami', good: 'v3.3.1', cand: 'v3.4.1', caseId: 'c1', recommendation: 'hold', word: 'HOLD', summary: '1 reproduced behaviour change', failReason: null, counts: { findings: 1, confirmed: 1, visible: 1, churn: 0 }, findings: [{ id: 'R1', cls: 'visible', label: 'a person would notice', why: 'text a person reads', where: 'div[1]/p[1]', what: 'text', was: 'a', now: 'b', verdict: 'confirmed' }], masked: null, culprit: null, bisect: null, report: null, exitCode: 1 }

test('the body starts with the marker so the comment can be found and updated', () => {
  const body = commentBody(result)
  assert.ok(body.startsWith(MARKER + '\n## Behique recommends HOLD'))
})

test('gh arguments are fixed and every value is validated', () => {
  assert.deepEqual(listArgs({ repo: 'owner/repo', pr: 12 }), ['api', 'repos/owner/repo/issues/12/comments', '--paginate', '--jq', `.[] | select(.body | startswith("${MARKER}")) | .id`])
  assert.deepEqual(createArgs({ repo: 'owner/repo', pr: 12, bodyFile: '/tmp/b.md' }), ['api', '-X', 'POST', 'repos/owner/repo/issues/12/comments', '-F', 'body=@/tmp/b.md'])
  assert.deepEqual(updateArgs({ repo: 'owner/repo', id: 99, bodyFile: '/tmp/b.md' }), ['api', '-X', 'PATCH', 'repos/owner/repo/issues/comments/99', '-F', 'body=@/tmp/b.md'])
  for (const bad of ['owner', 'owner/repo/x', '-H/x', 'a b/c', '']) assert.throws(() => listArgs({ repo: bad, pr: 1 }), /owner\/name/, bad)
  for (const bad of [0, -1, 1.5, '12', null]) assert.throws(() => listArgs({ repo: 'o/r', pr: bad }), /positive whole number/)
  assert.throws(() => createArgs({ repo: 'o/r', pr: 1, bodyFile: '--flag' }), /path/)
  assert.throws(() => updateArgs({ repo: 'o/r', id: 1, bodyFile: '' }), /path/)
})

test('postComment updates the existing marked comment, else creates one; failures are plain and nothing throws', async () => {
  const calls = []
  const fake = replies => async args => { calls.push(args); return replies.shift() }
  const writeBody = async text => { assert.ok(text.startsWith(MARKER)); return '/tmp/body.md' }
  let r = await postComment({ repo: 'o/r', pr: 5, result, run: fake([{ code: 0, stdout: '4242\n', stderr: '' }, { code: 0, stdout: '{"id":4242}', stderr: '' }]), writeBody })
  assert.deepEqual(r, { ok: true, action: 'updated', id: 4242 })
  assert.equal(calls[1][2], 'PATCH'); assert.equal(calls[1][3], 'repos/o/r/issues/comments/4242')
  calls.length = 0
  r = await postComment({ repo: 'o/r', pr: 5, result, run: fake([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '{"id":7}', stderr: '' }]), writeBody })
  assert.deepEqual(r, { ok: true, action: 'created', id: 7 })
  assert.equal(calls[1][2], 'POST')
  r = await postComment({ repo: 'o/r', pr: 5, result, run: fake([{ code: 1, stdout: '', stderr: 'HTTP 404: Not Found' }]), writeBody })
  assert.equal(r.ok, false); assert.match(r.error, /could not list.*404/)
  r = await postComment({ repo: 'o/r', pr: 5, result, run: fake([{ code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'HTTP 403' }]), writeBody })
  assert.equal(r.ok, false); assert.match(r.error, /could not create.*403/)
  r = await postComment({ repo: 'bad repo', pr: 5, result, run: fake([]), writeBody })
  assert.equal(r.ok, false); assert.match(r.error, /owner\/name/)
})
