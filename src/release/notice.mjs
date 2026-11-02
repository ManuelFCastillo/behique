// notice: would a person notice this change? Pure rules over a changed fact (key, was, now), no model, no I/O.
//   node --test src/release/notice.test.mjs
// Three classes, in rank order:
//   visible      text a person reads, a link or form target, a state they see (disabled, checked, expanded), the page scrolling differently
//   churn        markup a framework generates: hashed asset names, generated ids (_r_1_, :r3:), data-* tokens, rel values
//   third_party  content loaded from another host (an ad, a widget, a CDN image): it rotates on its own and is never the app's change
// A finding is ranked by its class so the cap keeps what a person would notice, the first confirmed (bisected) finding is the most
// noticeable one, and a check whose proven changes are all churn can be recommended SHIP with a note instead of HOLD.

export const RANK = { visible: 0, churn: 1, third_party: 2 }
export const LABEL = { visible: 'a person would notice', churn: 'markup churn', third_party: 'third-party content' }

const LOADED = new Set(['src', 'srcset', 'poster'])
const ID_LIKE = new Set(['id', 'for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant'])
const STATE = new Set(['disabled', 'checked', 'selected', 'aria-expanded', 'aria-hidden', 'aria-selected', 'aria-checked', 'aria-pressed', 'open', 'hidden', 'inert', 'readonly', 'aria-disabled'])
const TEXTUAL = new Set(['title', 'alt', 'placeholder', 'aria-label', 'value', 'label'])
const TARGETS = new Set(['href', 'action', 'target', 'type', 'name'])
const OWN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])
const GEN_ID = /^(_r_\w+_|:r\w+:|radix-|headlessui-|mui-|react-aria|mantine-|chakra-|rc_|ember\d+|ng-)/i

const str = v => (v === null || v === undefined ? '' : String(v))

/** The host of an absolute or protocol-relative URL, lower-cased, or null for a relative path or a non-URL. */
export function hostOf(value) {
  const v = str(value).trim()
  if (!v) return null
  const m = v.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#\s]+)/i)
  if (!m) return null
  const h = m[1].toLowerCase().replace(/^[^@]*@/, '') // drop any user@ part
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '')
}

/** True when the value points at a host that is not the app's own. The app's host comes from `origin`; loopback names are always the app's. */
export function isForeign(value, origin) {
  const h = hostOf(value)
  if (!h) return false
  if (OWN_HOSTS.has(h)) return false
  const own = hostOf(origin)
  return own ? h !== own : true
}

const normalise = (v, idLike) => {
  let s = str(v)
  s = s.replace(/[0-9a-f]{6,}/gi, '#') // hex: hashes, content ids
  s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}\b/g, '#') // mixed letters and digits, 8 or more: build ids, cache busters
  if (idLike) s = s.replace(/\d+/g, '#') // generated ids differ by a counter
  return s
}

/** True when the two values differ only in generated tokens (a hash, a build id, for id-like attributes a counter). */
export function tokenOnlyChange(was, now, { idLike = false } = {}) {
  const a = str(was), b = str(now)
  if (a === b) return false
  return normalise(a, idLike) === normalise(b, idLike)
}

const attrOf = key => (key.match(/@([^/@]+)$/) ?? [])[1] ?? null
const looksHuman = v => /\s/.test(str(v).trim()) && /[A-Za-z]{3,}/.test(str(v))
const looksUrl = v => /^(https?:)?\/\/|^\/[^/]|^\.{0,2}\//.test(str(v).trim()) || Boolean(hostOf(v))

/** The version in a ref: `v1.2.3` and `pkg@1.2.3` give `1.2.3`; a branch or a commit hash gives null. */
const versionOf = ref => { const s = str(ref).trim().replace(/^.*@/, '').replace(/^[vV](?=\d)/, ''); return /\d+\.\d+/.test(s) ? s : null }

/**
 * When two releases are compared, the page may print the release's own version ("1.0.0-rc.10" in the nav), and that text
 * changes with every release by definition. Such a text is expected, not a regression: ranking it first would send the
 * bisect to the release commit. Returns the reason to mark it, or null when the two values are not the two versions.
 */
export function releaseLabel(was, now, refs) {
  const g = versionOf(refs?.good), c = versionOf(refs?.cand)
  if (!g || !c || g === c) return null
  const a = str(was).trim(), b = str(now).trim()
  if (!a.includes(g) || !b.includes(c)) return null
  if (a.split(g).join('\0') !== b.split(c).join('\0')) return null // the same text with the version swapped, nothing else
  return `the release's own version label (${g} to ${c})`
}

/**
 * { cls, why } for one changed fact. `origin` is where the facts were recorded (http://host:port), so its host is the app's own.
 * `refs` ({ good, cand }) are the two versions compared, so the page's own version label is recognised as expected.
 */
export function noticeOf(fact, { origin = null, refs = null } = {}) {
  const key = str(fact?.key), was = fact?.was, now = fact?.now
  if (key === 'window@scrollY') return { cls: 'visible', why: 'the page scrolls differently' }
  const label = refs ? releaseLabel(was, now, refs) : null
  if (key.endsWith('#text')) return label ? { cls: 'churn', why: label } : { cls: 'visible', why: 'text a person reads' }
  const attr = attrOf(key)
  if (!attr) return { cls: 'visible', why: 'a recorded value' }
  if (LOADED.has(attr)) {
    for (const v of [was, now]) if (isForeign(v, origin)) return { cls: 'third_party', why: `content loaded from ${hostOf(v)}, not the app's own` }
    if (tokenOnlyChange(was, now)) return { cls: 'churn', why: 'a hashed asset name changed, nothing else' }
    return { cls: 'visible', why: 'an image or embedded content changed' }
  }
  if (ID_LIKE.has(attr)) {
    if (GEN_ID.test(str(was)) || GEN_ID.test(str(now)) || tokenOnlyChange(was, now, { idLike: true })) return { cls: 'churn', why: `a generated id (${attr})` }
    return { cls: 'visible', why: `${attr} points somewhere else` }
  }
  if (STATE.has(attr)) return { cls: 'visible', why: `a state a person sees (${attr})` }
  if (TEXTUAL.has(attr)) return label ? { cls: 'churn', why: label } : { cls: 'visible', why: 'text a person reads' }
  if (TARGETS.has(attr)) {
    if (tokenOnlyChange(was, now)) return { cls: 'churn', why: 'a hashed asset name changed, nothing else' }
    return { cls: 'visible', why: attr === 'href' || attr === 'action' ? 'a link or form target' : `${attr} changed` }
  }
  if (attr === 'rel') return { cls: 'churn', why: 'a rel attribute' }
  if (attr.startsWith('data-')) {
    if (looksUrl(was) || looksUrl(now)) return { cls: 'visible', why: `a link carried in ${attr}` }
    if (looksHuman(was) || looksHuman(now)) return { cls: 'visible', why: `text carried in ${attr}` }
    return { cls: 'churn', why: `a framework attribute (${attr})` }
  }
  if (tokenOnlyChange(was, now)) return { cls: 'churn', why: 'a generated token changed, nothing else' }
  return { cls: 'visible', why: `${attr} changed` }
}

/** The list sorted by class rank (visible, churn, third_party), keeping the given order inside a class. Items without a notice rank last. */
export function rankFindings(list) {
  const rank = f => RANK[f?.notice?.cls] ?? 9
  return (Array.isArray(list) ? list : []).map((f, i) => [f, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([f]) => f)
}

/** Counts by class among the confirmed findings, and whether every confirmed one is churn. */
export function noticeSummary(judged) {
  const list = (Array.isArray(judged) ? judged : []).filter(j => j?.verdict === 'confirmed')
  const by = cls => list.filter(j => j?.notice?.cls === cls).length
  const visible = by('visible'), churn = by('churn')
  const known = list.filter(j => j?.notice?.cls).length
  return { confirmed: list.length, visible, churn, churnOnly: list.length > 0 && known === list.length && churn === list.length }
}

/** One phrase for a claim or a log line. */
export function noticePhrase(notice) {
  if (!notice?.cls) return ''
  if (notice.cls === 'visible') return `A person would notice this one: ${notice.why}.`
  if (notice.cls === 'churn') return `This is markup churn (${notice.why}), not something a person would notice.`
  return `This is third-party content (${notice.why}).`
}

/** The parts of the page the masked facts sit under: path prefixes of `depth` segments, counted, largest first. Keys are "step|path@attr". */
export function maskedAreas(volatile, { depth = 3, top = 3 } = {}) {
  const counts = new Map()
  let total = 0
  for (const id of Object.keys(volatile ?? {})) {
    total++
    const key = id.slice(id.indexOf('|') + 1)
    if (key === 'window@scrollY') { counts.set('window', (counts.get('window') ?? 0) + 1); continue }
    const path = key.replace(/(@[^/]+|#text)$/, '')
    const area = path.split('/').slice(0, depth).join('/')
    counts.set(area, (counts.get(area) ?? 0) + 1)
  }
  const areas = [...counts].map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count || a.area.localeCompare(b.area)).slice(0, top)
  return { total, areas }
}

/** The sentence a report shows about what the check cannot see. `total` is all recorded facts (stable plus masked). */
export function maskedSentence({ masked, total, areas }) {
  if (!masked) return 'No recorded fact was masked as noise, so every recorded fact was compared.'
  const pct = total ? ` (${(100 * masked / total).toFixed(1)}%)` : ''
  const where = areas?.length ? `, mostly under ${areas.map(a => `${a.area} (${a.count})`).join(', ')}` : ''
  return `${masked} of ${total} recorded facts${pct} were masked as noise${where}. A change inside a masked fact cannot be seen by this check.`
}
