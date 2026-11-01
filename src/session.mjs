// One browser session against an app: observe (screenshot + accessibility tree), act, and a log of
// network/dialog/console events. Every action that succeeds is appended to `history` so a finding
// can be replayed from a fresh app and a fresh browser.
import { chromium } from 'playwright'

const KEYFN = `const __key = el => (el.id ? '#' + el.id : el.getAttribute('data-testid') ? '[testid=' + el.getAttribute('data-testid') + ']' : el.tagName.toLowerCase() + ':' + ((el.innerText || el.getAttribute('aria-label') || el.name || el.type || '').trim().slice(0, 30)));`
// Marks every interactive element the tester touches, in sessionStorage (survives reloads).
const INIT = `(() => { ${KEYFN}
  const mark = e => { const el = e.target.closest && e.target.closest('button,a,input,select,textarea,summary,label'); if (!el) return;
    try { const s = JSON.parse(sessionStorage.__bh || '{}'); s[__key(el)] = 1; sessionStorage.__bh = JSON.stringify(s) } catch {} };
  ['click', 'input', 'change'].forEach(t => document.addEventListener(t, mark, true)) })()`

export const normPath = p => String(p).split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id')

export const ACTION_TYPES =['click', 'fill', 'press', 'select', 'check', 'uncheck', 'hover', 'reload', 'wait', 'goto', 'api']

export class Session {
  constructor(baseUrl, { viewport = { width: 820, height: 900 }, navigationTimeoutMs = null } = {}) {
    this.viewport = viewport
    this.navigationTimeoutMs = navigationTimeoutMs // null keeps the 3 s default; a dev server compiling on the first request needs far longer
    this.base = baseUrl.replace(/\/$/, '')
    this.log = []
    this.dialogs = []
    this.history = []
    this.seen = new Map() // "METHOD /normalised/path" -> Set of body field names, for requests the app's own pages made
  }

  async open() {
    this.browser = await chromium.launch()
    this.ctx = await this.browser.newContext({ viewport: this.viewport })
    await this.ctx.addInitScript(INIT)
    this.page = await this.ctx.newPage()
    this.page.setDefaultTimeout(3000)
    if (this.navigationTimeoutMs) this.page.setDefaultNavigationTimeout(this.navigationTimeoutMs)
    this.page.on('dialog', async d => {
      this.dialogs.push(d.message())
      this.log.push(`dialog(${d.type()}): ${JSON.stringify(d.message())}`)
      await d.accept()
    })
    this.page.on('pageerror', e => this.log.push('pageerror: ' + String(e.message).slice(0, 160)))
    this.page.on('console', m => { if (m.type() === 'error') this.log.push('console.error: ' + m.text().slice(0, 160)) })
    this.page.on('request', req => {
      try {
        const u = new URL(req.url())
        if (!u.pathname.startsWith('/api')) return
        const key = `${req.method()} ${normPath(u.pathname)}`
        const fields = this.seen.get(key) ?? new Set()
        const body = req.postData()
        if (body) { try { Object.keys(JSON.parse(body)).forEach(k => fields.add(k)) } catch {} }
        this.seen.set(key, fields)
      } catch {}
    })
    this.page.on('response', async r => {
      try {
        const u = new URL(r.url())
        if (!u.pathname.startsWith('/api')) return
        let body = ''
        try { body = (await r.text()).slice(0, 160) } catch {}
        this.log.push(`${r.request().method()} ${u.pathname} -> ${r.status()} [${r.headers()['content-type'] ?? ''}] ${body}`)
      } catch {}
    })
    await this.page.goto(this.base + '/')
    return this
  }

  /** Execute one action. Returns a short result string; throws if it fails. Not recorded here. */
  async act(a) {
    // A read-only recording blocks every request but GET and HEAD, except while a profile's login step runs (its actions are marked
    // fromLogin): the login's own POST must go through, and the flag drops at the first action after it.
    this.writesAllowed = Boolean(a && a.fromLogin)
    const p = this.page
    const loc = () => {
      if (typeof a.selector !== 'string' || !a.selector) throw new Error('selector is required')
      return p.locator(a.selector).first()
    }
    let result = 'ok'
    switch (a.type) {
      case 'click': await loc().click(); break
      case 'fill': await loc().fill(String(a.text ?? '')); break
      case 'press': a.selector ? await loc().press(String(a.key)) : await p.keyboard.press(String(a.key)); break
      case 'select': await loc().selectOption(String(a.value)); break
      case 'scroll': await loc().evaluate(e => e.scrollIntoView({ block: 'center' })); break // pipeline steps only; not in ACTION_TYPES, so the explorer never offers it
      case 'check': await loc().check(); break
      case 'uncheck': await loc().uncheck(); break
      case 'hover': await loc().hover(); break
      case 'reload': await p.reload(); break
      case 'wait': await p.waitForTimeout(Math.min(Number(a.ms) || 500, 2000)); break
      case 'goto':
        if (typeof a.path !== 'string' || !a.path.startsWith('/') || a.path.startsWith('//')) throw new Error('goto path must start with a single /')
        await p.goto(this.base + a.path); break
      case 'api': {
        if (typeof a.path !== 'string' || !a.path.startsWith('/') || a.path.startsWith('//')) throw new Error('api path must start with a single /')
        const r = await this.ctx.request.fetch(this.base + a.path, { method: String(a.method || 'GET').toUpperCase(), data: a.body })
        result = `${r.status()} [${r.headers()['content-type'] ?? ''}] ${(await r.text()).slice(0, 200)}`
        break
      }
      default: throw new Error('unknown action type ' + a.type)
    }
    if (a.type !== 'wait') await p.waitForTimeout(200)
    return result
  }

  async observe() {
    const png = await this.page.screenshot({ fullPage: true, timeout: 20000 })
    let aria
    try { aria = await this.page.locator('body').ariaSnapshot() } catch { aria = '(accessibility snapshot failed)' }
    return { png, aria: aria.slice(0, 7000) }
  }

  drainLog() { return this.log.splice(0) }

  /** Interactive elements on the page the tester has not touched yet (completion check). */
  async untouched() {
    return this.page.evaluate(`(() => { ${KEYFN}
      const t = JSON.parse(sessionStorage.__bh || '{}');
      const els = [...document.querySelectorAll('button,a[href],input,select,textarea')].filter(e => e.offsetParent !== null);
      return [...new Set(els.map(__key))].filter(k => !t[k]) })()`)
  }

  async close() { await this.browser?.close().catch(() => {}) }
}
