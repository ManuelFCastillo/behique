// node --test src/release/aitest.test.mjs   (offline: no model is called, no app is built; the model and the test runner are fakes)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { specSource } from '../export.mjs'
import { openCase } from './evidence.mjs'
import { SENTINEL, assembleSource, buildMessages, checkTestSource, findingsOf, nearbyChanges, parseProposal, preludeOf, probeSource, referenceOf, repairMessages, run, scanCode, stepsOf, verifiedItems, worstCase } from './aitest.mjs'

const BODY = `// open the first post, then the share menu
await page.getByText('First post').click()
await page.locator('.flux.current a[href^="#dropdown-share"]').click()
// the clipboard item keeps the readable link
await expect(page.getByRole('button', { name: 'Clipboard' })).toHaveAttribute('data-url', 'https://example.com/posts/first?utm=1&ref=a%20b')`

const reply = (name, body, reason = 'The share menu now copies an encoded link.') => `NAME: ${name}\nREASON: ${reason}\n<test_body>\n${body}\n</test_body>`

test('a reply is read in the NAME, REASON, test_body format, or from a fenced block; anything else is refused with a reason', () => {
  const p = parseProposal(reply('Share link is no longer readable', BODY))
  assert.equal(p.ok, true); assert.equal(p.name, 'Share link is no longer readable'); assert.match(p.body, /^\/\/ open the first post/); assert.match(p.reason, /encoded link/)
  assert.equal(parseProposal('NAME: x y\n```js\nawait page.click("a")\n```').body, 'await page.click("a")')
  assert.equal(parseProposal('NAME: n\nREASON: r\n```test_body\nawait page.click("a")\n</test_body>').body, 'await page.click("a")', 'a labelled fence closed by the tag')
  assert.equal(parseProposal('NAME: n\nREASON: r\n```test_body\nawait page.click("a")\n```').body, 'await page.click("a")')
  assert.equal(parseProposal('REASON: nope\n<test_body>x</test_body>').ok, false, 'no name')
  assert.match(parseProposal('NAME: a\nREASON: b\n<test_body>\nawait page', { finish: 'length' }).why, /output budget/)
  assert.match(parseProposal('NAME: a\nREASON: b').why, /no test body/)
  assert.equal(parseProposal(null).ok, false)
})

test('dashes in the model\'s words are replaced, so none reaches a report', () => {
  const p = parseProposal(reply('Menu — broken', 'await page.click("a")', 'It – really — fails.'))
  assert.equal(/[–—]/.test(p.name + p.reason), false)
})

test('the safety check lets an ordinary test through, including a URL that is only an expected value', () => {
  assert.equal(checkTestSource(BODY, { body: true }), null)
  assert.equal(checkTestSource('await page.goto("/guide/start")\nawait expect(page.locator("a")).toHaveAttribute("href", "https://example.com/x")', { body: true }), null)
  assert.equal(checkTestSource('await request.get("/api/items")', { body: true }), null)
  // a word that only appears in a message or a comment is not code
  assert.equal(checkTestSource('// we never call fetch here\nawait expect(page.locator("p")).toHaveText("process the fetch queue")', { body: true }), null)
})

test('the safety check refuses anything that could leave the app, run code, read files or hide a failure', () => {
  const bad = {
    'await page.goto("https://evil.example/x")': /not a path on the app/,
    'await page.goto("//evil.example/x")': /not a path on the app/,
    'const u = "/a"\nawait page.goto(u)': /literal path/,
    'await request.post("http://evil.example/x")': /not a path on the app/,
    'await page.evaluate(() => fetch("/x"))': /"fetch"/,
    'const fs = require("fs")': /"require"/,
    'import x from "fs"': /"import"/,
    'process.exit(1)': /"process"/,
    'await page.evaluate(() => { window.location = "https://evil.example" })': /page address/,
    'await page.evaluate(() => { location.href = "/x" })': /page address/,
    'await page.evaluate(() => window.open("/x"))': /opens or loads/,
    'test.skip()': /modifier/,
    'test.fail()': /modifier/,
    'await page.route("**/*", r => r.continue())': /"route"/,
    'await page.context().cookies()': /"context"/,
    'await page.unroute("**/*")': /"unroute"/,
    'await page.evaluate(() => { const s = document.createElement("script"); s.src = "/x.js" })': /"createElement"/,
    'eval("1")': /"eval"/,
    'await page.request.get("/x")': /page.request/,
    ['a'.repeat(7000)]: /too long/,
    '': /empty/,
  }
  for (const [src, why] of Object.entries(bad)) assert.match(checkTestSource(src, { body: true }) ?? 'ALLOWED', why, src.slice(0, 60))
})

test('the whole file may import only { test, expect } from @playwright/test', () => {
  const prelude = "  const dialogs = []\n  await page.route('**/*', route => route.continue())\n  await page.goto(\"/\")"
  const ok = assembleSource({ name: 'A name', reason: 'because', body: BODY, prelude })
  assert.equal(checkTestSource(ok), null)
  assert.match(checkTestSource(ok.replace("from '@playwright/test'", "from 'node:fs'")) ?? 'ALLOWED', /imports something other/)
  assert.match(checkTestSource(ok.replace("import { test, expect } from '@playwright/test'", "import { test, expect } from '@playwright/test'\nimport fs from 'node:fs'")) ?? 'ALLOWED', /imports something other/)
  assert.match(ok, /^\/\/ Written by an AI model/); assert.match(ok, /test\("A name"/); assert.match(ok, new RegExp(SENTINEL))
  const f = join(mkdtempSync(join(tmpdir(), 'aitest-syntax-')), 'AI1.spec.mjs'); writeFileSync(f, ok)
  const syntax = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, 'the assembled file is valid JavaScript: ' + syntax.stderr)
})

test('scanCode blanks strings and comments but keeps template expressions as code', () => {
  const { code, strings } = scanCode('a("fetch") // eval\n/* process */ b(`x ${require("y")} z`)')
  assert.equal(/fetch|eval|process/.test(code), false)
  assert.match(code, /require/)
  assert.ok(strings.some(s => s.text === 'fetch'))
})

// a real code-generated spec, with the recording decoration
const finding = {
  id: 'R1', start: '/i/', title: 'data-url of li[2]/button[1] after step 2 keeps the previous release\'s value', expected: '"https://example.com/p"', actual: '"https%3A%2F%2Fexample.com%2Fp"',
  history: [{ type: 'click', selector: '.flux .title' }, { type: 'click', selector: '.flux.current a[href^="#dropdown-share"]' }],
  assert: { kind: 'attr', selector: 'xpath=/html/body/main/ul/li[2]/button[1]', name: 'data-url', op: 'equals', value: 'https://example.com/p' }, goodRef: '1.29.1', candRef: '1.30.0', notice: { cls: 'visible', why: 'x' },
}
const SPEC = specSource(finding)

test('the reference given to the model has no recording decoration; the fixed start and the steps are cut out of it', () => {
  const ref = referenceOf(SPEC)
  assert.equal(/__bq|BEHIQUE_VIDEO|marked|PAGE_MARK|root\.innerHTML/.test(ref), false, ref)
  assert.match(ref, /const el = page\.locator\("xpath=\/html\/body\/main\/ul\/li\[2\]\/button\[1\]"\)/); assert.match(ref, /expect\(String\(attr\)\)\.toBe\("https:\/\/example\.com\/p"\)/)
  assert.match(ref, /^\/\/ Expected:/m)
  const pre = preludeOf(SPEC)
  assert.match(pre, /dialogs/); assert.match(pre, /page\.goto\("\/i\/"\)$/)
  const steps = stepsOf(SPEC)
  assert.match(steps, /\.flux \.title/); assert.match(steps, /dropdown-share/); assert.equal(/const el/.test(steps), false)
  assert.equal(checkTestSource(assembleSource({ name: 'n', reason: 'r', body: BODY, prelude: pre })), null, 'the real fixed start passes the whole-file check')
})

test('the probe reads the old page by failing with the text, and is not a test the model wrote', () => {
  const src = probeSource({ prelude: preludeOf(SPEC), stepsCode: stepsOf(SPEC), elementPath: '/html/body/main/ul/li[2]/button[1]' })
  assert.match(src, /ELEMENT HTML/); assert.match(src, new RegExp(SENTINEL)); assert.match(src, /ariaSnapshot/)
  assert.doesNotThrow(() => new Function(src.replace(/^import .*$/m, '').replace(/^test\(/m, 'void (')), 'the generated probe is valid JavaScript')
})

test('prompts: every variant is data first, the page text is fenced as untrusted, and no dash punctuation is in what we send', () => {
  const f = { id: 'R1', goodRef: 'a', candRef: 'b', fact: { i: 2 }, symptoms: ['the text changed'], labels: ['start', '1:click x'], nearby: ['ancestor: div[1]@id = "app"'], reference: 'REF', snapshot: 'ELEMENT HTML: <button>' }
  for (const v of ['basic', 'context', 'strict', 'snapshot']) {
    const m = buildMessages(f, { variant: v }), all = m.map(x => x.content).join('\n')
    assert.equal(m[0].role, 'system'); assert.match(all, /<reference_test>\nREF/); assert.equal(/[–—]/.test(all), false, v)
    assert.equal(all.includes('untrusted_page_facts>\nRecorded on the OLD'), v !== 'basic')
    assert.equal(all.includes('ELEMENT HTML'), v === 'snapshot')
  }
  const r = repairMessages(buildMessages(f), 'old answer', { goodFailed: true, message: `Timeout 5000ms waiting for locator\n\n${SENTINEL}\n- button "Clipboard"` })
  assert.equal(r.at(-2).role, 'assistant'); assert.match(r.at(-1).content, /FAILED on the old version/); assert.match(r.at(-1).content, /<untrusted_page_facts>/); assert.match(r.at(-1).content, /button "Clipboard"/)
  assert.match(repairMessages(buildMessages(f), 'x', { passedOnCandidate: true }).at(-1).content, /PASSED on the new version/)
  assert.ok(worstCase(buildMessages(f)).usd > 0)
})

test('nearby changes are the other recorded differences under the same part of the page', () => {
  const diffs = [
    { i: 2, key: 'body/ul[1]/li[2]/button[1]@data-url', kind: 'changed', was: 'a', now: 'b' },
    { i: 2, key: 'body/ul[1]/li[2]/button[1]@data-title', kind: 'changed', was: 'First', now: 'First%20' },
    { i: 3, key: 'body/ul[1]/li[2]/button[1]@data-title', kind: 'changed', was: 'x', now: 'y' },
    { i: 2, key: 'body/nav[1]/a[1]@href', kind: 'changed', was: 'p', now: 'q' },
  ]
  const n = nearbyChanges(diffs, 2, 'body/ul[1]/li[2]/button[1]@data-url')
  assert.equal(n.length, 1); assert.match(n[0], /data-title/)
})

// A synthetic saved case, built with the real evidence store
function makeCase() {
  const dir = mkdtempSync(join(tmpdir(), 'aitest-case-'))
  const c = openCase(join(dir, 'case'))
  c.event('case.opened', { goodRef: '1.29.1', candRef: '1.30.0', adapter: 'freshrss', steps: [] })
  c.artifact('baseline.json', { labels: ['start', '1:click a', '2:click b'], stable: 3, volatile: {} }, 'application/json')
  const keys = ['body/ul[1]/li[2]/button[1]@data-url', 'body/ul[1]/li[2]/button[1]@data-title', 'body/ul[1]/li[2]/button[1]@title']
  c.artifact('facts-diff.json', { control: [], candidate: keys.map(key => ({ i: 2, step: '2:click b', key, kind: 'changed', was: 'old', now: 'new' })) }, 'application/json')
  keys.forEach((key, n) => {
    const id = `R${n + 1}`, attr = key.split('@')[1]
    c.artifact(`${id}.spec.js`, specSource({ ...finding, id, assert: { ...finding.assert, name: attr, value: 'old' } }), 'text/javascript')
    c.event('test.exported', { id, fact: key, i: 2, good: '"old"', candidate: '"new"' })
    c.event('test.judged', { id, verdict: n === 2 ? 'unstable' : 'confirmed', goodPassed: 3, candFailed: 3, runs: 3 })
  })
  return { dir, caseDir: join(dir, 'case') }
}

test('only proven differences are read from a case, with their reference and steps', () => {
  const { caseDir } = makeCase()
  const r = findingsOf(openCase(caseDir))
  assert.deepEqual(r.findings.map(f => f.id), ['R1', 'R2'])
  assert.equal(r.findings[0].fact.i, 2); assert.deepEqual(r.findings[0].labels, ['start', '1:click a', '2:click b'])
  assert.equal(findingsOf(openCase(caseDir), { only: 'all' }).findings.length, 3)
  assert.equal(r.findings[0].elementPath, '/html/body/ul[1]/li[2]/button[1]')
})

/** A fake runner: `script[id]` = { good: [...], cand: [...] } of 'pass' | 'fail' | { fail: message }; each run takes the next answer (the last repeats). */
function fakeVerify(script, seen = []) {
  const used = {}
  return async jobs => jobs.map(j => {
    seen.push(`${j.id}:${j.side}`)
    const list = script[j.id]?.[j.side === 'good' ? 'good' : 'cand'] ?? ['fail']
    const k = used[`${j.id}${j.side}`] = (used[`${j.id}${j.side}`] ?? -1) + 1
    const a = list[Math.min(k, list.length - 1)]
    return a === 'pass' ? { passed: true } : a === 'error' ? { error: 'build failed' } : { passed: false, message: a === 'fail' ? 'expect failed' : a.fail }
  })
}
const usage = (pt, ct) => ({ promptTokens: pt, completionTokens: ct, finish: 'stop', model: 'muse-spark-1.3', provider: 'meta' })

test('run: keeps the test that passes on good and fails on the candidate every run, drops the rest and says why, and never lets a refused test reach the runner', async () => {
  const { dir, caseDir } = makeCase()
  const seen = [], sent = []
  const ask = async messages => {
    sent.push(messages)
    const last = messages.at(-1).content, first = messages[1].content
    if (!first.includes('the "data-url" attribute') && !last.includes('FAILED')) return { text: reply('Share menu title no longer readable', BODY), usage: usage(1000, 500) }
    return { text: reply('Share link no longer readable', 'await page.goto("https://evil.example/x")'), usage: usage(1000, 500) }
  }
  const r = await run({ caseDir, ask, verify: fakeVerify({ AI2: { good: ['pass'], cand: ['fail'] } }, seen), outDir: join(dir, 'out'), maxUsd: 1, log: () => {} })
  assert.equal(r.label, 'ai_hypothesis'); assert.equal(r.items.length, 2)
  const [one, two] = r.items
  assert.equal(one.verified, false); assert.match(one.droppedBecause, /safety check.*not a path on the app/); assert.equal(one.runs, null)
  assert.equal(two.verified, true); assert.equal(two.name, 'Share menu title no longer readable'); assert.deepEqual([two.runs.good, two.runs.candidate], [{ passed: 3, total: 3 }, { failed: 3, total: 3 }])
  assert.equal(two.runs.verdict, 'confirmed'); assert.match(two.testSource, /@playwright\/test/)
  assert.equal(seen.some(s => s.startsWith('AI1:')), false, 'a refused test is never run')
  assert.equal(seen.filter(s => s.startsWith('AI2:')).length, 6, 'one look each way, then the rest of the three runs each way')
  assert.deepEqual(verifiedItems(r).map(i => i.id), ['AI2'])
  assert.equal(r.calls.length >= 2, true); assert.equal(r.calls[0].model, 'muse-spark-1.3'); assert.ok(r.spentUsd > 0 && Math.abs(r.spentUsd - r.calls.reduce((a, c) => a + c.usd, 0)) < 1e-12)
  assert.match(readFileSync(join(r.dir, 'AI2.spec.js'), 'utf8'), /Written by an AI model/)
})

test('run: a test that fails on the good version is given one repair, and kept only if the repair survives; a test that passes on both is dropped', async () => {
  const { dir, caseDir } = makeCase()
  let n = 0
  const ask = async messages => {
    const repairing = messages.at(-1).content.includes('Reply in exactly the same format')
    n++
    return { text: reply(repairing ? 'Repaired name' : `First name ${n}`, repairing ? BODY : BODY + '\n// first try'), usage: usage(800, 400) }
  }
  const verify = fakeVerify({ AI1: { good: ['fail', 'pass'], cand: ['fail'] }, AI2: { good: ['pass'], cand: ['pass'] } })
  const r = await run({ caseDir, ask, verify, outDir: join(dir, 'out'), maxUsd: 1, repairs: 1 })
  const [one, two] = r.items
  assert.equal(one.verified, true); assert.equal(one.name, 'Repaired name'); assert.equal(one.attempts, 2); assert.deepEqual(one.firstTry, { good: 'fail', candidate: 'fail' })
  assert.equal(two.verified, false); assert.match(two.droppedBecause, /passes on the candidate too/)
  assert.equal(r.calls.filter(c => c.purpose === 'repair').length, 2)
  const none = await run({ caseDir, ask, verify: fakeVerify({ AI1: { good: ['fail'], cand: ['fail'] }, AI2: { good: ['pass'], cand: ['fail'] } }), outDir: join(dir, 'out2'), maxUsd: 1, repairs: 0 })
  assert.equal(none.items[0].verified, false); assert.match(none.items[0].droppedBecause, /fails on the good version/)
})

test('run: an unstable test is dropped; a model that fails or rambles costs nothing wrong; the spending cap stops further calls', async () => {
  const { dir, caseDir } = makeCase()
  const unstable = await run({ caseDir, ask: async () => ({ text: reply('Flaky', BODY), usage: usage(100, 100) }), verify: fakeVerify({ AI1: { good: ['pass'], cand: ['fail'] }, AI2: { good: ['pass', 'fail', 'pass'], cand: ['fail'] } }), outDir: join(dir, 'o1'), maxUsd: 1, repairs: 0 })
  assert.equal(unstable.items[0].verified, true); assert.equal(unstable.items[1].verified, false); assert.match(unstable.items[1].droppedBecause, /not consistent/)
  const broken = await run({ caseDir, ask: async () => { throw new Error('HTTP 500') }, verify: fakeVerify({}), outDir: join(dir, 'o2'), maxUsd: 1 })
  assert.ok(broken.items.every(i => !i.verified && /model call failed/.test(i.droppedBecause))); assert.equal(broken.spentUsd, 0)
  const rambling = await run({ caseDir, ask: async () => ({ text: 'I think the share button is broken.', usage: usage(50, 20), }), verify: fakeVerify({}), outDir: join(dir, 'o3'), maxUsd: 1 })
  assert.ok(rambling.items.every(i => !i.verified && /could not be used/.test(i.droppedBecause))); assert.ok(rambling.spentUsd > 0, 'a reply that is thrown away is still paid for and counted')
  let calls = 0
  const capped = await run({ caseDir, ask: async () => { calls++; return { text: reply('x', BODY), usage: usage(1000, 500) } }, verify: fakeVerify({}), outDir: join(dir, 'o4'), maxUsd: 0.0001 })
  assert.equal(calls, 0); assert.ok(capped.items.every(i => /spending cap/.test(i.droppedBecause)))
})

test('run: records the calls in the case, labels the model\'s words as its own, and writes a code claim only for a survivor', async () => {
  const { dir, caseDir } = makeCase()
  await run({ caseDir, ask: async () => ({ text: reply('A readable name', BODY), usage: usage(900, 300) }), verify: fakeVerify({ AI1: { good: ['pass'], cand: ['fail'] }, AI2: { good: ['pass'], cand: ['pass'] } }), outDir: join(dir, 'out'), maxUsd: 1, repairs: 0 })
  const ev = openCase(caseDir).read()
  assert.equal(ev.filter(e => e.type === 'model.call').length, 2); assert.equal(ev.filter(e => e.type === 'model.requested').length, 2)
  const items = ev.filter(e => e.type === 'aitest.item')
  assert.deepEqual(items.map(e => e.data.label), ['ai_hypothesis', 'ai_hypothesis']); assert.deepEqual(items.map(e => e.data.verified), [true, false])
  const claims = ev.filter(e => e.type === 'claim' && /AI-written/.test(e.data.text))
  assert.equal(claims.length, 1); assert.equal(claims[0].data.label, 'reproduced_failure'); assert.equal(claims[0].by, 'code'); assert.equal(claims[0].data.text.includes('A readable name'), false)
  assert.equal(ev.filter(e => e.type === 'claim' && e.data.label === 'ai_hypothesis').length, 0, 'the three-guess limit of the ask-why card is not used up')
  assert.equal(openCase(caseDir).verify().ok, true)
})

test('run: refuses to start without a key and without an injected model, and says when a case has nothing to test', async () => {
  await assert.rejects(run({}), /needs a caseDir/)
  const dir = mkdtempSync(join(tmpdir(), 'aitest-empty-')), c = openCase(join(dir, 'c'))
  c.event('case.opened', { goodRef: 'a', candRef: 'b', adapter: 'freshrss', steps: [] })
  const r = await run({ caseDir: join(dir, 'c'), ask: async () => { throw new Error('must not be called') }, verify: async () => [], outDir: join(dir, 'o') })
  assert.equal(r.items.length, 0); assert.match(r.notes.join(' '), /no proven difference/)
})

test('run: a reply that was not a test, or was refused, gets one more try with the reason; it is kept only if that survives', async () => {
  const { dir, caseDir } = makeCase()
  let n = 0
  const ask = async messages => {
    n++
    const again = messages.at(-1).content.includes('could not be used')
    return { text: again ? reply('Second try', BODY) : n === 1 ? 'I cannot do that.' : reply('Bad', 'await page.goto("https://evil.example/")'), usage: usage(500, 200) }
  }
  const r = await run({ caseDir, ask, verify: fakeVerify({ AI1: { good: ['pass'], cand: ['fail'] }, AI2: { good: ['pass'], cand: ['fail'] } }), outDir: join(dir, 'out'), maxUsd: 1, repairs: 1 })
  assert.equal(r.items.filter(i => i.verified).length, 2)
  assert.equal(r.calls.filter(c => c.purpose === 'repair').length, 2)
  const once = await run({ caseDir, ask: async () => ({ text: reply('Bad', 'await page.goto("https://evil.example/")'), usage: usage(10, 10) }), verify: fakeVerify({}), outDir: join(dir, 'out2'), maxUsd: 1, repairs: 1 })
  assert.ok(once.items.every(i => !i.verified && /safety check/.test(i.droppedBecause)), 'a model that insists is dropped, and the unsafe test is never run')
})

test('run: a dry run or a refused approval sends nothing and spends nothing; an approval is shown the exact text and the worst-case cost', async () => {
  const { dir, caseDir } = makeCase()
  const ask = async () => { throw new Error('must not be called') }
  const dry = await run({ caseDir, ask, verify: fakeVerify({}), outDir: join(dir, 'o1'), dryRun: true, maxUsd: 1 })
  assert.equal(dry.spentUsd, 0); assert.equal(dry.calls.length, 0); assert.equal(dry.plan.prompts.length, 2); assert.equal(dry.plan.prompts[0].messages[0].role, 'system'); assert.ok(dry.plan.worstUsd > 0)
  let shown = null
  const no = await run({ caseDir, ask, verify: fakeVerify({}), outDir: join(dir, 'o2'), approve: async plan => { shown = plan; return false }, maxUsd: 1 })
  assert.equal(no.calls.length, 0); assert.ok(no.items.every(i => i.droppedBecause === 'not approved' && !i.verified)); assert.equal(shown.prompts.length, 2)
  const yes = await run({ caseDir, ask: async () => ({ text: reply('Ok', BODY), usage: usage(100, 100) }), verify: fakeVerify({ AI1: { good: ['pass'], cand: ['fail'] }, AI2: { good: ['pass'], cand: ['fail'] } }), outDir: join(dir, 'o3'), approve: async () => true, maxUsd: 1 })
  assert.equal(verifiedItems(yes).length, 2)
})
