// node --test src/release/cli/result.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCase } from '../evidence.mjs'
import { buildViewModel } from '../viewmodel.mjs'
import { EXIT, caseIdFrom, exitCodeOf, markdownOf, parseCheckArgs, resultOf } from './result.mjs'

test('parseCheckArgs: the three names, the options, and plain refusals', () => {
  const p = parseCheckArgs(['umami', 'v3.3.1', 'v3.4.1', '--bisect', '--max-findings', '3', '--recrawl', '--json', '--out', 'r.json', '--timeout-min', '20'])
  assert.equal(p.ok, true); assert.deepEqual([p.app, p.good, p.cand], ['umami', 'v3.3.1', 'v3.4.1'])
  assert.deepEqual(p.options, { bisect: true, recrawl: true, explain: false, ai: false, aiTests: false, aiFlows: false, aiDescribe: false, aiTriage: false, aiCanvas: false, aiBudget: 0.25, maxFindings: 3, profile: null, repo: null, out: 'r.json', timeoutMin: 20, dashboard: 'http://127.0.0.1:8790', json: true })
  assert.equal(parseCheckArgs(['a', 'b', 'c', '--no-dashboard']).options.dashboard, null)
  assert.equal(parseCheckArgs(['a', 'b', 'c', '--bisect', '--explain']).options.explain, true)
  const ai = parseCheckArgs(['a', 'b', 'c', '--ai', '--ai-tests', '--ai-flows', '--ai-describe', '--ai-triage', '--ai-canvas', '--ai-budget', '0.5']).options
  assert.deepEqual([ai.ai, ai.aiTests, ai.aiFlows, ai.aiDescribe, ai.aiTriage, ai.aiCanvas, ai.aiBudget], [true, true, true, true, true, true, 0.5])
  for (const v of ['0', '-1', 'x', '11']) assert.equal(parseCheckArgs(['a', 'b', 'c', '--ai-budget', v]).ok, false, v)
  assert.equal(parseCheckArgs(['a', 'b', 'c', '--dashboard', 'https://ci.example.com']).options.dashboard, 'https://ci.example.com')
  for (const [argv, re] of [
    [['umami', 'v1'], /Usage/], [['Umami', 'v1', 'v2'], /lower-case/], [['umami', '-rf', 'v2'], /not a git/], [['umami', 'v1', 'v1'], /same/],
    [['umami', 'v1', 'v2', '--max-findings', '0'], /1 to 20/], [['umami', 'v1', 'v2', '--max-findings'], /needs a value/], [['umami', 'v1', 'v2', '--profile', 'p.json'], /--repo/],
    [['umami', 'v1', 'v2', '--dashboard', 'ftp://x'], /origin/], [['umami', 'v1', 'v2', '--wat'], /Unknown option/], [['umami', 'v1', 'v2', '--timeout-min', '9999'], /1 to 600/], [['umami', 'v1', 'v2', '--explain'], /--explain needs --bisect/],
  ]) { const r = parseCheckArgs(argv); assert.equal(r.ok, false, argv.join(' ')); assert.match(r.error, re) }
})

test('caseIdFrom takes the last evidence line and ignores anything that is not a case id', () => {
  assert.equal(caseIdFrom(['x', 'evidence: 20261031T184304Z_v3.3.1-vs-v3.4.1', 'y']), '20261031T184304Z_v3.3.1-vs-v3.4.1')
  assert.equal(caseIdFrom(['evidence: a', 'evidence: 20261031T184304Z_v1-vs-v2']), '20261031T184304Z_v1-vs-v2')
  assert.equal(caseIdFrom(['evidence: ../../etc']), null); assert.equal(caseIdFrom([]), null); assert.equal(caseIdFrom(null), null)
})

function caseWith(notices, { bisect = false, masked = true } = {}) {
  const c = openCase(mkdtempSync(join(tmpdir(), 'cli-')))
  c.event('case.opened', { goodRef: 'v3.3.1', candRef: 'v3.4.1', adapter: 'umami', app: 'umami', steps: [], scenario: null })
  c.event('builds.compared', { good: { ref: 'v3.3.1', sha: 'aaaaaaa111' }, candidate: { ref: 'v3.4.1', sha: 'bbbbbbb222' } })
  if (masked) c.event('masking.summary', { masked: 12, total: 300, learned: 0, areas: [{ area: 'body/div[1]/nav[1]', count: 9 }] })
  const facts = c.artifact('facts-diff.json', { control: [], candidate: [] })
  c.claim('verified_fact', 'values changed', { evidence: [facts] })
  notices.forEach((n, k) => {
    const id = `R${k + 1}`
    c.event('test.exported', { id, fact: n.fact, i: 1, good: JSON.stringify(n.was), candidate: JSON.stringify(n.now), notice: { cls: n.cls, why: n.why } })
    const spec = c.artifact(`${id}.spec.js`, 'x')
    c.event('test.judged', { id, verdict: n.verdict ?? 'confirmed', goodPassed: 3, candFailed: 3, runs: 3, notice: { cls: n.cls, why: n.why } })
    if ((n.verdict ?? 'confirmed') === 'confirmed') c.claim('reproduced_failure', `test ${id} passes on old and fails on new`, { evidence: [spec] })
  })
  if (bisect) {
    const bis = c.artifact('bisect.json', { result: { conclusive: true, verified: true, commit: 'cccccccfff', subject: 'Encode the share url (#9146)', author: 'A', date: '2026-01-01', files: ['a.js'], changes: 227, steps: 8, url: 'https://github.com/x/y/commit/cccccccfff' }, log: ['bisect: 227 changes between a and b', '  bisect step 1: aaaaaaa (#113 of 227) good | s', 'bisect: first bad change is #62 of 227, found in 8 steps'] })
    c.claim('reproduced_failure', 'first bad change is ccccccc. The change just before it passed 3 of 3 runs and it failed 3 of 3 runs.', { evidence: [bis] })
  }
  c.event('case.closed', { outcome: 'regression proven' })
  return c
}

test('resultOf: a HOLD with a noticeable change and a bisect, as JSON, Markdown and exit code', () => {
  const c = caseWith([
    { fact: 'body/div[1]/label[1]@for', cls: 'churn', why: 'a generated id (for)', was: '_r_1_', now: '_r_2_' },
    { fact: 'body/div[1]/a[1]@data-url', cls: 'visible', why: 'a link carried in data-url', was: 'http://x/i/?a=1', now: 'http%3A%2F%2Fx' },
  ], { bisect: true })
  const caseId = '20261031T184304Z_v3.3.1-vs-v3.4.1'
  const r = resultOf(buildViewModel(c, { caseId }), { caseId, dashboard: 'http://127.0.0.1:8790' })
  assert.equal(r.recommendation, 'hold'); assert.equal(r.word, 'HOLD'); assert.equal(r.exitCode, 1); assert.equal(exitCodeOf(r), 1)
  assert.deepEqual(r.counts, { findings: 2, confirmed: 2, visible: 1, churn: 1 })
  assert.deepEqual(r.findings.map(f => [f.id, f.cls]), [['R2', 'visible'], ['R1', 'churn']], 'most noticeable first')
  assert.equal(r.culprit.sha, 'cccccccfff'); assert.equal(r.bisect.changes, 227)
  assert.equal(r.masked, '12 of 300 recorded facts (4.0%) were masked as noise, mostly under body/div[1]/nav[1] (9). A change inside a masked fact cannot be seen by this check.')
  assert.equal(r.report.dashboard, 'http://127.0.0.1:8790/dashboard?app=umami&case=20261031T184304Z_v3.3.1-vs-v3.4.1')
  assert.equal(r.report.full, 'http://127.0.0.1:8790/report?case=20261031T184304Z_v3.3.1-vs-v3.4.1')
  const md = markdownOf(r)
  assert.match(md, /^## Behique recommends HOLD: umami v3.3.1 \(good\) vs v3.4.1 \(candidate\)\n/)
  assert.match(md, /\| R2 \| a person would notice \(a link carried in data-url\) \| data-url \| `div\[1\]\/a\[1\]` \| `http:\/\/x\/i\/\?a=1` \| `http%3A%2F%2Fx` \| confirmed \|/)
  assert.match(md, /\| R1 \| markup churn \(a generated id \(for\)\)/)
  assert.ok(md.indexOf('| R2 |') < md.indexOf('| R1 |'))
  assert.match(md, /\*\*First change that makes the test fail:\*\* \[ccccccc\]\(https:\/\/github.com\/x\/y\/commit\/cccccccfff\) Encode the share url \(#9146\) \(A, 2026-01-01\), 227 commits bisected in 8 steps/)
  assert.match(md, /\*\*Not seen by this check:\*\* 12 of 300/)
  assert.match(md, /Report: \[dashboard\]\(http:\/\/127.0.0.1:8790\/dashboard\?app=umami&case=20261031T184304Z_v3.3.1-vs-v3.4.1\)/)
  assert.match(md, /A person decides\.\n$/)
  assert.ok(!md.includes('\n\n\n'), 'no blank runs')
})

test('resultOf: churn only is SHIP with exit 0 and the note; no dashboard means no links; a pipe in a value cannot break the table', () => {
  const c = caseWith([{ fact: 'body/div[1]/button[1]@data-slot', cls: 'churn', why: 'a framework attribute (data-slot)', was: 'button', now: 'input|group' }], { masked: false })
  const r = resultOf(buildViewModel(c, { caseId: 'x_v1-vs-v2' }), { caseId: 'x_v1-vs-v2' })
  assert.equal(r.recommendation, 'ship'); assert.equal(r.exitCode, 0); assert.equal(r.report, null); assert.equal(r.masked, null, 'an older case without a masking summary says nothing about masking')
  const md = markdownOf(r)
  assert.match(md, /Behique recommends SHIP/); assert.match(md, /Only markup churn changed: 1 proven change/); assert.match(md, /`input\|group`/); assert.match(md, /Case `x_v1-vs-v2` in out\/evidence/)
  assert.ok(!md.includes('Not seen by this check'))
  assert.deepEqual(EXIT, { ship: 0, hold: 1, inconclusive: 2, fail: 3, running: 3 })
  assert.equal(exitCodeOf({ recommendation: 'nonsense' }), 3)
  assert.throws(() => resultOf(null), /view-model/)
})

test('an AI explanation is in the result and the comment, labelled a guess, and the verdict and exit code do not move', () => {
  const c = caseWith([{ fact: 'body/div[1]/a[1]@data-url', cls: 'visible', why: 'a link carried in data-url', was: 'http://x/i/?a=1', now: 'http%3A%2F%2Fx' }], { bisect: true })
  const caseId = '20261031T184304Z_v3.3.1-vs-v3.4.1'
  const before = resultOf(buildViewModel(c, { caseId }), { caseId })
  assert.equal(before.explanation, null)
  assert.match(markdownOf(before), /A model proposes nothing here/)
  c.claim('ai_hypothesis', 'The link is now passed through encodeURIComponent, so the attribute holds the escaped form.', { by: 'model', model: 'muse-spark-1.3', extra: { grounded: true, quote: '.replace(/--link--/g, encodeURIComponent(link))', confidence: 'medium', howToCheck: 'Open the share dialog and compare the copied link.', estUsd: 0.0061 } })
  const r = resultOf(buildViewModel(c, { caseId }), { caseId })
  assert.deepEqual(r.explanation, { label: 'ai_hypothesis', model: 'muse-spark-1.3', hypothesis: 'The link is now passed through encodeURIComponent, so the attribute holds the escaped form.', quote: '.replace(/--link--/g, encodeURIComponent(link))', quoteFound: true, confidence: 'medium', howToCheck: 'Open the share dialog and compare the copied link.', estUsd: 0.0061 })
  assert.equal(r.recommendation, before.recommendation); assert.equal(r.exitCode, before.exitCode); assert.deepEqual(r.findings, before.findings)
  const md = markdownOf(r)
  assert.match(md, /\*\*AI guess, not proof\*\* \(muse-spark-1\.3, medium confidence; asked about the change above only\): The link is now passed through encodeURIComponent/)
  assert.match(md, /which is in the diff: `\.replace\(\/--link--\/g, encodeURIComponent\(link\)\)`/)
  assert.match(md, /To check it: Open the share dialog/); assert.match(md, /One model call, about \$0\.0061 \(estimated\)\./)
  assert.ok(md.indexOf('**First change that makes the test fail:**') < md.indexOf('**AI guess, not proof**'), 'the proven culprit comes before the guess')
  assert.match(md, /the AI guess is the only part a model wrote, and it proves nothing\. A person decides\.\n$/)
  assert.ok(!md.includes('A model proposes nothing here'))
})

test('an ungrounded quote is flagged, and a skipped explanation says why without touching the verdict', () => {
  const c = caseWith([{ fact: 'body/div[1]/a[1]@data-url', cls: 'visible', why: 'w', was: 'a', now: 'b' }], { bisect: true })
  c.claim('ai_hypothesis', 'A guess.', { by: 'model', model: 'm', extra: { grounded: false, quote: 'made up line here', confidence: 'low' } })
  const r = resultOf(buildViewModel(c, { caseId: 'x_v1-vs-v2' }), { caseId: 'x_v1-vs-v2' })
  assert.match(markdownOf(r), /which \*\*is NOT\*\* in the diff/)
  const plain = resultOf(buildViewModel(caseWith([], { bisect: false }), { caseId: 'x_v1-vs-v2' }), { caseId: 'x_v1-vs-v2' })
  const md = markdownOf({ ...plain, explanationSkipped: 'No API key is set for meta, so nothing can be sent.' })
  assert.match(md, /No AI explanation was added: No API key is set for meta/)
  assert.ok(!markdownOf(plain).includes('No AI explanation'), 'nothing is said when --explain was not asked for')
})
