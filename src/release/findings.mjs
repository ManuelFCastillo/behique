// Pure logic for turning changed facts into findings and judging them.
// Run offline: node --test src/release/findings.test.mjs
// A person wires this into confirm.mjs afterwards.
import { classChange, noticeOf, rankFindings } from './notice.mjs'

/**
 * A changed fact as a finding the exporter understands, or null if it cannot be turned into a test.
 * Markup facts are keyed by body/tag[n]/..., which is an XPath. A scroll fact becomes a RELATIVE test: how far the last
 * action moved the page, compared with how far it moved it on the old version (no absolute pixel positions).
 */
/**
 * The actions a test must replay to reach step i. The crawl joins its flows with a `goto`, which starts the app over, so a test
 * for a step in the third flow replays that flow only, not the two before it (they would only add time and shared state).
 * A `goto /` is the test's own starting point and is left out; a direct load of another page is kept, since it is the step.
 */
function historyFor(actions, i) {
  for (let g = i - 1; g >= 0; g--) if (actions[g]?.type === 'goto') return actions[g].path === '/' ? actions.slice(g + 1, i) : actions.slice(g, i)
  return actions.slice(0, i)
}

export function factToFinding(d, actions, start, baseline, id = 'R1') {
  if (d.key === 'step@error') return null // a step that could not be performed is reported, but there is no element to test
  const removed = d.kind === 'removed', added = d.kind === 'added'
  if ((removed || added) && d.key === 'window@scrollY') return null // the scroll position is always recorded; it cannot vanish or appear
  if (d.key === 'window@scrollY') {
    const before = baseline.stable[`${d.i - 1}|${d.key}`]
    if (d.i < 1 || typeof before !== 'number' || typeof d.was !== 'number') return null
    const moved = d.was - before, a = actions[d.i - 1]
    return {
      id, start,
      title: `the page scrolls by ${moved} pixels after: ${a.type} ${a.selector ?? ''}`.slice(0, 140),
      expected: `the page scrolls by ${moved} pixels (the old version)`, actual: `the page ends ${Math.abs(d.now - d.was)} pixels ${d.now < d.was ? 'higher up' : 'lower down'} than the old version leaves it`,
      history: historyFor(actions, d.i), assert: { kind: 'scroll_delta', value: moved },
    }
  }
  // An area that could scroll on the good version and cannot on the candidate (the fact is only ever 'y', so it vanishes rather than
  // changes): the test asks the same element whether it can scroll. An area that newly scrolls is not a loss and is not tested.
  if (d.key.endsWith('#scrolls')) {
    if (!removed) return null
    const el = d.key.slice(0, -'#scrolls'.length)
    return {
      id, start,
      title: `${el.split('/').slice(-2).join('/')} after step ${d.i} can still scroll, as on the previous release`,
      expected: 'can scroll (content taller than its box, overflow auto or scroll)', actual: 'cannot scroll on the candidate',
      history: historyFor(actions, d.i), assert: { kind: 'scrolls', selector: 'xpath=/html/' + el },
    }
  }
  const m = d.key.match(/^(.*?)(?:@([^/]+)|#text)$/)
  const selector = 'xpath=/html/' + m[1]
  const attr = m[2]
  const long = String(d.was).length >= 300 // facts cut values at 300 characters
  const what = attr === 'class' ? `classes of ${m[1].split('/').slice(-2).join('/')}` : attr ? `${attr} of ${m[1].split('/').slice(-2).join('/')}` : `text of ${m[1].split('/').slice(-2).join('/')}`
  // An attribute that appeared on the candidate (inert, disabled, hidden) is tested the other way round: the old version has no such
  // attribute, so the test expects it absent and fails on the candidate where it is set.
  if (added) {
    if (!attr) return null
    return {
      id, start,
      title: `${what} after step ${d.i} is absent, as on the previous release`,
      expected: 'absent (not set on the previous release)', actual: JSON.stringify(d.now),
      history: historyFor(actions, d.i), assert: { kind: 'attr', selector, name: attr, op: 'absent', value: '' },
    }
  }
  const assert = attr === 'class'
    ? { kind: 'class_list', selector, op: long ? 'contains' : 'equals', value: d.was } // the recorded value is the sorted class list, so the test sorts too
    : attr
    ? { kind: 'attr', selector, name: attr, op: long ? 'contains' : 'equals', value: d.was }
    : { kind: 'own_text', selector, op: long ? 'contains' : 'equals', value: d.was } // the fact is the element's own text, cut at 300 characters: compare it exactly, or a longer new text still contains the old one
  // A vanished fact is tested with the same assertion: the old value is expected, so the test fails on the candidate whether the
  // whole element is gone (the locator finds nothing) or only its attribute or text is.
  return {
    id, start,
    title: removed ? `${what} after step ${d.i} is still there, as on the previous release` : `${what} after step ${d.i} keeps the previous release's value`,
    expected: JSON.stringify(d.was), actual: removed ? 'missing on the candidate' : JSON.stringify(d.now),
    history: historyFor(actions, d.i), assert,
  }
}

// Attributes whose appearance a person feels at once: a control that stops working, a region that goes dead or hidden.
const APPEARS = new Set(['inert', 'disabled', 'hidden', 'readonly', 'checked', 'selected', 'open', 'aria-hidden', 'aria-disabled', 'aria-expanded', 'aria-busy', 'aria-invalid'])

/**
 * The state attributes that are newly set on the candidate, on elements the good version also has at that step. New elements
 * bring their own attributes along and are not a state change of anything; those are left out. Returns the added diffs, in order.
 */
export function appearedStates(diffs, baseline) {
  const added = (Array.isArray(diffs) ? diffs : []).filter(d => d && d.kind === 'added' && typeof d.key === 'string')
  if (!added.length) return []
  const present = new Set()
  for (const id of Object.keys(baseline?.stable ?? {})) {
    const bar = id.indexOf('|')
    if (bar > 0) present.add(`${id.slice(0, bar)}|${elementOf(id.slice(bar + 1))}`)
  }
  return added.filter(d => {
    const attr = (d.key.match(/@([^/@]+)$/) ?? [])[1]
    return Boolean(attr) && APPEARS.has(attr) && present.has(`${d.i}|${elementOf(d.key)}`)
  })
}

const PREFERRED = ['#text', '@href', '@value', '@src', '@alt', '@title', '@placeholder', '@aria-label', '@action']
const NAMING = new Set(['#text', '@title', '@aria-label', '@alt', '@placeholder']) // the facts that carry words a person read on the element
const elementOf = key => key.replace(/(@[^/]+|#text|#scrolls)$/, '')
const suffixOf = key => (key.match(/(@[^/]+|#text|#scrolls)$/) ?? ['', ''])[1]

/**
 * One fact per vanished element. An element that disappears takes every attribute and text of itself and its descendants with it,
 * so the removed facts of one step are collapsed to the elements whose ancestors are all still there (the roots of what vanished),
 * and for each root the fact a person would miss first is kept: its text, then a link, a value, a picture.
 * Takes the ranked diff list; returns removed diffs only, in step order, each marked `vanished: n` with how many facts it stands for.
 * With the baseline (its `stable` facts, keyed `step|key`), an element that kept any other recorded fact on the candidate is still
 * there: a fact dropped from it (a scoped-style attribute that moved, say) is its own entry, marked `stillThere`, and never a root that
 * swallows the facts beneath it. Without the baseline every removed fact counts as its element vanishing, as before.
 */
export function vanishedRoots(diffs, baseline = null) {
  const removed = (Array.isArray(diffs) ? diffs : []).filter(d => d && d.kind === 'removed' && typeof d.key === 'string' && d.key !== 'step@error' && d.key !== 'window@scrollY')
  const bySteps = new Map()
  for (const d of removed) { if (!bySteps.has(d.i)) bySteps.set(d.i, []); bySteps.get(d.i).push(d) }
  const alive = new Set() // `step|element` of every element with a recorded fact the candidate still has
  if (baseline?.stable && typeof baseline.stable === 'object') {
    const gone = new Set(removed.map(d => `${d.i}|${d.key}`))
    for (const k of Object.keys(baseline.stable)) {
      if (gone.has(k)) continue
      const bar = k.indexOf('|'); if (bar < 0) continue
      const key = k.slice(bar + 1); if (key === 'window@scrollY' || key === 'step@error') continue
      alive.add(`${k.slice(0, bar)}|${elementOf(key)}`)
    }
  }
  const out = []
  for (const [step, all] of [...bySteps.entries()].sort((a, b) => a[0] - b[0])) {
    // An area that lost its ability to scroll is still there, so its loss is its own entry and never a root that swallows the facts
    // beneath it; it is left out only when the whole element is under a root that vanished. The same goes for a fact dropped from an
    // element the candidate still has.
    const scrollLoss = all.filter(d => d.key.endsWith('#scrolls'))
    const dropped = all.filter(d => !d.key.endsWith('#scrolls') && alive.has(`${step}|${elementOf(d.key)}`))
    const list = all.filter(d => !d.key.endsWith('#scrolls') && !dropped.includes(d))
    const elements = new Set(list.map(d => elementOf(d.key)))
    const isRoot = el => ![...elements].some(o => o !== el && el.startsWith(o + '/'))
    const roots = new Map()
    for (const d of list) {
      const el = elementOf(d.key)
      if (!isRoot(el)) continue
      if (!roots.has(el)) roots.set(el, [])
      roots.get(el).push(d)
    }
    for (const [el, facts] of roots) {
      const under = list.filter(d => elementOf(d.key) === el || elementOf(d.key).startsWith(el + '/')).length
      const rank = d => { const i = PREFERRED.indexOf(suffixOf(d.key)); return i < 0 ? PREFERRED.length : i }
      const pick = [...facts].sort((a, b) => rank(a) - rank(b))[0]
      // the words a person saw inside what vanished (its texts, titles, labels), so the record can name it: the first three, and how many there were
      const words = [...new Set(list.filter(d => (elementOf(d.key) === el || elementOf(d.key).startsWith(el + '/')) && NAMING.has(suffixOf(d.key)) && typeof d.was === 'string' && d.was.trim()).map(d => d.was.trim()))]
      out.push({ ...pick, vanished: under, ...(words.length ? { names: words.slice(0, 3), namesTotal: words.length } : {}) })
    }
    const underRoot = el => [...roots.keys()].some(r => el === r || el.startsWith(r + '/'))
    for (const d of dropped) if (!underRoot(elementOf(d.key))) out.push({ ...d, vanished: 1, stillThere: true })
    for (const d of scrollLoss) if (!underRoot(elementOf(d.key))) out.push({ ...d, vanished: 1 })
  }
  return out
}

/**
 * Turn the ranked changed facts (and the vanished elements from vanishedRoots) into at most max findings, earliest step per key first.
 * Each finding carries `notice` ({ cls, why }: would a person notice it, see notice.mjs). Findings are ordered by that class,
 * visible before churn, so the cap keeps what a person would notice and R1 is the most noticeable; the given order holds inside a
 * class. Third-party content (an ad, a widget loaded from another host) never becomes a finding: it is skipped and listed as such.
 * `origin` is where the facts were recorded, so its host counts as the app's own. `refs` ({ good, cand }) are the versions compared,
 * so the page's own version label ranks as expected churn rather than as the change to bisect.
 * Returns { findings, skipped } where skipped entries look like { key, i, why }.
 */
export function selectFindings(changed, actions, start, baseline, { max = 5, origin = null, refs = null } = {}) {
  if (!Array.isArray(changed)) return { findings: [], skipped: [] }
  // Added facts count only when they are a state newly set (appearedStates); a new element's own attributes are not a change of anything.
  const list = changed.filter(d => d && typeof d.key === 'string' && (d.kind === 'changed' || d.kind === 'removed' || (d.kind === 'added' && APPEARS.has((d.key.match(/@([^/@]+)$/) ?? [])[1]))))
  if (list.length === 0) return { findings: [], skipped: [] }
  const limit = Number(max)
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 5
  // Keep only the earliest step (smallest i) for each key.
  const earliest = new Map()
  const skipped = []
  for (const d of list) {
    if (!earliest.has(d.key)) {
      earliest.set(d.key, d)
      continue
    }
    const first = earliest.get(d.key)
    if (d.i < first.i) {
      skipped.push({ key: d.key, i: first.i, why: `carried over from step ${d.i}` })
      earliest.set(d.key, d)
    } else {
      skipped.push({ key: d.key, i: d.i, why: `carried over from step ${first.i}` })
    }
  }
  // Kept facts stay in the given order.
  const kept = []
  for (const d of list) {
    if (earliest.get(d.key) === d && !kept.includes(d)) kept.push(d)
  }
  const testable = []
  for (const d of kept) {
    const notice = noticeOf(d, { origin, refs })
    if (notice.cls === 'third_party') {
      skipped.push({ key: d.key, i: d.i, why: `third-party content (${notice.why})` })
      continue
    }
    let finding = null
    try {
      finding = factToFinding(d, actions, start, baseline, 'R0')
    } catch {
      finding = null
    }
    if (!finding) {
      skipped.push({ key: d.key, i: d.i, why: 'cannot be written as a test' })
      continue
    }
    testable.push({ ...finding, notice, fact: { key: d.key, i: d.i, was: d.was, now: d.now, ...(d.kind === 'removed' ? { removed: true, vanished: d.vanished ?? 1, ...(d.stillThere ? { stillThere: true } : {}), ...(d.names?.length ? { names: d.names, namesTotal: d.namesTotal } : {}) } : {}), ...(d.kind === 'added' ? { appeared: true } : {}) } })
  }
  const findings = []
  const alike = new Map() // the same class change on several elements (one stylesheet edit, many panes) is one finding; the others are listed on it
  for (const f of rankFindings(testable)) {
    const sig = classSignature(f.fact), same = sig ? alike.get(sig) : null
    if (same) {
      same.alike.push(f.fact.key)
      skipped.push({ key: f.fact.key, i: f.fact.i, why: `the same class change as ${same.id}` })
      continue
    }
    if (findings.length >= cap) {
      skipped.push({ key: f.fact.key, i: f.fact.i, why: `over the limit of ${cap} findings` })
      continue
    }
    const out = { ...f, id: `R${findings.length + 1}`, alike: [] }
    findings.push(out)
    if (sig) alike.set(sig, out)
  }
  return { findings, skipped }
}

/** What a class change is, regardless of the element: the classes that came and went. Null for anything but a changed @class fact. */
function classSignature(fact) {
  if (!fact || fact.removed || fact.appeared || !String(fact.key).endsWith('@class')) return null
  const { added, removed } = classChange(fact.was, fact.now)
  if (!added.length && !removed.length) return null
  return `${[...added].sort().join(' ')}|${[...removed].sort().join(' ')}`
}

/**
 * Judge each finding over the runs of each version.
 * Each run is what runExported returns: { results: { R1: true }, errors?, error? }.
 */
export function judgeFindings(findings, goodRuns, candRuns) {
  if (!Array.isArray(findings)) return []
  const good = Array.isArray(goodRuns) ? goodRuns : []
  const cand = Array.isArray(candRuns) ? candRuns : []
  return findings.map(f => {
    const id = f.id
    const goodBools = good.map(r => r?.results?.[id])
    const candBools = cand.map(r => r?.results?.[id])
    const hasError = [...good, ...cand].some(r => !r || r.error || typeof r?.results?.[id] !== 'boolean')
    const goodPassed = goodBools.filter(v => v === true).length
    const candFailed = candBools.filter(v => v === false).length
    const runs = cand.length
    if (hasError) return { id, verdict: 'error', goodPassed, candFailed, runs }
    const goodAllPass = good.length > 0 && goodBools.every(v => v === true)
    const goodAllFail = good.length > 0 && goodBools.every(v => v === false)
    const candAllPass = cand.length > 0 && candBools.every(v => v === true)
    const candAllFail = cand.length > 0 && candBools.every(v => v === false)
    if (goodAllPass && candAllFail) return { id, verdict: 'confirmed', goodPassed, candFailed, runs }
    if (goodAllFail) return { id, verdict: 'fails_both', goodPassed, candFailed, runs }
    if (goodAllPass && candAllPass) return { id, verdict: 'not_reproduced', goodPassed, candFailed, runs }
    return { id, verdict: 'unstable', goodPassed, candFailed, runs }
  })
}

/** The first entry with verdict confirmed, or null. */
export function firstConfirmed(judged) {
  if (!Array.isArray(judged)) return null
  return judged.find(j => j?.verdict === 'confirmed') ?? null
}

/** One plain sentence for a log line. Leaves out parts that are zero. */
export function summarize(judged, skipped) {
  const list = Array.isArray(judged) ? judged : []
  const skips = Array.isArray(skipped) ? skipped : []
  const n = list.length
  const by = verdict => list.filter(j => j?.verdict === verdict)
  const confirmed = by('confirmed')
  const parts = []
  if (n === 0) {
    parts.push('0 of 0 findings confirmed')
  } else {
    parts.push(`${confirmed.length} of ${n} findings confirmed${confirmed.length ? ` (${confirmed.map(j => j.id).join(', ')})` : ''}`)
  }
  for (const verdict of ['error', 'fails_both', 'not_reproduced', 'unstable']) {
    const group = by(verdict)
    if (group.length) parts.push(`${group.length} ${verdict} (${group.map(j => j.id).join(', ')})`)
  }
  const carried = skips.filter(s => typeof s?.why === 'string' && s.why.includes('carried over')).length
  if (carried) parts.push(`${carried} fact${carried === 1 ? '' : 's'} carried over from an earlier step`)
  return parts.join('; ')
}
