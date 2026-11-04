// Assertions are data, not code: the model says what a CORRECT app would do, the runtime evaluates it.
// evaluate() returns { pass, detail }. A bug is only believed when its assertion FAILS on the app.

function cmp(op, actual, expected) {
  const a = String(actual)
  const e = String(expected ?? '')
  switch (op ?? 'equals') {
    case 'equals': return a === e
    case 'not_equals': return a !== e
    case 'contains': return a.includes(e)
    case 'not_contains': return !a.includes(e)
    case 'matches': return new RegExp(e).test(a)
    case 'eq': return Number(a) === Number(e)
    case 'ne': return Number(a) !== Number(e)
    case 'gte': return Number(a) >= Number(e)
    case 'lte': return Number(a) <= Number(e)
    default: throw new Error('bad op ' + op)
  }
}

function jsonPath(obj, path) {
  return String(path).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

export function validSpec(spec) {
  return spec && typeof spec === 'object' && ['text', 'own_text', 'value', 'visible', 'count', 'checked', 'style', 'dialog', 'attr', 'api', 'class_list', 'scrolls', 'url'].includes(spec.kind)
}

export async function evaluate(session, spec) {
  const p = session.page
  if (!validSpec(spec)) throw new Error('invalid assertion')
  if (spec.kind !== 'api') await p.waitForTimeout(250)
  const loc = () => p.locator(String(spec.selector)).first()
  switch (spec.kind) {
    case 'text': {
      if (!(await loc().count())) return { pass: false, detail: 'selector not found' }
      const t = ((await loc().textContent()) ?? '').trim()
      return { pass: cmp(spec.op, t, spec.value), detail: `text=${JSON.stringify(t.slice(0, 80))}` }
    }
    case 'own_text': { // the text owned by the element itself (its own text nodes, whitespace collapsed): exactly what a recorded text fact holds
      if (!(await loc().count())) return { pass: false, detail: 'selector not found' }
      const t = await loc().evaluate(n => [...n.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join(' ').replace(/\s+/g, ' ').trim())
      return { pass: cmp(spec.op, t, spec.value), detail: `own_text=${JSON.stringify(t.slice(0, 80))}` }
    }
    case 'value': {
      if (!(await loc().count())) return { pass: false, detail: 'selector not found' }
      const v = await loc().inputValue()
      return { pass: cmp(spec.op, v, spec.value), detail: `value=${JSON.stringify(v.slice(0, 80))}` }
    }
    case 'visible': {
      const n = await loc().count()
      const vis = n ? await loc().isVisible() : false
      return { pass: vis === (spec.expect !== false), detail: `visible=${vis}` }
    }
    case 'count': {
      const n = await p.locator(String(spec.selector)).count()
      return { pass: cmp(spec.op ?? 'eq', n, spec.value), detail: `count=${n}` }
    }
    case 'checked': {
      if (!(await loc().count())) return { pass: false, detail: 'selector not found' }
      const c = await loc().isChecked()
      return { pass: c === (spec.expect !== false), detail: `checked=${c}` }
    }
    case 'style': {
      if (!(await loc().count())) return { pass: false, detail: 'selector not found' }
      const v = await loc().evaluate((el, prop) => getComputedStyle(el)[prop], String(spec.property))
      return { pass: cmp(spec.op, v, spec.value), detail: `${spec.property}=${v}` }
    }
    case 'class_list': { // the element's class list, sorted and deduplicated: what a recorded @class fact holds
      if (!(await loc().count())) return { pass: false, detail: 'selector not found' }
      const v = await loc().evaluate(e => [...new Set((e.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))].sort().join(' '))
      return { pass: cmp(spec.op, v, spec.value), detail: `classes=${JSON.stringify(v.slice(0, 80))}` }
    }
    case 'scrolls': { // can the element scroll: content taller than its box and overflow auto or scroll
      if (!(await loc().count())) return { pass: false, detail: 'selector not found' }
      const v = await loc().evaluate(e => e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY))
      return { pass: v === true, detail: `scrolls=${v}` }
    }
    case 'url': { // where the page is: its path and query, never the host, so the same check runs against any build of the app
      const u = new URL(p.url())
      const v = u.pathname + u.search
      return { pass: cmp(spec.op, v, spec.value), detail: `url=${JSON.stringify(v.slice(0, 80))}` }
    }
    case 'attr': {
      if (!(await loc().count())) return { pass: false, detail: 'selector not found' }
      const v = await loc().getAttribute(String(spec.name))
      const detail = `${spec.name}=${JSON.stringify(v?.slice(0, 80) ?? null)}`
      if (spec.op === 'absent') return { pass: v === null, detail } // the attribute must not be there at all; an empty value counts as set
      return { pass: v !== null && cmp(spec.op, v, spec.value), detail }
    }
    case 'dialog': {
      const d = session.dialogs.at(-1) ?? ''
      return { pass: cmp(spec.op, d, spec.value), detail: `dialog=${JSON.stringify(d.slice(0, 80))}` }
    }
    case 'api': {
      const steps = Array.isArray(spec.steps) ? spec.steps : []
      if (!steps.length) throw new Error('api assertion needs steps')
      let last, text = ''
      for (const s of steps) {
        if (typeof s.path !== 'string' || !s.path.startsWith('/') || s.path.startsWith('//')) throw new Error('bad api path')
        last = await session.ctx.request.fetch(session.base + s.path, { method: String(s.method || 'GET').toUpperCase(), data: s.body })
        text = await last.text()
      }
      const checks = []
      if (spec.status !== undefined) checks.push(last.status() === Number(spec.status))
      if (spec.header) checks.push(cmp(spec.header.op, last.headers()[String(spec.header.name).toLowerCase()] ?? '', spec.header.value))
      if (spec.json) {
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = undefined }
        const v = jsonPath(parsed, spec.json.path)
        checks.push(v !== undefined && cmp(spec.json.op, typeof v === 'object' ? JSON.stringify(v) : v, spec.json.value))
      }
      if (!checks.length) throw new Error('api assertion has no checks')
      return { pass: checks.every(Boolean), detail: `status=${last.status()} body=${text.slice(0, 100)}` }
    }
  }
}
