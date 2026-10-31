// Crawler: breadth-first exploration that never changes the app. No model.
// Run tests with: node --test src/release/crawl/run.test.mjs
import { Session } from '../../session.mjs'
import { candidates, selectorFor, stateKey } from './enumerate.mjs'
import { createPlanner } from './plan.mjs'

export const EXTRACT = () => {
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const sels = 'a[href], button, summary, input, select, textarea, [role], [tabindex], [onclick]'
  const implied = el => {
    const r = (el.getAttribute('role') || '').trim()
    if (r) return r.split(/\s+/)[0]
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'summary') return 'summary'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = String(el.getAttribute('type') || '').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      return 'textbox'
    }
    return ''
  }
  const cssPath = el => {
    const parts = []
    let cur = el
    while (cur && cur.nodeType === 1) {
      const tag = cur.tagName.toLowerCase()
      let n = 1
      let sib = cur.previousElementSibling
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) n += 1
        sib = sib.previousElementSibling
      }
      parts.unshift(`${tag}:nth-of-type(${n})`)
      if (tag === 'body') break
      cur = cur.parentElement
      if (!cur) break
      if (parts.length > 12) break
    }
    return parts.join(' > ')
  }
  const labelOf = id => {
    if (!id) return ''
    const bits = String(id).split(/\s+/).filter(Boolean).map(x => {
      const t = document.getElementById(x)
      return t ? (t.innerText || t.textContent || '') : ''
    })
    return bits.join(' ').replace(/\s+/g, ' ').trim()
  }
  const semantic = [...document.querySelectorAll(sels)].slice(0, 400)
  // Many apps make a plain div or li clickable with a script. They show it with a pointer cursor, so an element whose parent does not
  // show one is taken as a clickable thing of its own (role 'clickable'), unless it is already one of the semantic ones above.
  const known = new Set(semantic)
  const pointers = []
  try {
    const all = document.body ? document.body.querySelectorAll('*') : []
    for (let i = 0; i < all.length && i < 4000 && semantic.length + pointers.length < 400; i++) {
      const el = all[i]
      if (known.has(el) || el.closest('a[href], button, summary, select, [role]')) continue
      if (getComputedStyle(el).cursor !== 'pointer') continue
      const parent = el.parentElement
      if (parent && getComputedStyle(parent).cursor === 'pointer') continue
      if (!(el.innerText || '').trim()) continue
      pointers.push(el)
    }
  } catch {}
  const els = [...semantic, ...pointers]
  const items = els.map(el => {
    const tag = el.tagName.toLowerCase()
    const role = implied(el) || (pointers.includes(el) ? 'clickable' : '')
    const ariaLabel = (el.getAttribute('aria-label') || '').trim()
    const labelled = labelOf(el.getAttribute('aria-labelledby'))
    const own = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    const title = (el.getAttribute('title') || '').trim()
    let imgAlt = ''
    try {
      const img = el.querySelector('img[alt]')
      if (img) imgAlt = (img.getAttribute('alt') || '').trim()
    } catch {}
    const placeholder = (el.getAttribute('placeholder') || '').trim()
    let btnValue = ''
    if (tag === 'input' || tag === 'button') btnValue = (el.getAttribute('value') || '').trim()
    const name = ariaLabel || labelled || own || title || imgAlt || placeholder || btnValue || ''
    let href = ''
    try {
      if (typeof el.href === 'string') href = el.href
      else if (el.hasAttribute('href')) href = new URL(el.getAttribute('href'), document.baseURI).href
    } catch { href = '' }
    const rect = el.getBoundingClientRect()
    let vis = rect.width > 0 && rect.height > 0 && document.contains(el)
    if (vis) {
      try {
        if (typeof el.checkVisibility === 'function') vis = el.checkVisibility({ visibilityProperty: true })
        else {
          const cs = getComputedStyle(el)
          if (cs.visibility === 'hidden' || cs.display === 'none') vis = false
        }
      } catch {}
    }
    const form = el.closest ? el.closest('form') : null
    return {
      tag,
      role,
      name: clean(name),
      href,
      type: (el.getAttribute('type') || '').toLowerCase(),
      disabled: el.disabled === true || el.hasAttribute('disabled'),
      visible: vis === true,
      inForm: !!form,
      formMethod: form ? String(form.getAttribute('method') || '').toLowerCase() : '',
      download: el.hasAttribute('download'),
      path: cssPath(el),
      nth: 0,
      x: Math.round(rect.x || 0),
      y: Math.round(rect.y || 0),
      w: Math.round(rect.width || 0),
      h: Math.round(rect.height || 0)
    }
  })
  const counts = new Map()
  for (const d of items) {
    const k = `${d.role}|${d.name}`
    d.nth = counts.get(k) ?? 0
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return items
}

// Returns the CSS path (same shape as desc.path) for a given element.
const PATH_FN = el => {
  const parts = []
  let cur = el
  while (cur && cur.nodeType === 1) {
    const tag = cur.tagName.toLowerCase()
    let n = 1
    let sib = cur.previousElementSibling
    while (sib) {
      if (sib.tagName.toLowerCase() === tag) n += 1
      sib = sib.previousElementSibling
    }
    parts.unshift(tag + ':nth-of-type(' + n + ')')
    if (tag === 'body') break
    cur = cur.parentElement
    if (!cur) break
  }
  return parts.join(' > ')
}

export async function crawlApp(base, options = {}) {
  const {
    startPath = '/',
    viewport = { width: 1280, height: 900 },
    maxDepth = 2,
    maxPaths = 40,
    maxPerPage = 12,
    maxFlows = 20, // a recorded step is cheap, and the release check compares what every one of them shows
    budgetMs = 120000,
    log = () => {}
  } = options
  const origin = new URL(base).origin
  const planner = createPlanner({ maxDepth, maxPaths, maxPerPage })
  const keysByPath = new Map() // for each path tried: the keys of every control on the page it reached
  const pathId = path => path.map(a => a.selector ?? a.type).join(' > ')
  const started = Date.now()
  let stoppedBy = 'done'

  for (;;) {
    if (Date.now() - started >= budgetMs) {
      stoppedBy = 'budget'
      break
    }
    const path = planner.next()
    if (path === null) break
    const s = new Session(base, { viewport, navigationTimeoutMs: 30000 })
    try {
      await s.open()
      await s.ctx.route('**/*', route => {
        const req = route.request()
        const m = req.method()
        if (m !== 'GET' && m !== 'HEAD') return route.abort()
        try {
          if (new URL(req.url()).origin !== origin) return route.abort()
        } catch {
          return route.abort()
        }
        return route.continue()
      })
      s.page.removeAllListeners('dialog')
      s.page.on('dialog', d => d.dismiss().catch(() => {}))
      if (startPath !== '/') await s.act({ type: 'goto', path: startPath })
      let ok = true
      for (const a of path) {
        try {
          await s.act(a)
        } catch {
          ok = false
          break
        }
      }
      if (!ok) {
        planner.failed(path)
        try { log(`fail ${path.length} steps`) } catch {}
        continue
      }
      await s.page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {})
      await s.page.waitForTimeout(300)
      const descs = await s.page.evaluate(EXTRACT)
      const url = s.page.url()
      const title = await s.page.title().catch(() => '')
      // What a click just revealed (a menu, an opened article) is the most likely place for something worth comparing, so the
      // controls that were not on the page before this click come first; the rest follow in their usual order.
      const everything = candidates(descs, { origin, perPage: 1000 })
      const before = keysByPath.get(pathId(path.slice(0, -1)))
      keysByPath.set(pathId(path), new Set(everything.map(c => c.key)))
      const fresh = before ? everything.filter(c => !before.has(c.key)) : []
      let cands = [...fresh, ...(before ? everything.filter(c => before.has(c.key)) : everything)].slice(0, maxPerPage)
      // Verify selectors before report so the planner queues verified ones.
      const selToPath = new Map()
      for (const d of descs) {
        try { selToPath.set(selectorFor(d), d.path) } catch {}
      }
      const verified = []
      for (const c of cands) {
        let sel = c.action.selector
        try {
          const count = await s.page.locator(sel).count()
          if (count < 1) throw new Error('no match')
          const firstPath = await s.page.locator(sel).first().evaluate(PATH_FN)
          const want = selToPath.get(sel)
          if (want !== undefined && firstPath !== want) sel = `css=${want}`
        } catch {
          const want = selToPath.get(c.action.selector)
          if (want) sel = `css=${want}`
        }
        verified.push(sel === c.action.selector ? c : { ...c, action: { ...c.action, selector: sel } })
      }
      cands = verified
      const key = stateKey(url, descs)
      const state = { key, url, title, candidates: cands }
      planner.report(path, state)
      try { log(`path ${path.length} -> ${key} ${url}`) } catch {}
      if (Date.now() - started >= budgetMs) {
        stoppedBy = 'budget'
        break
      }
    } catch (e) {
      try { planner.failed(path) } catch {}
      try { log(`fail ${path.length} steps: ${String((e && e.message) || e).split('\n')[0].slice(0, 120)}`) } catch {}
    } finally {
      await s.close()
    }
  }

  const stats = planner.stats()
  if (stoppedBy !== 'budget') {
    stoppedBy = stats.tried >= maxPaths ? 'paths' : 'done'
  }
  const flows = planner.flows({ max: maxFlows })
  const steps = planner.toSteps(flows, { startPath })
  return { steps, flows, states: planner.states(), stats, stoppedBy, ms: Date.now() - started }
}
