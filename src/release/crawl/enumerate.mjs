// Decides which elements on a page are safe and useful to click.
// Pure logic, no browser or network. Run tests with:
// node --test src/release/crawl/enumerate.test.mjs
import { createHash } from 'node:crypto'

const SINGLE_WORDS = [
  'delete',
  'remove',
  'destroy',
  'erase',
  'wipe',
  'purge',
  'reset',
  'deactivate',
  'unsubscribe',
  'purchase',
  'checkout',
  'submit',
  'publish',
  'save',
  'import',
  'upload',
  'install',
  'uninstall',
  'logout',
  'signout',
  'send'
]

const PHRASES = [
  'clear all',
  'empty trash',
  'empty the trash',
  'log out',
  'sign out',
  'close account',
  'cancel subscription',
  'mark all',
  'place order',
  'confirm order'
]

// Trailing-space entries from the spec: the word must be followed by more text.
const PREFIX_WORDS = ['pay', 'buy', 'post']

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function nameRisk(lower) {
  for (const w of SINGLE_WORDS) {
    // Word-start rule with inflection tolerance: allow one trailing d/s
    // so "removed" still matches "remove" but "sender" does not match "send".
    const re = new RegExp(`\\b${escRe(w)}(?:[ds])?(?![a-z])`)
    if (re.test(lower)) return w
  }
  for (const p of PHRASES) {
    const re = new RegExp(`\\b${escRe(p)}(?![a-z])`)
    if (re.test(lower)) return p
  }
  for (const w of PREFIX_WORDS) {
    const re = new RegExp(`^\\s*${escRe(w)}\\s+\\S`) // only as the first word of a label: "Post comment", not "Third post 1 June 2026"
    if (re.test(lower)) return w
  }
  return null
}

function hrefPath(href) {
  if (typeof href !== 'string' || !href) return ''
  try {
    const u = new URL(href)
    return (u.pathname + u.search).toLowerCase()
  } catch {
    return String(href).toLowerCase()
  }
}

export function cleanName(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 60)
}

export function isRisky(desc = {}) {
  const lower = String(desc.name ?? '').toLowerCase()
  // A control's label is short. A long text is content (a whole list row, a headline), and any common word in it would otherwise
  // make it look risky; the link, form and download checks below still apply to it.
  const hit = lower.length <= 40 ? nameRisk(lower) : null
  if (hit) return `name suggests it changes data: ${hit}`
  const path = hrefPath(desc.href)
  if (path) {
    for (const w of ['logout', 'signout', 'delete', 'remove', 'unsubscribe', 'checkout']) {
      if (path.includes(w)) return 'link suggests it changes data'
    }
  }
  if (desc.inForm) {
    const method = String(desc.formMethod ?? '').toLowerCase()
    if (['post', 'put', 'patch', 'delete'].includes(method)) return 'submits a form'
    const type = String(desc.type ?? '').toLowerCase()
    if (['submit', 'reset', 'file', 'password'].includes(type)) return 'submits a form'
  }
  if (desc.download === true) return 'a download'
  if (path) {
    for (const ext of ['.zip', '.exe', '.dmg', '.pdf', '.tar', '.gz']) {
      const p = path.split('?')[0]
      if (p.endsWith(ext)) return 'a download'
    }
  }
  return null
}

export function isInternal(desc, origin) {
  const href = typeof desc?.href === 'string' ? desc.href : ''
  if (!href) return true
  if (href.startsWith('#')) return true
  const lower = href.toLowerCase()
  for (const s of ['mailto:', 'tel:', 'javascript:', 'data:']) {
    if (lower.startsWith(s)) return false
  }
  try {
    const u = new URL(href, origin)
    return u.origin === origin
  } catch {
    return false
  }
}

export function selectorFor(desc = {}) {
  const role = String(desc.role ?? '')
  const name = cleanName(desc.name)
  // 'clickable' is not an ARIA role: it marks an element that only looks clickable (a pointer cursor), so it is found by its position in the page
  const okRole = /^[A-Za-z-]+$/.test(role) && role.length > 0 && role !== 'clickable'
  if (name && okRole) {
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    let s = `role=${role}[name="${escaped}"]`
    if (Number(desc.nth) > 0) s += ` >> nth=${desc.nth}`
    return s
  }
  return `css=${String(desc.path ?? '')}`
}

const RANK = ['tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'summary', 'treeitem', 'button', 'link', 'clickable', 'checkbox', 'switch', 'radio', 'option']
const ALLOWED = new Set(RANK)

export function candidates(descs, { origin, perPage = 12 } = {}) {
  const list = Array.isArray(descs) ? descs : []
  const seen = new Set()
  const out = []
  for (const d of list) {
    if (!d || d.visible !== true) continue
    if (d.disabled === true) continue
    const role = String(d.role ?? '')
    if (!ALLOWED.has(role)) continue
    if (isRisky(d) !== null) continue
    if (!isInternal(d, origin)) continue
    const name = cleanName(d.name)
    const href = typeof d.href === 'string' ? d.href : ''
    const key = `${role}|${name}|${href}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ d, name, key, href, role })
  }
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  out.sort((a, b) => {
    const ra = RANK.indexOf(a.role)
    const rb = RANK.indexOf(b.role)
    if (ra !== rb) return ra - rb
    if (num(a.d.y) !== num(b.d.y)) return num(a.d.y) - num(b.d.y)
    if (num(a.d.x) !== num(b.d.x)) return num(a.d.x) - num(b.d.x)
    if (a.key < b.key) return -1
    if (a.key > b.key) return 1
    return 0
  })
  // Take them round-robin across roles (in role order), so that a page with thirty links still gets its buttons and clickable rows
  // into the limit, instead of the first role filling every slot.
  const byRole = new Map(RANK.map(r => [r, out.filter(o => o.role === r)]))
  const mixed = []
  for (let i = 0; mixed.length < out.length; i++) for (const r of RANK) if (byRole.get(r)[i]) mixed.push(byRole.get(r)[i])
  return mixed.slice(0, perPage).map(({ d, name, key, href, role }) => ({
    action: { type: 'click', selector: selectorFor(d) },
    label: `${role} "${name}"`,
    role,
    name,
    key,
    href
  }))
}

export function stateKey(url, descs) {
  let path = ''
  try {
    const u = new URL(String(url))
    // a value that looks generated (a request id, a nonce, a token) differs on every visit and must not make every visit a new state
    const params = [...u.searchParams.entries()].map(([k, v]) => [k, /^[0-9a-f]{8,}$/i.test(v) || (v.length >= 10 && /\d/.test(v) && /[a-z]/i.test(v) && /^[A-Za-z0-9_-]+$/.test(v)) ? '*' : v])
    path = u.pathname + (params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '')
  } catch {
    path = ''
  }
  const set = new Set()
  for (const d of Array.isArray(descs) ? descs : []) {
    if (!d || d.visible !== true) continue
    const name = cleanName(d.name)
    if (!name) continue
    set.add(`${String(d.role ?? '')}|${name}`)
  }
  const lines = [...set].sort()
  return createHash('sha256').update(path + '\n' + lines.join('\n')).digest('hex').slice(0, 16)
}
