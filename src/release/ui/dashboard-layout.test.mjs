// The dashboard in a real browser: every layout, every right-column tab, phone to desktop. Runs the real server against a throwaway
// folder of made-up reports, so it needs Chromium but no saved cases, no network and no model.  node --test src/release/ui/dashboard-layout.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { openCase } from '../evidence.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const LAYOUTS = ['classic', 'a', 'b', 'c']
const TABS = ['chain', 'ask', 'ai']
const WIDTHS = [[375, 812], [600, 900], [768, 1024], [1024, 768], [1440, 900]]
const STUCK = '20261101T000000Z_good-vs-cand'
const FOUND = '20261101T000100Z_good-vs-cand'
const SOURCE = "// Written by an AI model.\nimport { test, expect } from '@playwright/test'\n\ntest(\"a very long test name that would otherwise run straight past the right edge of the card on any narrow column at all\", async ({ page }) => {\n  await page.goto('/')\n  await expect(page.locator('aside')).toHaveAttribute('inert', '') // a comment\n  const n = 42\n})\n"

function report(dir, { conclusive }) {
  mkdirSync(dir, { recursive: true })
  const c = openCase(dir)
  c.event('case.opened', { goodRef: 'good', candRef: 'cand', adapter: 'freshrss', steps: [], options: { bisect: true, runs: 3 }, scenario: null })
  c.event('builds.compared', { good: { ref: 'good', sha: 'a'.repeat(40) }, candidate: { ref: 'cand', sha: 'b'.repeat(40) } })
  c.event('test.exported', { id: 'R1' })
  const spec = c.artifact('R1.spec.js', 'x')
  c.claim('reproduced_failure', 'the test passes on old and fails on new', { evidence: [spec] })
  c.event('bisect.started', { changes: 25 })
  if (conclusive) {
    c.event('bisect.step', { step: 1, sha: '1111111', index: 12, verdict: 'good', goodThrough: 12, badFrom: 25, changes: 25 })
    c.event('bisect.step', { step: 2, sha: '2222222', index: 13, verdict: 'bad', goodThrough: 12, badFrom: 13, changes: 25 })
  } else {
    for (let s = 1; s <= 24; s++) c.event('bisect.step', { step: s, sha: `abc${String(s).padStart(4, '0')}`, index: s, verdict: 'skip', why: 'toBeAttached() failed', goodThrough: 0, badFrom: 25, changes: 25 })
  }
  c.event('bisect.done', { conclusive, verified: conclusive, steps: conclusive ? 2 : 24, seconds: 5 })
  const bis = c.artifact('bisect.json', { result: conclusive ? { conclusive: true, verified: true, commit: '2222222fff', subject: 'Break it (#7)', files: [], changes: 25, steps: 2 } : { conclusive: false, verified: false, commit: null, changes: 25, steps: 24 }, log: [] })
  if (conclusive) c.claim('reproduced_failure', 'first bad change is 2222222. The change just before it passed 3 of 3 runs and it failed 3 of 3 runs.', { evidence: [bis, spec] })
  const saved = c.artifact('ai-tests.json', { label: 'ai_hypothesis', stage: 'tests', items: [{ id: 'AI1', findingId: 'R1', name: 'The sidebar stops responding', reason: 'it carries an inert attribute', testSource: SOURCE, verified: true, runs: { good: { passed: 3, total: 3 }, candidate: { failed: 3, total: 3 } } }], notes: [] }, 'application/json')
  c.event('ai.stage', { stage: 'tests', label: 'ai_hypothesis', status: 'ran', reason: null, items: 1, verified: 1, calls: 1, estUsd: 0.007, evidence: [saved] })
  c.event('case.closed', { outcome: 'regression proven' })
}

let server, browser, folder

before(async () => {
  folder = mkdtempSync(join(tmpdir(), 'dash-layout-'))
  report(join(folder, STUCK), { conclusive: false })
  report(join(folder, FOUND), { conclusive: true })
  server = spawn('node', ['demo/server.mjs', String(PORT)], { cwd: ROOT, env: { ...process.env, BEHIQUE_EVIDENCE_DIR: folder }, stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/dashboard`)).ok) break } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  server?.kill()
  if (folder) rmSync(folder, { recursive: true, force: true })
})

async function open(width, height, id = STUCK) {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${BASE}/dashboard`)
  await page.waitForFunction(() => typeof loadLive === 'function')
  await page.waitForTimeout(600) // the dashboard's own first load, so it cannot land on top of ours
  await page.evaluate(i => loadLive(i), id)
  await page.waitForSelector('#aiCard .ai-stage', { state: 'attached' })
  return { page, errors }
}

const pick = (page, layout) => page.click(`#rdSeg button[data-l="${layout}"]`)

// anything visible past the edge of the screen that no scrolling parent holds; the timeline's pulse is an invisible animation, so it does not count
const offScreen = page => page.evaluate(() => {
  const held = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return true; return false }
  const out = []
  document.querySelectorAll('body *').forEach(e => {
    if (e.id === 'bisectPulse' || (e.offsetParent === null && getComputedStyle(e).position !== 'fixed')) return
    const r = e.getBoundingClientRect()
    if (r.width && r.height && (r.right > innerWidth + 1 || r.left < -1) && !held(e)) out.push(`${e.tagName.toLowerCase()}#${e.id}.${String(e.className).split(' ')[0]}`)
  })
  return out
})

const pastColumn = page => page.evaluate(() => {
  const col = document.querySelector('.rightcol').getBoundingClientRect(), out = []
  document.querySelector('.rightcol').querySelectorAll('*').forEach(e => {
    if (e.offsetParent === null) return
    const r = e.getBoundingClientRect()
    if (r.width && (r.right > col.right + 1 || r.left < col.left - 1)) out.push(`${e.tagName.toLowerCase()}#${e.id}.${String(e.className).split(' ')[0]}`)
  })
  return out
})

for (const [width, height] of WIDTHS) {
  test(`${width}px: every layout and tab stays on screen and inside the right column`, async () => {
    const { page, errors } = await open(width, height)
    // two recordings with long captions, as a real report has
    await page.evaluate(() => {
      const v = document.createElement('div'); v.className = 'claim-videos'
      for (let i = 0; i < 2; i++) { const f = document.createElement('figure'); f.className = 'vid'; f.innerHTML = '<video></video><figcaption><span class="ver">v1.0.0-rc.12</span><small>the test fails on the candidate with a long reason</small></figcaption>'; v.appendChild(f) }
      document.querySelector('#claimsList .claim')?.appendChild(v)
    })
    for (const layout of LAYOUTS) {
      await pick(page, layout)
      for (const tab of TABS) {
        await page.click(`#rtab-${tab}`)
        if (tab === 'ai') {
          const b = page.locator('#aiCard .ai-src button').first()
          if (await b.textContent() === 'Show test') await b.click()
          const code = await page.evaluate(() => { const p = document.querySelector('#aiCard pre.ai-code'), c = document.getElementById('aiCard').getBoundingClientRect(), r = p.getBoundingClientRect(); return { sideways: p.scrollWidth > p.clientWidth + 1, inside: r.right <= c.right + 1 && r.left >= c.left - 1 } })
          assert.deepEqual(code, { sideways: false, inside: true }, `${layout}: the code wraps inside the card`)
        }
        assert.deepEqual(await offScreen(page), [], `${layout}/${tab}: nothing off screen`)
        assert.deepEqual(await pastColumn(page), [], `${layout}/${tab}: nothing past the right column`)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${layout}/${tab}: no sideways page scroll`)
      }
    }
    assert.deepEqual(errors, [])
    await page.close()
  })
}

for (const [width, height] of [[375, 812], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]]) {
  test(`${width}px: the verdict stays one word on one line, in its card, clear of New run`, async () => {
    const { page } = await open(width, height)
    for (const layout of LAYOUTS) {
      await pick(page, layout)
      await page.waitForTimeout(350) // the grid animates when the layout changes
      for (const word of ['HOLD', 'SHIP', 'REVIEW', 'FAILED']) {
        const r = await page.evaluate(w => {
          const h = document.getElementById('verdictWord'); h.textContent = w
          const range = document.createRange(); range.selectNodeContents(h)
          const t = range.getBoundingClientRect(), hero = document.getElementById('heroCard').getBoundingClientRect(), cta = document.querySelector('.run-cta')?.getBoundingClientRect()
          const size = parseFloat(getComputedStyle(h).fontSize), clear = !cta || t.right <= cta.left + 1 || t.left >= cta.right - 1 || t.bottom <= cta.top + 1 || t.top >= cta.bottom - 1
          return { lines: range.getClientRects().length, oneLine: t.height < size * 1.5, inCard: t.left >= hero.left - 1 && t.right <= hero.right + 1, clear, readable: size >= 40 }
        }, word)
        assert.deepEqual(r, { lines: 1, oneLine: true, inCard: true, clear: true, readable: true }, `${layout} ${word}`)
      }
    }
    await page.close()
  })
}

test('the test code stays folded until Show test is clicked, then folds again', async () => {
  const { page } = await open(1440, 900)
  await page.click('#rtab-ai')
  const seen = () => page.evaluate(() => document.querySelector('#aiCard pre.ai-code').offsetHeight > 0)
  const label = () => page.textContent('#aiCard .ai-src button')
  assert.equal(await seen(), false); assert.equal(await label(), 'Show test')
  await page.click('#aiCard .ai-src button')
  assert.equal(await seen(), true); assert.equal(await label(), 'Hide test')
  await page.click('#aiCard .ai-src button')
  assert.equal(await seen(), false); assert.equal(await label(), 'Show test')
  await page.close()
})

test('the tabs show one card at a time, and the choice survives a reload', async () => {
  const { page } = await open(1440, 900)
  const shown = () => page.evaluate(() => ['evidenceCard', 'askCard', 'aiCard'].filter(i => document.getElementById(i).offsetHeight > 0))
  await page.click('#rtab-chain'); assert.deepEqual(await shown(), ['evidenceCard'])
  await page.click('#rtab-ask'); assert.deepEqual(await shown(), ['askCard'])
  await page.click('#rtab-ai'); assert.deepEqual(await shown(), ['aiCard'])
  await page.reload(); await page.waitForTimeout(500)
  assert.equal(await page.getAttribute('.rightcol', 'data-tab'), 'ai')
  await page.close()
})

test('a narrow column gets short tab labels, and every tab stays reachable', async () => {
  const { page } = await open(375, 812)
  for (const layout of LAYOUTS) {
    await pick(page, layout)
    const t = await page.evaluate(() => { const b = document.querySelector('.rtabs'); return { label: document.getElementById('rtab-chain').firstChild.nodeValue, sideways: b.scrollWidth > b.clientWidth } })
    assert.deepEqual(t, { label: 'Chain', sideways: false }, layout)
  }
  await page.close()
})

test('phone: the layout buttons stay on one row and the nav shows icons, not piled-up labels', async () => {
  const { page } = await open(375, 812)
  for (const layout of LAYOUTS) {
    await pick(page, layout)
    const r = await page.evaluate(() => {
      const tops = new Set([...document.querySelectorAll('#rdSeg button')].map(b => Math.round(b.getBoundingClientRect().top)))
      const nav = document.querySelector('.nav'), bar = document.getElementById('rdBar').getBoundingClientRect(), seg = document.getElementById('rdSeg').getBoundingClientRect()
      const v = getComputedStyle(document.getElementById('verdictWord')), hero = document.getElementById('heroCard').getBoundingClientRect(), word = document.getElementById('verdictWord').getBoundingClientRect()
      return { rows: tops.size, inBar: seg.top >= bar.top && seg.bottom <= bar.bottom, label: getComputedStyle(nav.querySelector('a')).fontSize, navFits: nav.scrollWidth <= nav.clientWidth, wordFits: word.width <= hero.width, big: parseFloat(v.fontSize) <= 60 }
    })
    assert.deepEqual(r, { rows: 1, inBar: true, label: '0px', navFits: true, wordFits: true, big: true }, layout)
  }
  await page.close()
})

for (const layout of LAYOUTS) {
  test(`phone, ${layout}: the apps dropdown opens over the page and closes three ways`, async () => {
    const { page } = await open(375, 812)
    await pick(page, layout)
    const headerH = () => page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().height)
    const heroTop = () => page.evaluate(() => document.getElementById('heroCard').getBoundingClientRect().top)
    const isOpen = () => page.evaluate(() => document.querySelector('.sidebar').classList.contains('apps-open'))
    const [h0, t0] = [await headerH(), await heroTop()]
    await page.click('#appsToggle')
    assert.equal(await isOpen(), true)
    assert.equal(await headerH(), h0, 'the header row does not re-wrap')
    assert.equal(await heroTop(), t0, 'the page does not jump')
    const onTop = await page.evaluate(() => { const d = document.getElementById('appsDrop').getBoundingClientRect(), hit = document.elementFromPoint(d.left + d.width / 2, d.top + d.height / 2); return { top: document.getElementById('appsDrop').contains(hit), fits: d.bottom <= innerHeight && d.right <= innerWidth && d.left >= 0, report: document.getElementById('runPick').getBoundingClientRect().height > 0 } })
    assert.deepEqual(onTop, { top: true, fits: true, report: true }, 'the panel is on top, on screen, and holds the report picker')
    await page.keyboard.press('Escape'); assert.equal(await isOpen(), false, 'Escape closes it')
    await page.click('#appsToggle'); assert.equal(await isOpen(), true)
    await page.mouse.click(180, 700); assert.equal(await isOpen(), false, 'a tap outside closes it')
    await page.click('#appsToggle'); assert.equal(await isOpen(), true)
    await page.click('#appsToggle'); assert.equal(await isOpen(), false, 'the toggle closes it')
    await page.close()
  })
}

test('desktop: the apps list stays in the sidebar, the wrapper changes nothing', async () => {
  const { page } = await open(1440, 900)
  for (const layout of ['classic', 'a']) {
    await pick(page, layout)
    await page.evaluate(() => { document.documentElement.classList.remove('side-c') })
    const r = await page.evaluate(() => ({ wrap: getComputedStyle(document.getElementById('appsDrop')).display, list: document.querySelector('.apps').offsetHeight > 0, picker: document.getElementById('runPick').offsetHeight > 0 })) // the section, not its rows: those arrive later, from GitHub
    assert.deepEqual(r, { wrap: 'contents', list: true, picker: true }, layout)
  }
  await page.close()
})

test('a search that could not decide says so, and shows no made-up result', async () => {
  const { page } = await open(1440, 900)
  const r = await page.evaluate(() => ({
    classes: [...new Set([...document.querySelectorAll('#bisectNodes .node')].map(n => n.className.split(' ')[1]))],
    banner: document.getElementById('bisectInconclusive').hidden ? null : document.getElementById('bisectInconclusive').textContent,
    skipLegend: !document.getElementById('lgSkip').hidden,
    culprit: document.getElementById('culpritTag').style.display,
    tip: document.querySelector('#bisectNodes .node').getAttribute('aria-label'),
  }))
  assert.ok(!r.classes.includes('g'), `no green dots, got ${r.classes}`)
  assert.ok(r.classes.includes('s'), 'skipped steps are drawn as skipped')
  assert.match(r.banner, /inconclusive/i); assert.match(r.banner, /24 of 24/)
  assert.equal(r.skipLegend, true)
  assert.equal(r.culprit, 'none')
  assert.match(r.tip, /skipped/)
  await page.close()
})

test('a search that found the change keeps its colours and shows no inconclusive banner', async () => {
  const { page } = await open(1440, 900, FOUND)
  const r = await page.evaluate(() => ({
    classes: new Set([...document.querySelectorAll('#bisectNodes .node')].map(n => n.className.split(' ')[1])).size,
    culprit: document.querySelectorAll('#bisectNodes .node.c').length, good: document.querySelectorAll('#bisectNodes .node.g').length, bad: document.querySelectorAll('#bisectNodes .node.r').length,
    banner: document.getElementById('bisectInconclusive').hidden, skip: document.getElementById('lgSkip').hidden, unk: document.getElementById('lgUnk').hidden,
  }))
  assert.equal(r.culprit, 1); assert.ok(r.good > 0); assert.ok(r.bad > 0)
  assert.equal(r.banner, true); assert.equal(r.skip, true); assert.equal(r.unk, true)
  await page.close()
})

test('Show test colours the code, draws text only, and Copy and Download use the raw source', async () => {
  const { page } = await open(1440, 900)
  await page.click('#rtab-ai')
  await page.click('#aiCard .ai-src button')
  const r = await page.evaluate(() => {
    const p = document.querySelector('#aiCard pre.ai-code'), of = k => [...p.querySelectorAll('.tk-' + k)].map(s => s.textContent)
    return { same: p.textContent, kw: of('kw'), str: of('str').length, com: of('com').length, num: of('num'), fn: of('fn'), tags: [...new Set([...p.querySelectorAll('*')].map(e => e.tagName))] }
  })
  assert.equal(r.same, SOURCE, 'the colouring changes no character')
  for (const k of ['import', 'from', 'async', 'await', 'const']) assert.ok(r.kw.includes(k), k)
  assert.ok(r.str >= 2); assert.ok(r.com >= 2); assert.deepEqual(r.num, ['42']); assert.ok(r.fn.includes('goto'))
  assert.deepEqual(r.tags, ['SPAN'], 'only spans are drawn')
  const blob = await page.evaluate(async () => {
    let cap = null, name = null; const o = URL.createObjectURL, c = HTMLAnchorElement.prototype.click
    URL.createObjectURL = b => { cap = b; return o(b) }; HTMLAnchorElement.prototype.click = function () { name = this.download }
    try { document.querySelectorAll('#aiCard .ai-src button')[2].click() } finally { URL.createObjectURL = o; HTMLAnchorElement.prototype.click = c }
    return { name, text: await cap.text() }
  })
  assert.deepEqual(blob, { name: 'AI1.spec.js', text: SOURCE })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {})
  await page.evaluate(() => document.querySelectorAll('#aiCard .ai-src button')[1].click())
  await page.waitForTimeout(150)
  assert.equal(await page.evaluate(() => document.querySelectorAll('#aiCard .ai-src button')[1].textContent), 'Copied')
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), SOURCE)
  await page.close()
})

test('a markup-looking test source stays text', async () => {
  const { page } = await open(1440, 900)
  const r = await page.evaluate(() => {
    const before = document.querySelectorAll('img[src="x"]').length
    const li = document.querySelector('#aiCard pre.ai-code'); return { before, tags: [...li.querySelectorAll('*')].every(e => e.tagName === 'SPAN') }
  })
  assert.deepEqual(r, { before: 0, tags: true })
  await page.close()
})
