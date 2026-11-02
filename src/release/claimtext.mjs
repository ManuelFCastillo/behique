// The words of a recorded difference, for two readers: the record (one sentence, exact, hashed) and a tired person (the same
// facts, grouped and shortened). `changesText` writes the record's enumeration, with identical changes counted once; `plainClaim`
// reads a recorded claim back into a lead line and short items, so the dashboard can show it readably without touching the text
// the hash covers. Both are pure.

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
