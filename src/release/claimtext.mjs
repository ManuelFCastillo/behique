// The words of a recorded difference, for two readers: the record (one sentence, exact, hashed) and a tired person (the same
// facts, grouped and shortened). `changesText` writes the record's enumeration, with identical changes counted once; `plainClaim`
// reads a recorded claim back into a lead line and short items, so the dashboard can show it readably without touching the text
// the hash covers. Both are pure.

import { classChange } from './notice.mjs'

const short = k => k.split('/').slice(-2).join('/')
const cut = (v, n) => { const t = JSON.stringify(v); return t.length > n ? t.slice(0, n) + '...' : t } // shown shortened, never cut silently

/** The enumeration after the colon in the "differs" claim: up to `max` distinct changes. The same change to the same kind of
 *  element (its last path segment, old and new value) in several places is one line with a count, written with the first place. */
export function changesText(changed, { max = 4 } = {}) {
  const groups = new Map()
  for (const d of changed) {
    const line = d.kind === 'removed' ? `${short(d.key)} (was ${cut(d.was, 90)}) is ${d.stillThere ? 'dropped' : 'gone'}`
      : d.kind === 'added' ? `${short(d.key)} is newly set to ${cut(d.now, 90)}`
        : `${short(d.key)} was ${cut(d.was, 90)}, now ${cut(d.now, 90)}`
    const same = `${d.kind}|${d.key.split('/').pop()}|${d.was}|${d.now}`
    const g = groups.get(same)
    if (g) g.n++; else groups.set(same, { line, n: 1 })
  }
  return [...groups.values()].slice(0, max).map(({ line, n }) => n > 1 ? `${line} (${n} places)` : line).join('; ')
}

// "body/div[1]/span[1]#text", "span[1]/span[1]@inert" or "div[1]/main[1]#scrolls" -> { tag: 'span', what: 'text' | 'inert' | 'scrolling' }
const TAG_NAMES = { a: 'link', p: 'paragraph', li: 'list item', ul: 'list', ol: 'list', img: 'image', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', nav: 'nav', aside: 'sidebar', main: 'main area', header: 'header', footer: 'footer', button: 'button', input: 'field', select: 'menu', textarea: 'field', table: 'table', td: 'cell', th: 'cell', tr: 'row', span: 'span', div: 'block', label: 'label', form: 'form', section: 'section', article: 'article', svg: 'icon', body: 'page' }
function element(key) {
  const m = key.match(/([a-z0-9]+)(?:\[\d+\])?(?:@([^/@\s]+)|#text|#scrolls)?$/i)
  if (!m) return { tag: key, what: 'value' }
  return { tag: TAG_NAMES[m[1].toLowerCase()] ?? m[1], what: m[2] === 'class' ? 'classes' : m[2] ?? (key.endsWith('#text') ? 'text' : key.endsWith('#scrolls') ? 'scrolling' : 'value') }
}
const article = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w
const unq = v => { try { const x = JSON.parse(v); return typeof x === 'string' ? x : v } catch { return v } }
const q = v => { const s = unq(v); return s === '' ? 'empty' : `"${s}"` }

/**
 * A recorded claim as a lead and items, or null when the text has no structure this reader knows. Kinds:
 *   differs   "<cand> differs from <good> in A, and B: x was 1, now 2; y is newly set to ""; z (was 3) is gone."
 *   none      "No recorded value differs between ..."
 */
export function plainClaim(text) {
  const t = String(text ?? '')
  const m = t.match(/^(\S+) differs from (\S+) in (.+?): (.+)\.$/s)
  if (!m) return null
  const [, cand, good, summary, list] = m
  const parts = summary.split(/, and /).map(p => p
    .replace(/^(\d+) recorded values?$/, '$1 changed')
    .replace(/^(\d+) state attributes? newly set on \S+ \(([^)]*)\)$/, '$1 newly set ($2)')
    .replace(/^(\d+) elements? present on \S+ (?:is|are) missing \((\d+) recorded facts?\)$/, '$1 gone')
    .replace(/^(\d+) recorded facts? dropped from elements? still there \(([^)]*)\)$/, '$1 dropped ($2)'))
  const items = list.split(/; (?=\S)/).map(line => {
    const n = line.match(/ \((\d+) places\)$/)
    const places = n ? ` in ${n[1]} places` : ''
    const body = n ? line.slice(0, -n[0].length) : line
    let x
    if ((x = body.match(/^(\S+) \(was (.+)\) is gone$/))) { const e = element(x[1]); return e.what === 'scrolling' ? `${article(e.tag)} can no longer scroll${places}` : `${article(e.tag)} is gone (its ${e.what} was ${q(x[2])})${places}` }
    if ((x = body.match(/^(\S+) \(was (.+)\) is dropped$/))) { const e = element(x[1]); return `${e.what} dropped from ${article(e.tag)} (was ${q(x[2])})${places}` }
    if ((x = body.match(/^(\S+) is newly set to (.+)$/))) { const e = element(x[1]); return `${e.what} newly set on ${article(e.tag)}${places}` }
    if ((x = body.match(/^(\S+) was (.+), now (.+)$/))) { const e = element(x[1]); return `${e.what} of ${article(e.tag)}: ${q(x[2])} to ${q(x[3])}${places}` }
    return body
  })
  // a claim written before changes were counted can list the same change four times; the reader counts them once
  const seen = new Map()
  for (const it of items) seen.set(it, (seen.get(it) ?? 0) + 1)
  const folded = [...seen].map(([it, n]) => n > 1 && !/ in \d+ places$/.test(it) ? `${it} in ${n} places` : it)
  return { lead: `${cand} against ${good}: ${parts.join(', ')}`, items: folded, cand, good }
}

// "9:click css=body > div:nth-of-type(1) > ..." -> "a click"; "14:goto /settings" -> "load /settings"; a crawled selector is not for a person
export function stepWords(label) {
  const l = String(label).replace(/^\d+:/, '').trim()
  const m = l.match(/^(\w+)\b\s*(.*)$/)
  if (!m) return cut(l, 40).replace(/^"|"$/g, '')
  const [, verb, rest] = m
  if (verb === 'start') return 'start'
  if (verb === 'goto') return `load ${rest || '/'}`
  if (verb === 'click') return /^(css|xpath)=/.test(rest) ? 'a click' : `click ${cut(rest, 40).replace(/^"|"$/g, '')}`
  if (verb === 'fill') return 'typing'
  if (verb === 'press') return `press ${rest}`.trim()
  return cut(l, 40).replace(/^"|"$/g, '')
}

/**
 * What an exported test checks, in words, from its `test.exported` event ({ id, fact, i, good, candidate, removed, appeared }) and the
 * step's label, so a record can say what "the test R1" is. `good`/`candidate` are the finding's expected and actual as exported.
 */
export function testSentence(t, { label = null, goodRef = 'the good version', candRef = 'the candidate' } = {}) {
  if (!t || typeof t.fact !== 'string') return null
  const step = Number.isFinite(Number(t.i)) ? `after step ${t.i}${label ? ` (${stepWords(label)})` : ''}` : 'at the end'
  const e = element(t.fact), where = t.fact.replace(/(@[^/]+|#text|#scrolls)$/, '').split('/').slice(-2).join('/'), who = `${article(e.tag)} at ${where}`
  if (t.fact === 'window@scrollY') return `Checks that ${step} ${unq(t.good)}, as on ${goodRef}. On ${candRef} ${unq(t.candidate)}.`
  if (e.what === 'scrolling') return `Checks that ${step} ${who} can still scroll, as on ${goodRef}: the test turns the mouse wheel over it and asks whether it can scroll. On ${candRef} it cannot.`
  const subject = e.what === 'text' ? `the text of ${who}` : e.what === 'classes' ? `the classes of ${who}` : `the ${e.what} attribute of ${who}`
  const plural = e.what === 'classes'
  if (t.appeared) return `Checks that ${step} ${who} has no ${e.what} attribute, as on ${goodRef}. On ${candRef} it was set to ${q(t.candidate)}.`
  if (t.removed) return `Checks that ${step} ${subject} ${plural ? 'are' : 'is'} still ${q(t.good)}, as on ${goodRef}. On ${candRef} ${plural ? 'they were' : 'it was'} missing.`
  return `Checks that ${step} ${subject} ${plural ? 'are' : 'is'} ${q(t.good)}, as on ${goodRef}. On ${candRef} ${plural ? 'they were' : 'it was'} ${q(t.candidate)}.`
}

// The classes this check can read (scroll, hide or show, disable, display, position), without their variant prefixes.
const KNOWN_CLASS = /^(?:overflow(?:-[xy])?-(?:auto|scroll|hidden|clip)|hidden|invisible|sr-only|opacity-0|d-none|visually-hidden|collapse|collapsed|visible|not-sr-only|opacity-100|block|inline|inline-block|inline-flex|flex|grid|contents|d-block|d-flex|d-inline|d-inline-block|disabled|pointer-events-none|pointer-events-auto|fixed|absolute|sticky|static|relative)$/
const known = list => list.filter(c => KNOWN_CLASS.test(c.replace(/^!?(?:[a-z-]+:)*/, '')))

/**
 * What each recording shows: the test passing on the good version and failing on the candidate, said as what was found, not as
 * "passes" and "fails" alone. Returns { pass, fail }, each one short sentence that opens with the test id and the version.
 */
export function outcomeText(t, { goodRef = 'the good version', candRef = 'the candidate', id = null } = {}) {
  if (!t || typeof t.fact !== 'string') return null
  const e = element(t.fact), named = nameFromClasses(t.good, t.candidate)
  const who = e.what === 'classes' && named ? named : article(e.tag)
  const the = who.replace(/^an? /, 'the ')
  const P = `${id ?? 'The test'} passes on ${goodRef}: `, F = `${id ?? 'The test'} fails on ${candRef}: `
  if (t.fact === 'window@scrollY') return { pass: `${P}${unq(t.good)}.`, fail: `${F}${unq(t.candidate)}.` }
  if (e.what === 'scrolling') return { pass: `${P}${the} scrolls when the mouse wheel turns over it.`, fail: `${F}${the} does not move when the mouse wheel turns over it.` }
  if (t.appeared) return { pass: `${P}${the} has no ${e.what} attribute.`, fail: `${F}${the} is ${STATE_WORDS[e.what] ?? `marked ${e.what}`}.` }
  if (t.removed && t.stillThere) return { pass: `${P}${the} carries the ${e.what} attribute.`, fail: `${F}the ${e.what} attribute is gone from ${the}.` }
  if (t.removed) return { pass: `${P}${the} is there${e.what === 'text' ? `, reading ${q(t.good)}` : ''}.`, fail: `${F}${the} is missing.` }
  if (e.what === 'classes') {
    const { added, removed } = classChange(unq(t.good), unq(t.candidate))
    const [was, now] = known(removed).length || known(added).length ? [known(removed), known(added)] : [removed, added] // the classes this check can read come first; else the whole change, cut short
    return { pass: `${P}${the} still has the class${was.length === 1 ? '' : 'es'} ${few(was)}.`, fail: `${F}${the} has ${few(now)} instead of ${few(was)}.` }
  }
  if (e.what === 'text') return { pass: `${P}${the} reads ${q(t.good)}.`, fail: `${F}${the} reads ${q(t.candidate)}.` }
  return { pass: `${P}the ${e.what} of ${the} is ${q(t.good)}.`, fail: `${F}the ${e.what} of ${the} is ${q(t.candidate)}.` }
}

// A word a person would use for the element, read from its class names (a split pane, a sidebar, a dialog), else from its tag.
const CLASS_WORDS = [['splitpanes', 'a split pane'], ['pane', 'a pane'], ['sidebar', 'a sidebar'], ['navbar', 'a navigation bar'], ['nav', 'a navigation bar'], ['modal', 'a dialog'], ['dialog', 'a dialog'], ['dropdown', 'a dropdown menu'], ['menu', 'a menu'], ['tooltip', 'a tooltip'], ['toolbar', 'a toolbar'], ['tabs', 'a tab bar'], ['tab', 'a tab'], ['panel', 'a panel'], ['drawer', 'a drawer'], ['header', 'a header'], ['footer', 'a footer'], ['card', 'a card'], ['table', 'a table'], ['editor', 'an editor'], ['toggle', 'a toggle'], ['switch', 'a switch'], ['btn', 'a button'], ['button', 'a button'], ['input', 'an input'], ['form', 'a form'], ['list', 'a list'], ['badge', 'a badge'], ['banner', 'a banner'], ['overlay', 'an overlay'], ['spinner', 'a spinner'], ['avatar', 'an avatar']]
export function nameFromClasses(...lists) {
  const tokens = new Set(lists.flatMap(l => unq(l ?? '').split(/\s+/)).flatMap(c => c.replace(/^!/, '').split(/[:_-]+|__/)).map(t => t.toLowerCase()).filter(Boolean))
  for (const [tok, word] of CLASS_WORDS) if (tokens.has(tok)) return word
  return null
}

// What a layout class means for a person. Returns a sentence for the classes that came and went, or null for classes this check cannot read.
function classMeaning(removed, added, who) {
  const bare = c => c.replace(/^!?(?:[a-z-]+:)*/, '')
  const has = (list, re) => list.some(c => re.test(bare(c)))
  const of = (list, re) => list.filter(c => re.test(bare(c)))
  const SCROLL = /^overflow(?:-[xy])?-(?:auto|scroll)$/, CLIP = /^overflow(?:-[xy])?-(?:hidden|clip)$/
  const HIDE = /^(?:hidden|invisible|sr-only|opacity-0|d-none|visually-hidden|collapse|collapsed)$/, SHOW = /^(?:visible|not-sr-only|opacity-100|block|inline-block|d-block|d-flex|d-inline|expanded)$/
  const DISABLE = /^(?:disabled|pointer-events-none)$/, ENABLE = /^pointer-events-auto$/
  const LAYOUT = /^(?:block|inline|inline-block|inline-flex|flex|grid|contents|d-block|d-flex|d-inline|d-inline-block)$/, POS = /^(?:fixed|absolute|sticky|static|relative)$/
  const pair = re => `(${few(of(removed, re))} to ${few(of(added, re))})`
  // clickable styling is read on the raw class, since the variant prefix (hover:, focus-visible:) is the point
  const CLICK = [[/^cursor-pointer$/, 'hand cursor'], [/^hover:/, 'hover colour'], [/^focus(?:-visible)?:(?:ring|outline)/, 'focus ring'], [/^active:/, 'pressed state']]
  const lostClick = CLICK.filter(([re]) => removed.some(c => re.test(c)) && !added.some(c => re.test(c))).map(([, w]) => w)
  const gotClick = CLICK.filter(([re]) => added.some(c => re.test(c)) && !removed.some(c => re.test(c))).map(([, w]) => w)
  const layout = has(removed, LAYOUT) || has(added, LAYOUT) ? ` and is laid out as ${few(of(added, LAYOUT))} instead of ${few(of(removed, LAYOUT))}` : ''
  if (lostClick.length >= 2) return `${who} lost its clickable styling (${lostClick.join(', ')})${layout}: it no longer looks like something to click.`
  if (gotClick.length >= 2 && !lostClick.length) return `${who} gained clickable styling (${gotClick.join(', ')})${layout}: it now looks like something to click.`
  if (has(removed, SCROLL) && has(added, CLIP)) return `${who} lost the style that lets it scroll ${pair(/overflow/)}: content taller than it is cut off instead of scrolling.`
  if (has(removed, CLIP) && has(added, SCROLL)) return `${who} that cut its content off can now scroll ${pair(/overflow/)}.`
  if (has(added, HIDE) && !has(removed, HIDE)) return `${who} that was shown is now hidden ${pair(HIDE)}.`
  if (has(removed, HIDE) && !has(added, HIDE)) return `${who} that was hidden is now shown ${pair(HIDE)}.`
  if (has(added, DISABLE)) return `${who} can no longer be used: it is disabled or ignores clicks ${pair(DISABLE)}.`
  if (has(removed, DISABLE) || has(added, ENABLE)) return `${who} that could not be used can be used again ${pair(new RegExp(DISABLE.source + '|' + ENABLE.source))}.`
  if (has(removed, LAYOUT) || has(added, LAYOUT)) return `${who} is laid out differently ${pair(LAYOUT)}: its contents may wrap, align or size differently.`
  if (has(removed, POS) || has(added, POS)) return `${who} is positioned differently on the page ${pair(POS)}.`
  if (has(added, SHOW) || has(removed, SHOW)) return `${who} shows differently ${pair(SHOW)}.`
  return null
}

const STATE_WORDS = { inert: 'inert: it cannot be clicked, focused or typed into', disabled: 'disabled', hidden: 'hidden', readonly: 'read-only', checked: 'checked', selected: 'selected', open: 'open', 'aria-hidden': 'hidden from assistive technology', 'aria-disabled': 'announced as disabled', 'aria-expanded': 'expanded', 'aria-busy': 'marked busy', 'aria-invalid': 'marked invalid' }

/**
 * The regression in plain words: one or two sentences a person reads first, from the exported test ({ fact, i, good, candidate, removed,
 * appeared, stillThere, notice }) and the versions. The sentence names what changed for a person, not the test's mechanics.
 */
export function regressionText(t, { goodRef = 'the good version', candRef = 'the candidate', label = null, sameLook = null, scrollTest = null, id = null } = {}) {
  if (!t || typeof t.fact !== 'string') return null
  const e = element(t.fact)
  const named = nameFromClasses(t.good, t.candidate)
  const who = e.what === 'classes' && named ? named : article(e.tag)
  const when = Number.isFinite(Number(t.i)) && Number(t.i) > 0 ? `After ${label ? stepWords(label) : `step ${t.i}`}` : 'On the start page'
  const churn = t.notice?.cls === 'churn' ? ` This is markup churn (${t.notice.why}): a person would not notice it, and it is here so the record is complete.` : ''
  const lead = `${when} on ${candRef}, `
  if (t.fact === 'window@scrollY') return `${lead}the page scrolls differently: ${unq(t.candidate)}, where ${goodRef} has ${unq(t.good)}.`
  if (e.what === 'scrolling') return `${lead}${who} cannot be scrolled: the mouse wheel over it does nothing, so anything below its edge is out of reach. On ${goodRef} it scrolls.`
  if (t.appeared) return `${lead}${who} is ${STATE_WORDS[e.what] ?? `marked ${e.what}`}. On ${goodRef} it is not.${churn}`
  if (t.removed && t.stillThere) return `${lead}the ${e.what} attribute dropped off ${who}; the element itself is still there.${churn}`
  if (t.removed) return `${lead}${who} is missing: on ${goodRef} it is there, ${e.what === 'text' ? `reading ${q(t.good)}` : e.what === 'classes' ? `with the classes ${q(t.good)}` : `carrying the ${e.what} attribute${unq(t.good) === '' ? '' : ` ${q(t.good)}`}`}.${churn}`
  if (e.what === 'classes') {
    const { added, removed } = classChange(unq(t.good), unq(t.candidate))
    const has = (list, re) => list.some(c => re.test(c.replace(/^!?(?:[a-z-]+:)*/, '')))
    // sameLook: the screenshots at this step matched on both versions, so the recordings look the same and only the class differs;
    // scrollTest: another test that turns the wheel over an area that stopped scrolling, which is where a scroll style shows
    const scrolly = has(removed, /^overflow/) || has(added, /^overflow/)
    const look = sameLook === true ? (scrolly ? ` Nothing here is taller than it, so the recordings and screenshots at this step look the same on both versions; the test reads the class.` : ` The recordings and screenshots at this step look the same on both versions: the difference is in the class, which the test reads.`) : ''
    const see = scrolly && scrollTest && scrollTest.id !== (id ?? t.id) ? ` ${scrollTest.id} shows the lost scrolling itself${scrollTest.when ? `, ${scrollTest.when}` : ''}.` : ''
    const meaning = classMeaning(removed, added, who)
    if (meaning) return `${lead}${meaning}${look}${see}`
    return `${lead}the style classes of ${who} changed (${few(removed)} to ${few(added)}).${churn}${look}`
  }
  if (e.what === 'text') return `${lead}the text of ${who} reads ${q(t.candidate)}, where ${goodRef} reads ${q(t.good)}.${churn}`
  return `${lead}the ${e.what} of ${who} is ${q(t.candidate)}, where ${goodRef} has ${q(t.good)}.${churn}`
}
const few = (list, n = 4) => (list.length ? list.slice(0, n).join(' ') + (list.length > n ? ` and ${list.length - n} more` : '') : 'nothing')
const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
