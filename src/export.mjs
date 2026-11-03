// Turn accepted findings (recorded actions + assertion data) into Playwright test files, and run them.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const q = v => JSON.stringify(v)
const loc = sel => `page.locator(${q(sel)}).first()`

function stepCode(a) {
  const L = loc(a.selector)
  switch (a.type) {
    case 'click': return `await ${L}.click()`
    case 'fill': return a.secret && a.envName ? `await ${L}.fill(process.env[${q(String(a.envName))}] ?? '')` : `await ${L}.fill(${q(a.secret ? '[redacted]' : String(a.text ?? ''))})` // a secret never lands in a test file
    case 'press': return a.selector ? `await ${L}.press(${q(String(a.key))})` : `await page.keyboard.press(${q(String(a.key))})`
    case 'select': return `await ${L}.selectOption(${q(String(a.value))})`
    case 'check': return `await ${L}.check()`
    case 'uncheck': return `await ${L}.uncheck()`
    case 'hover': return `await ${L}.hover()`
    case 'scroll': return `await ${L}.evaluate(e => e.scrollIntoView({ block: 'center' }))`
    case 'reload': return 'await page.reload()'
    case 'wait': return `await page.waitForTimeout(${Math.min(Number(a.ms) || 500, 2000)})`
    case 'goto': return `await page.goto(${q(a.path)})`
    case 'api': return `await request.fetch(${q(a.path)}, { method: ${q(String(a.method || 'GET').toUpperCase())}${a.body !== undefined ? `, data: ${q(a.body)}` : ''} })`
    default: throw new Error('cannot export action ' + a.type)
  }
}

const ORIGIN_RE = /^https?:\/\/[^/?#]+$/

// A recorded value can embed the address the app was served from (a share link, the referer in a widget's iframe src). The
// test may run against the same build on another port (a pooled run serves each build on its own), so where the recording
// origin appears in an expected value, plain or URL-encoded, the test swaps in the origin it is actually talking to.
function expectedCode(value, ctx) {
  const str = String(value ?? ''), v = q(str), o = ctx?.origin
  if (!o || !(str.includes(o) || str.includes(encodeURIComponent(o)))) return v
  ctx.live = true
  return `${v}.split(${q(o)}).join(live).split(${q(encodeURIComponent(o))}).join(encodeURIComponent(live))`
}

function cmp(expr, op = 'equals', value, ctx = null) {
  const s = `String(${expr})`
  const v = q(String(value ?? ''))
  switch (op) {
    case 'equals': return `expect(${s}).toBe(${expectedCode(value, ctx)})`
    case 'not_equals': return `expect(${s}).not.toBe(${expectedCode(value, ctx)})`
    case 'contains': return `expect(${s}).toContain(${expectedCode(value, ctx)})`
    case 'not_contains': return `expect(${s}).not.toContain(${expectedCode(value, ctx)})`
    case 'matches': return `expect(${s}).toMatch(new RegExp(${v}))` // a pattern is left as recorded
    case 'eq': return `expect(Number(${expr})).toBe(${Number(value)})`
    case 'ne': return `expect(Number(${expr})).not.toBe(${Number(value)})`
    case 'gte': return `expect(Number(${expr})).toBeGreaterThanOrEqual(${Number(value)})`
    case 'lte': return `expect(Number(${expr})).toBeLessThanOrEqual(${Number(value)})`
    default: throw new Error('cannot export op ' + op)
  }
}

function assertionCode(spec, ctx = null) {
  const el = `const el = ${loc(spec.selector)}`
  const attached = 'await expect(el).toBeAttached()'
  switch (spec.kind) {
    case 'text': return [el, attached, "const text = ((await el.textContent()) ?? '').trim()", cmp('text', spec.op, spec.value, ctx)]
    case 'own_text': return [el, attached, "const text = await el.evaluate(n => [...n.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join(' ').replace(/\\s+/g, ' ').trim())", cmp('text', spec.op, spec.value, ctx)]
    case 'value': return [el, attached, 'const value = await el.inputValue()', cmp('value', spec.op, spec.value, ctx)]
    case 'visible': return [el, spec.expect === false ? 'await expect(el).toBeHidden()' : 'await expect(el).toBeVisible()']
    case 'checked': return [el, attached, spec.expect === false ? 'await expect(el).not.toBeChecked()' : 'await expect(el).toBeChecked()']
    case 'count': return [`const count = await page.locator(${q(spec.selector)}).count()`, cmp('count', spec.op ?? 'eq', spec.value)]
    case 'style': return [el, attached, `const style = await el.evaluate((e, p) => getComputedStyle(e)[p], ${q(String(spec.property))})`, cmp('style', spec.op, spec.value, ctx)]
    case 'class_list': return [el, attached, "const classes = await el.evaluate(e => [...new Set((e.getAttribute('class') ?? '').split(/\\s+/).filter(Boolean))].sort().join(' '))", cmp('classes', spec.op, spec.value, ctx)] // the recorded fact is the sorted class list
    case 'scrolls': return [el, attached, // the area could scroll on the old version: the test turns the wheel over it (so a recording shows the attempt) and also asks the element
      '// Try to scroll the area with the mouse wheel, as a person would; then ask the element whether it can scroll at all.',
      'await el.scrollIntoViewIfNeeded().catch(() => {})',
      'const box = await el.boundingBox()',
      'const topBefore = await el.evaluate(e => e.scrollTop)',
      "const recording = process.env.BEHIQUE_VIDEO === '1' // when recording, the page is marked so the footage explains itself; never part of the check",
      `if (box && recording) { await page.evaluate(${PAGE_MARK}, { x: box.x + box.width / 2, y: box.y + box.height / 2, box, head: 'Mouse wheel', note: '240 px down, over the outlined area', state: '' }); await page.waitForTimeout(700) }`,
      'if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 240); await page.waitForTimeout(400) }',
      'const moved = (await el.evaluate(e => e.scrollTop)) > topBefore',
      `if (box && recording) await page.evaluate(${PAGE_MARK}, { x: box.x + box.width / 2, y: box.y + box.height / 2, box, head: moved ? 'It scrolled' : 'It did not move', note: moved ? 'the area under the wheel moved' : 'nothing under the wheel moved', state: moved ? 'ok' : 'bad' })`,
      "const scrolls = await el.evaluate(e => e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY))",
      'expect(scrolls || moved).toBe(true)']
    case 'attr': return spec.op === 'absent'
      ? [el, attached, `const attr = await el.getAttribute(${q(String(spec.name))})`, 'expect(attr).toBeNull()'] // absent: the old version had no such attribute
      : [el, attached, `const attr = await el.getAttribute(${q(String(spec.name))})`, 'expect(attr).not.toBeNull()', cmp('attr', spec.op, spec.value, ctx)]
    case 'dialog': return ["const dialog = dialogs.at(-1) ?? ''", cmp('dialog', spec.op, spec.value, ctx)]
    case 'api': {
      const lines = ['let res']
      for (const st of spec.steps) lines.push(`res = await request.fetch(${q(st.path)}, { method: ${q(String(st.method || 'GET').toUpperCase())}${st.body !== undefined ? `, data: ${q(st.body)}` : ''} })`)
      lines.push('const body = await res.text()')
      if (spec.status !== undefined) lines.push(`expect(res.status()).toBe(${Number(spec.status)})`)
      if (spec.header) lines.push(cmp(`res.headers()[${q(String(spec.header.name).toLowerCase())}] ?? ''`, spec.header.op, spec.header.value, ctx))
      if (spec.json) {
        lines.push('let parsed', 'try { parsed = JSON.parse(body) } catch {}',
          `const got = ${q(String(spec.json.path))}.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), parsed)`,
          'expect(got).not.toBeUndefined()',
          cmp("typeof got === 'object' ? JSON.stringify(got) : got", spec.json.op, spec.json.value, ctx))
      }
      return lines
    }
    default: throw new Error('cannot export assertion ' + spec.kind)
  }
}

// Runs inside the page while a test is recorded: a spotlight on the tested element, and a tag that first says what is being checked and
// then what was found; with `pointer`, a pulsing ring and a mouse glyph where the wheel turns. Fixed, on top of everything, lets events through.
const PAGE_MARK = `(({ x, y, box, head, note, state, pointer = true }) => {
  let root = document.getElementById('__bq_wheel')
  if (!root) {
    root = document.createElement('div'); root.id = '__bq_wheel'
    root.innerHTML = '<style>#__bq_wheel{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:600 15px/1.25 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;--c:#f0b429}#__bq_wheel.ok{--c:#3ddc97}#__bq_wheel.bad{--c:#ff5c5c}'
      + '#__bq_wheel .area{position:absolute;border:2px dashed var(--c);border-radius:10px;box-shadow:0 0 0 9999px rgba(8,10,16,.22);transition:border-color .3s}'
      + '#__bq_wheel .ring{position:absolute;width:48px;height:48px;margin:-24px 0 0 -24px;border:3px solid var(--c);border-radius:50%;animation:__bqPulse 1.1s ease-out infinite}'
      + '@keyframes __bqPulse{0%{transform:scale(.5);opacity:1}100%{transform:scale(1.7);opacity:0}}'
      + '#__bq_wheel .mouse{position:absolute;width:28px;height:42px;margin:-21px 0 0 -14px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.5))}'
      + '#__bq_wheel .tag{position:absolute;margin:28px 0 0 22px;padding:9px 13px;border-radius:12px;background:rgba(14,17,24,.94);color:#fff;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.12)}'
      + '#__bq_wheel .tag b{display:block;color:var(--c);font-size:16px}#__bq_wheel .tag small{display:block;font-weight:500;font-size:12.5px;opacity:.85;margin-top:2px}</style>'
      + '<div class="area"></div><div class="ring"></div><svg class="mouse" viewBox="0 0 28 42"><rect x="2" y="2" width="24" height="38" rx="12" fill="rgba(14,17,24,.92)" stroke="#fff" stroke-width="2"/><rect class="w" x="12" y="8" width="4" height="10" rx="2" fill="#f0b429"/><path d="M14 22v12m-4-4l4 4 4-4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="tag"><b></b><small></small></div>'
    document.documentElement.appendChild(root)
  }
  root.className = state
  const a = root.querySelector('.area'); a.style.left = box.x + 'px'; a.style.top = box.y + 'px'; a.style.width = box.width + 'px'; a.style.height = box.height + 'px'
  for (const c of ['.ring', '.mouse']) { const e = root.querySelector(c); e.style.display = pointer ? '' : 'none'; e.style.left = x + 'px'; e.style.top = y + 'px' }
  const t = root.querySelector('.tag')
  if (pointer) { t.style.margin = ''; t.style.left = x + 'px'; t.style.top = y + 'px' }
  else { const below = box.y + box.height + 10, up = box.y - 64; t.style.margin = '0'; t.style.left = Math.max(8, Math.min(box.x, innerWidth - 360)) + 'px'; t.style.top = (below + 60 < innerHeight ? below : Math.max(8, up)) + 'px' }
  root.querySelector('.w').setAttribute('fill', state === 'ok' ? '#3ddc97' : state === 'bad' ? '#ff5c5c' : '#f0b429')
  root.querySelector('.tag b').textContent = head; root.querySelector('.tag small').textContent = note
})`

const MARK_TAGS = { a: 'link', p: 'paragraph', li: 'list item', ul: 'list', img: 'image', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', nav: 'nav', aside: 'sidebar', main: 'main area', header: 'header', footer: 'footer', button: 'button', input: 'field', select: 'menu', textarea: 'field', table: 'table', td: 'cell', tr: 'row', span: 'span', div: 'block', label: 'label', form: 'form', section: 'section', svg: 'icon' }
const cutTo = (v, n = 60) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const fewOf = (list, n = 3) => (list.length ? list.slice(0, n).join(' ') + (list.length > n ? ` +${list.length - n}` : '') : 'nothing')
/** What the recording's tag says for an element check: the element, what is checked, and the words for a pass and for a fail. Never part of the check. */
export function markWords(f) {
  const a = f.assert ?? {}
  const tag = String(a.selector ?? '').match(/\/([a-z0-9]+)(?:\[\d+\])?$/i)?.[1]?.toLowerCase()
  const who = 'This ' + (MARK_TAGS[tag] ?? tag ?? 'element')
  const good = f.goodRef ? `As on ${f.goodRef}` : 'As expected', bad = f.candRef ? `Changed on ${f.candRef}` : 'Changed'
  const unq = v => { const t = String(v ?? ''); return /^".*"$/s.test(t) ? JSON.parse(t) : t } // a finding's values are JSON-quoted strings
  const exp = unq(f.expected ?? a.value), act = unq(f.actual)
  const kinds = {
    class_list: () => { const e = new Set(exp.split(/\s+/).filter(Boolean)), c = new Set(act.split(/\s+/).filter(Boolean)); const lost = [...e].filter(x => !c.has(x)), got = [...c].filter(x => !e.has(x)); return { what: 'checking its style classes', pass: 'its style classes are the same', fail: `${fewOf(got)} instead of ${fewOf(lost)}` } },
    text: () => ({ what: 'checking its text', pass: `it reads "${cutTo(exp)}"`, fail: `it reads "${cutTo(act)}"` }),
    own_text: () => ({ what: 'checking its text', pass: `it reads "${cutTo(exp)}"`, fail: `it reads "${cutTo(act)}"` }),
    value: () => ({ what: 'checking its value', pass: `its value is "${cutTo(exp)}"`, fail: `its value is "${cutTo(act)}"` }),
    attr: () => (a.op === 'absent' ? { what: `checking it has no ${a.name} attribute`, pass: `no ${a.name} attribute`, fail: `${a.name} is set` } : { what: `checking its ${a.name} attribute`, pass: `${a.name} is "${cutTo(exp)}"`, fail: `${a.name} is "${cutTo(act)}"` }),
    visible: () => (a.expect === false ? { what: 'checking it is hidden', pass: 'it is hidden', fail: 'it is shown' } : { what: 'checking it is shown', pass: 'it is shown', fail: 'it is hidden' }),
    checked: () => (a.expect === false ? { what: 'checking it is not checked', pass: 'not checked', fail: 'it is checked' } : { what: 'checking it is checked', pass: 'it is checked', fail: 'not checked' }),
    style: () => ({ what: `checking its ${a.property}`, pass: `${a.property} is ${cutTo(exp)}`, fail: `${a.property} is ${cutTo(act)}` }),
  }
  const w = kinds[a.kind]?.()
  return w ? { who, what: w.what, goodHead: good, badHead: bad, pass: w.pass, fail: w.fail } : null
}

export function specSource(f) {
  const indent = lines => lines.map(l => '  ' + l).join('\n')
  const pause = a => (a.type === 'wait' ? [] : ['await page.waitForTimeout(200)'])
  // scroll_delta compares the page's scroll position before and after the LAST action, so it needs no absolute pixel values
  const delta = f.assert.kind === 'scroll_delta'
  // A profile's login step (actions marked fromLogin) may write; a read-only test lets its requests through and blocks the rest again after it.
  const hist = delta ? f.history.slice(0, -1) : f.history
  const steps = hist.flatMap((a, i) => [
    ...(f.readOnly && a.fromLogin && !hist[i - 1]?.fromLogin ? ['loginWrites = true'] : []),
    stepCode(a), ...pause(a),
    ...(f.readOnly && a.fromLogin && !hist[i + 1]?.fromLogin ? ['loginWrites = false'] : []),
  ])
  const settle = f.assert.kind === 'api' ? [] : ["await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})", 'await page.waitForTimeout(250)'] // settle as the recorder did, so the page is drawn before the check (and before a recording ends)
  const ctx = { origin: typeof f.origin === 'string' && ORIGIN_RE.test(f.origin) ? f.origin : null, live: false } // f.origin: where the facts were recorded
  const words = delta ? null : markWords(f) // when recording, the tested element is outlined and a tag says what is checked, then what was found
  const body = delta
    ? ['const readScroll = () => page.evaluate(() => Math.round(window.scrollY))', 'const before = await readScroll()', stepCode(f.history.at(-1)), ...pause(f.history.at(-1)), ...settle,
       'const after = await readScroll()', `expect(after - before).toBe(${Number(f.assert.value)})`]
    : [...settle, ...assertionCode(f.assert, ctx)]
  const check = words
    ? [...body.slice(0, settle.length + 2), // after the settle, the locator and the attached check come first, so the element can be outlined before its value is read
       `if (process.env.BEHIQUE_VIDEO === '1') { marked = await el.boundingBox().catch(() => null); if (marked) { await page.evaluate(${PAGE_MARK}, { box: marked, head: ${q(words.who)}, note: ${q(words.what)}, state: '', pointer: false }); await page.waitForTimeout(700) } }`,
       ...body.slice(settle.length + 2),
       `if (marked) await page.evaluate(${PAGE_MARK}, { box: marked, head: ${q(words.goodHead)}, note: ${q(words.pass)}, state: 'ok', pointer: false }).catch(() => {})`]
    : body
  return `// Generated by Behique. ${f.id}: ${f.title.replace(/\n/g, ' ')}
// Expected: ${String(f.expected).replace(/\n/g, ' ')}
// Actual:   ${String(f.actual).replace(/\n/g, ' ')}${f.notice?.cls ? `\n// Class:    ${f.notice.cls === 'visible' ? 'a person would notice' : f.notice.cls === 'churn' ? 'markup churn' : 'third-party content'} (${String(f.notice.why ?? '').replace(/\n/g, ' ')})` : ''}
import { test, expect } from '@playwright/test'

test(${q(f.title)}, async ({ page, request }) => {
${indent([
    'const dialogs = []',
    "page.on('dialog', d => { dialogs.push(d.message()); d.accept() })",
    '// Start from a clean app. This hook is project specific: replace it with your own reset.',
    "await request.post('/api/reset').catch(() => {})",
    ...(f.readOnly ? ["// The facts were recorded with every request but GET and HEAD blocked (except during the login step), so the test blocks them too.", 'let loginWrites = false', "await page.route('**/*', route => (['GET', 'HEAD'].includes(route.request().method()) || loginWrites ? route.continue() : route.abort()))"] : []),
    `await page.goto(${q(f.start ?? '/')})`,
    ...(ctx.live ? [`// The expected value embeds the address the app was served from when it was recorded (${ctx.origin}); compare against this build's address instead.`, 'const live = new URL(page.url()).origin'] : []),
    ...steps,
    ...(words ? ['let marked = null // the tested element\'s box, when recording'] : []),
    'try {',
    ...check.map(l => '  ' + l),
    ...(words ? ['} catch (e) {', `  if (marked) await page.evaluate(${PAGE_MARK}, { box: marked, head: ${q(words.badHead)}, note: ${q(words.fail)}, state: 'bad', pointer: false }).catch(() => {})`, '  throw e'] : []),
    '} finally {',
    "  if (process.env.BEHIQUE_VIDEO === '1') await page.waitForTimeout(1500) // when recording, hold the state the test judged so the recording shows it",
    '}',
  ])}
})
`
}

export function writeExport(dir, findings) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'playwright.config.js'),
    `import { defineConfig } from '@playwright/test'\n// BEHIQUE_VIDEO=1 records every run (Behique keeps one passing and one failing recording per reproduced failure as evidence).\nexport default defineConfig({ testDir: '.', workers: 1, timeout: 60000, expect: { timeout: 5000 }, reporter: [['json']], use: { baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 900 }, video: process.env.BEHIQUE_VIDEO === '1' ? 'on' : 'off' } })\n`)
  for (const f of findings) writeFileSync(join(dir, `${f.id}.spec.js`), specSource(f))
}

/** The runner's arguments and environment. `video`: record each run; its files land in `output`, a folder of its own per run, so runs in flight at once never share one. */
export function runnerArgs(dir, baseUrl, { only = null, video = false } = {}) {
  const output = video ? join(dir, 'test-results', `${only ?? 'all'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) : null
  return {
    args: ['test', ...(only ? [`${only}.spec.js`] : []), ...(output ? ['--output', output] : [])],
    env: { ...process.env, BASE_URL: baseUrl, CI: '1', ...(video ? { BEHIQUE_VIDEO: '1' } : {}) },
    output,
  }
}

/** Run an exported folder with Playwright's own runner against a running app. Returns { results: { F1: true, ... } } (true = test passed). */
export function runExported(dir, baseUrl, opts = {}) { // only: run just <only>.spec.js, so each finding can get its own fresh build
  const { args, env } = runnerArgs(dir, baseUrl, opts)
  const r = spawnSync(join(ROOT, 'node_modules/.bin/playwright'), args, { cwd: dir, env, encoding: 'utf8', timeout: 300_000 })
  return parseRun(r)
}

/** The same as runExported, without blocking: several runs (each against its own build) can be in flight at once. */
export function runExportedAsync(dir, baseUrl, opts = {}) {
  const { args, env } = runnerArgs(dir, baseUrl, opts)
  return new Promise(resolve => {
    const child = spawn(join(ROOT, 'node_modules/.bin/playwright'), args, { cwd: dir, env })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 300_000)
    child.on('error', e => { clearTimeout(timer); resolve({ error: String(e.message).slice(0, 300), results: {} }) })
    child.on('close', () => { clearTimeout(timer); resolve(parseRun({ stdout, stderr })) })
  })
}

export function parseRun(r) {
  let j
  try { j = JSON.parse(r.stdout) } catch { return { error: (r.stderr || r.stdout || 'no output').slice(0, 300), results: {} } }
  const results = {}, errors = {}, videos = {} // errors: first failure message per test (ANSI colours removed); videos: the recording's path, when one was made
  const walk = s => {
    (s.specs ?? []).forEach(sp => {
      const id = String(sp.file).replace(/\.spec\.js$/, '')
      results[id] = sp.ok
      const runs = (sp.tests ?? []).flatMap(t => t.results ?? [])
      const msg = runs.map(x => x.error?.message ?? x.errors?.[0]?.message).find(Boolean)
      if (msg) errors[id] = msg.replace(/\u001b\[[0-9;]*m/g, '')
      const vid = runs.flatMap(x => x.attachments ?? []).find(a => a?.name === 'video' && typeof a.path === 'string' && a.path.endsWith('.webm'))
      if (vid) videos[id] = vid.path
    })
    ;(s.suites ?? []).forEach(walk)
  }
  ;(j.suites ?? []).forEach(walk)
  return { results, errors, videos }
}
