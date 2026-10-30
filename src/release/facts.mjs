// Page facts: a flat map of "what the page says" at one moment, recorded after every step of a run.
//   key   = path of tag:nth-of-type from <body>, then @attribute or #text. Ids and classes are left out of the path (they churn).
//   value = the attribute value, or the visible text owned by that element.
// Run-twice masking: record the SAME build twice from a clean install. Any fact that differs between the two runs
// (timestamps, generated ids) is volatile and is ignored when builds are compared. Everything else is a stable fact.
import { Session } from '../session.mjs'

const EXTRACT = () => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META', 'svg', 'path'])
  const ATTRS = new Set(['href', 'src', 'value', 'title', 'alt', 'placeholder', 'aria-label', 'aria-expanded', 'aria-hidden', 'action', 'name', 'type', 'for', 'rel', 'target', 'disabled', 'checked', 'selected'])
  const out = {}
  const walk = (el, path) => {
    if (SKIP.has(el.tagName)) return
    for (const a of el.attributes) if (ATTRS.has(a.name) || a.name.startsWith('data-')) out[path + '@' + a.name] = a.value.slice(0, 300)
    if (el.checkVisibility && el.checkVisibility({ visibilityProperty: true })) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim()
      if (own) out[path + '#text'] = own.slice(0, 300)
    }
    const seen = {}
    for (const c of el.children) { const t = c.tagName.toLowerCase(); seen[t] = (seen[t] ?? 0) + 1; walk(c, `${path}/${t}[${seen[t]}]`) }
  }
  walk(document.body, 'body')
  out['window@scrollY'] = Math.round(window.scrollY) // behaviour, not markup: how far the page is scrolled
  return out
}

/** Open the build, record facts, perform each action and record again. Returns [{ label, facts }]. */
/** readOnly: no request but GET or HEAD gets through, so every step sees the app exactly as it was seeded (a click that would mark something read, or save, changes nothing). */
export async function recordRun(base, actions, { viewport = { width: 1280, height: 900 }, readOnly = false } = {}) {
  const s = new Session(base, { viewport })
  const steps = []
  try {
    await s.open()
    if (readOnly) await s.ctx.route('**/*', route => (['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort()))
    await s.page.waitForLoadState('networkidle').catch(() => {})
    steps.push({ label: 'start', facts: await s.page.evaluate(EXTRACT) })
    for (const [i, a] of actions.entries()) {
      // A `goto /` between flows (the crawl writes one) starts the app over, exactly like a test that opens a new browser: cookies and
      // storage are cleared, so a flow does not see what an earlier flow changed (a view setting, a filter, a session).
      if (a.type === 'goto' && a.path === '/') { await s.ctx.clearCookies(); await s.page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch {} }).catch(() => {}) }
      let failed = null
      try { await s.act(a) } catch (e) { failed = String(e.message ?? e).split('\n')[0].slice(0, 100) } // a click that cannot be made (the element is gone in this version) is itself a difference worth recording
      await s.page.waitForLoadState('networkidle').catch(() => {})
      const facts = await s.page.evaluate(EXTRACT)
      if (failed) facts['step@error'] = failed
      steps.push({ label: `${i + 1}:${a.type} ${a.selector ?? a.path ?? ''}`.slice(0, 80), facts })
    }
  } finally { await s.close() }
  return steps
}

/** Compare two recordings of the same build. Facts that differ become volatile; the rest are the baseline. */
export function buildBaseline(runA, runB) {
  if (runA.length !== runB.length) throw new Error('the two recordings have different numbers of steps')
  const stable = {}, volatile = {}
  runA.forEach((sa, i) => {
    const fa = sa.facts, fb = runB[i].facts
    for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      const id = `${i}|${k}`
      if (fa[k] !== undefined && fa[k] === fb[k]) stable[id] = fa[k]
      else volatile[id] = { a: fa[k] ?? null, b: fb[k] ?? null }
    }
  })
  return { labels: runA.map(s => s.label), stable, volatile }
}

/** What differs between a recording and the baseline, ignoring volatile facts. */
export function diffFacts(baseline, run) {
  const diffs = []
  const seen = new Set()
  run.forEach((s, i) => {
    for (const [k, now] of Object.entries(s.facts)) {
      const id = `${i}|${k}`
      seen.add(id)
      if (id in baseline.volatile) continue
      if (!(id in baseline.stable)) diffs.push({ i, step: baseline.labels[i], key: k, kind: 'added', was: null, now })
      else if (baseline.stable[id] !== now) diffs.push({ i, step: baseline.labels[i], key: k, kind: 'changed', was: baseline.stable[id], now })
    }
  })
  for (const [id, was] of Object.entries(baseline.stable)) {
    if (seen.has(id)) continue
    const i = +id.split('|')[0]
    diffs.push({ i, step: baseline.labels[i], key: id.slice(id.indexOf('|') + 1), kind: 'removed', was, now: null })
  }
  return diffs
}

const suffixOf = key => key.match(/(@[^/]+|#text)$/)[0]

/**
 * Order differences by how likely they are a behaviour change: changed, then added, then removed, then moved.
 * A "moved" fact is a removed + added pair with the same step, attribute and value, so only its position changed.
 * Pairing is per (step, attribute, value) count, so a real loss or gain of one copy still shows as added/removed.
 */
export function rankDiffs(diffs) {
  const pool = new Map()
  for (const d of diffs) if (d.kind === 'removed') {
    const g = `${d.i}|${suffixOf(d.key)}|${d.was}`
    if (!pool.has(g)) pool.set(g, [])
    pool.get(g).push(d)
  }
  const paired = new Set(), moved = [], added = []
  for (const d of diffs) {
    if (d.kind !== 'added') continue
    const from = pool.get(`${d.i}|${suffixOf(d.key)}|${d.now}`)?.shift()
    if (from) { paired.add(from); moved.push({ ...d, kind: 'moved', from: from.key, was: from.was }) } else added.push(d)
  }
  return [
    ...diffs.filter(d => d.kind === 'changed'),
    ...added,
    ...diffs.filter(d => d.kind === 'removed' && !paired.has(d)),
    ...moved,
  ]
}
