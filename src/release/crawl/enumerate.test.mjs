// Offline tests for the click-enumeration logic.
// Run with: node --test src/release/crawl/enumerate.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cleanName, isRisky, isInternal, selectorFor, candidates, stateKey } from './enumerate.mjs'

const ORIGIN = 'https://example.com'

function desc(over = {}) {
  return {
    tag: 'button',
    role: 'button',
    name: 'Do',
    href: '',
    type: '',
    disabled: false,
    visible: true,
    inForm: false,
    formMethod: '',
    download: false,
    path: 'body > button',
    nth: 0,
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    ...over
  }
}

describe('cleanName', () => {
  it('collapses whitespace, trims and cuts to 60', () => {
    assert.equal(cleanName('  hello\n  world\t!  '), 'hello world !')
    assert.equal(cleanName('a'.repeat(100)).length, 60)
    assert.equal(cleanName('a'.repeat(100)), 'a'.repeat(60))
  })
  it('returns empty for non-strings', () => {
    assert.equal(cleanName(null), '')
    assert.equal(cleanName(undefined), '')
    assert.equal(cleanName(42), '')
    assert.equal(cleanName({}), '')
  })
})

describe('isRisky', () => {
  it('flags risky names', () => {
    assert.match(isRisky(desc({ name: 'Delete item' })), /delete/)
    assert.match(isRisky(desc({ name: 'Save draft' })), /save/)
    assert.match(isRisky(desc({ name: 'Send message' })), /send/)
    assert.match(isRisky(desc({ name: 'Publish now' })), /publish/)
    assert.match(isRisky(desc({ name: 'Log out' })), /log out/)
    assert.match(isRisky(desc({ name: 'Pay now' })), /pay/)
    assert.match(isRisky(desc({ name: 'Buy now' })), /buy/)
    assert.match(isRisky(desc({ name: 'Post comment' })), /post/)
    assert.match(isRisky(desc({ name: 'Checkout now' })), /checkout/)
    assert.match(isRisky(desc({ name: 'Clear all filters' })), /clear all/)
    assert.match(isRisky(desc({ name: 'Empty trash' })), /empty trash/)
    assert.match(isRisky(desc({ name: 'Uninstall app' })), /uninstall/)
  })
  it('matches remove at a word start', () => {
    const r = isRisky(desc({ name: 'Removed items' }))
    assert.ok(r && r.includes('remove'), 'Removed items should match remove')
  })
  it('does not flag look-alikes', () => {
    assert.equal(isRisky(desc({ name: 'Savage garden' })), null)
    assert.equal(isRisky(desc({ name: 'Sender list' })), null)
  })
  it('is case insensitive', () => {
    assert.ok(isRisky(desc({ name: 'DELETE everything' })) !== null)
  })
  it('flags risky href paths', () => {
    assert.equal(isRisky(desc({ name: 'Help', role: 'link', href: 'https://example.com/logout' })), 'link suggests it changes data')
    assert.equal(isRisky(desc({ name: 'Help', role: 'link', href: 'https://example.com/CHECKOUT?x=1' })), 'link suggests it changes data')
  })
  it('flags post forms and risky input types', () => {
    assert.equal(isRisky(desc({ name: 'Go', inForm: true, formMethod: 'post' })), 'submits a form')
    assert.equal(isRisky(desc({ name: 'Go', inForm: true, type: 'submit' })), 'submits a form')
    assert.equal(isRisky(desc({ name: 'Go', inForm: true, type: 'password' })), 'submits a form')
    assert.equal(isRisky(desc({ name: 'Go', inForm: true, type: 'file' })), 'submits a form')
    assert.equal(isRisky(desc({ name: 'Go', inForm: true, formMethod: 'get' })), null)
    assert.equal(isRisky(desc({ name: 'Go', inForm: false, formMethod: 'post' })), null)
  })
  it('flags downloads', () => {
    assert.equal(isRisky(desc({ name: 'Get', href: 'https://example.com/f.zip', download: true })), 'a download')
    assert.equal(isRisky(desc({ name: 'Get', href: 'https://example.com/f.pdf' })), 'a download')
    assert.equal(isRisky(desc({ name: 'Get', href: 'https://example.com/f.exe' })), 'a download')
  })
  it('harmless button is fine', () => {
    assert.equal(isRisky(desc({ name: 'Show details' })), null)
  })
})

describe('isInternal', () => {
  it('handles empty, hash, relative and origins', () => {
    assert.equal(isInternal(desc({ href: '' }), ORIGIN), true)
    assert.equal(isInternal(desc({ href: '#section' }), ORIGIN), true)
    assert.equal(isInternal(desc({ href: '/about' }), ORIGIN), true)
    assert.equal(isInternal(desc({ href: 'https://example.com/a' }), ORIGIN), true)
    assert.equal(isInternal(desc({ href: 'https://other.com/a' }), ORIGIN), false)
  })
  it('rejects mailto and bad urls', () => {
    assert.equal(isInternal(desc({ href: 'mailto:a@b.com' }), ORIGIN), false)
    assert.equal(isInternal(desc({ href: 'tel:123' }), ORIGIN), false)
    assert.equal(isInternal(desc({ href: 'javascript:alert(1)' }), ORIGIN), false)
    assert.equal(isInternal(desc({ href: 'data:text/plain,hi' }), ORIGIN), false)
    assert.equal(isInternal(desc({ href: 'http://[::1' }), ORIGIN), false)
  })
})

describe('selectorFor', () => {
  it('builds role selectors and escapes quotes and backslashes', () => {
    assert.equal(selectorFor(desc({ role: 'button', name: 'Say "hi" \\ now', nth: 0 })), 'role=button[name="Say \\"hi\\" \\\\ now"]')
  })
  it('appends nth when greater than 0', () => {
    assert.equal(selectorFor(desc({ role: 'link', name: 'More', nth: 2 })), 'role=link[name="More"] >> nth=2')
    assert.equal(selectorFor(desc({ role: 'link', name: 'More', nth: 0 })), 'role=link[name="More"]')
  })
  it('falls back to css without a name or with a bad role', () => {
    assert.equal(selectorFor(desc({ role: 'button', name: '   ', path: 'body > b' })), 'css=body > b')
    assert.equal(selectorFor(desc({ role: 'weird role!', name: 'Hi', path: 'body > x' })), 'css=body > x')
    assert.equal(selectorFor(desc({ role: '', name: 'Hi', path: 'body > x' })), 'css=body > x')
  })
})

describe('candidates', () => {
  it('filters hidden, disabled, risky and external', () => {
    const all = [
      desc({ role: 'button', name: 'Ok', x: 1, y: 1, path: 'p1' }),
      desc({ role: 'button', name: 'Hidden', visible: false, path: 'p2' }),
      desc({ role: 'button', name: 'Off', disabled: true, path: 'p3' }),
      desc({ role: 'button', name: 'Delete me', path: 'p4' }),
      desc({ role: 'link', name: 'Out', href: 'https://other.com/x', path: 'p5' }),
      desc({ role: 'slider', name: 'Nope', path: 'p6' })
    ]
    const got = candidates(all, { origin: ORIGIN })
    assert.equal(got.length, 1)
    assert.equal(got[0].name, 'Ok')
  })
  it('de-duplicates on role|name|href, first wins', () => {
    const a = desc({ role: 'button', name: 'Same', path: 'first' })
    const b = desc({ role: 'button', name: 'Same', path: 'second' })
    const got = candidates([a, b], { origin: ORIGIN })
    assert.equal(got.length, 1)
    assert.equal(got[0].action.selector, 'role=button[name="Same"]')
  })
  it('orders by role rank, then y, x, key', () => {
    const link = desc({ role: 'link', name: 'L', y: 0, x: 0, path: 'pl' })
    const button = desc({ role: 'button', name: 'B', y: 500, x: 0, path: 'pb' })
    const tab = desc({ role: 'tab', name: 'T', y: 900, x: 0, path: 'pt' })
    const got = candidates([link, button, tab], { origin: ORIGIN })
    assert.deepEqual(got.map(g => g.role), ['tab', 'button', 'link'])
  })
  it('orders by y then x then key within a role', () => {
    const a = desc({ role: 'button', name: 'B one', y: 10, x: 90, path: 'pa' })
    const b = desc({ role: 'button', name: 'B two', y: 10, x: 5, path: 'pb' })
    const got = candidates([a, b], { origin: ORIGIN })
    assert.equal(got[0].name, 'B two')
  })
  it('is deterministic when input is shuffled', () => {
    const items = [
      desc({ role: 'link', name: 'L1', y: 3, x: 3, path: 'p1' }),
      desc({ role: 'button', name: 'B1', y: 1, x: 2, path: 'p2' }),
      desc({ role: 'tab', name: 'T1', y: 2, x: 1, path: 'p3' }),
      desc({ role: 'checkbox', name: 'C1', y: 0, x: 0, path: 'p4' })
    ]
    const fwd = candidates(items, { origin: ORIGIN })
    const rev = candidates([...items].reverse(), { origin: ORIGIN })
    assert.deepEqual(fwd, rev)
  })
  it('respects perPage and result shape', () => {
    const items = [0, 1, 2, 3].map(i => desc({ role: 'button', name: `B${i}`, y: i, path: `p${i}` }))
    const got = candidates(items, { origin: ORIGIN, perPage: 2 })
    assert.equal(got.length, 2)
    for (const g of got) {
      assert.equal(g.action.type, 'click')
      assert.ok(typeof g.action.selector === 'string')
      assert.equal(g.label, `${g.role} "${g.name}"`)
      assert.equal(g.key, `${g.role}|${g.name}|${g.href}`)
      assert.ok('href' in g && 'role' in g && 'name' in g)
    }
  })
  it('keeps click type for checkbox-like roles', () => {
    const got = candidates([desc({ role: 'checkbox', name: 'Agree', path: 'pc' })], { origin: ORIGIN })
    assert.equal(got[0].action.type, 'click')
  })
})

describe('stateKey', () => {
  it('is stable under reordering and duplicates', () => {
    const a = [desc({ name: 'One', role: 'button' }), desc({ name: 'Two', role: 'link' })]
    const b = [desc({ name: 'Two', role: 'link' }), desc({ name: 'One', role: 'button' }), desc({ name: 'One', role: 'button' })]
    assert.equal(stateKey('https://example.com/p?a=1', a), stateKey('https://example.com/p?a=1', b))
  })
  it('changes when an element appears', () => {
    const a = [desc({ name: 'One', role: 'button' })]
    const b = [desc({ name: 'One', role: 'button' }), desc({ name: 'Two', role: 'button' })]
    assert.notEqual(stateKey('https://example.com/p', a), stateKey('https://example.com/p', b))
  })
  it('ignores hash, host and hidden elements', () => {
    const vis = [desc({ name: 'One', role: 'button' })]
    const withHidden = [...vis, desc({ name: 'Ghost', role: 'button', visible: false })]
    assert.equal(stateKey('https://a.com/p#one', vis), stateKey('https://b.com/p#two', vis))
    assert.equal(stateKey('https://a.com/p', vis), stateKey('https://a.com/p', withHidden))
    assert.notEqual(stateKey('https://a.com/p?a=1', vis), stateKey('https://a.com/p?a=2', vis))
  })
  it('is a short fingerprint of the pathname, the search string and the visible names, never the host or the fragment', () => {
    const fp = (path, lines = '') => createHash('sha256').update(path + '\n' + lines).digest('hex').slice(0, 16)
    assert.equal(stateKey('https://example.com/abc?x=1#frag', []), fp('/abc?x=1'))
    assert.equal(stateKey('http://[::1', []), fp(''))
    assert.equal(stateKey('https://example.com/abc', [{ role: 'link', name: 'Home', visible: true }]), fp('/abc', 'link|Home'))
    assert.match(stateKey('https://example.com/', []), /^[0-9a-f]{16}$/)
  })
})

describe('stateKey and generated values', () => {
  it('does not treat a request id or token in the query as a different page', () => {
    const vis = [{ role: 'link', name: 'Home', visible: true }]
    assert.equal(stateKey('http://x/i/?a=normal&rid=6ae43d25cfa59', vis), stateKey('http://x/i/?a=normal&rid=6ae43d2ec1b93', vis))
    assert.equal(stateKey('http://x/?t=Ab3dEf9Gh2Jk', vis), stateKey('http://x/?t=Zz9yXw8Vu7Ts', vis))
    assert.notEqual(stateKey('http://x/?a=normal', vis), stateKey('http://x/?a=global', vis), 'real values still count')
    assert.notEqual(stateKey('http://x/?page=2', vis), stateKey('http://x/?page=3', vis), 'short numbers still count')
  })
})

describe('clickable elements without a role', () => {
  const origin = 'http://x'
  const d = (over = {}) => ({ tag: 'li', role: 'clickable', name: 'First post', href: '', visible: true, disabled: false, path: 'body:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(2)', nth: 0, x: 0, y: 10, w: 100, h: 20, ...over })
  it('are candidates, found by their position because they have no ARIA role', () => {
    const [c] = candidates([d()], { origin })
    assert.equal(c.role, 'clickable')
    assert.equal(c.action.selector, 'css=body:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(2)')
  })
  it('come after buttons and links in the order', () => {
    const out = candidates([d({ y: 0 }), { tag: 'a', role: 'link', name: 'Home', href: 'http://x/', visible: true, disabled: false, path: 'p', nth: 0, x: 0, y: 50, w: 1, h: 1 }], { origin })
    assert.deepEqual(out.map(c => c.role), ['link', 'clickable'])
  })
  it('are still filtered when risky', () => {
    assert.deepEqual(candidates([d({ name: 'Delete post' })], { origin }), [])
  })
})

describe('candidates across roles', () => {
  it('a role with many elements does not push every other role out of the limit', () => {
    const links = Array.from({ length: 20 }, (_, i) => ({ tag: 'a', role: 'link', name: 'L' + i, href: 'http://x/' + i, visible: true, disabled: false, path: 'a' + i, nth: 0, x: 0, y: i, w: 1, h: 1 }))
    const row = { tag: 'li', role: 'clickable', name: 'First post', href: '', visible: true, disabled: false, path: 'li', nth: 0, x: 0, y: 500, w: 1, h: 1 }
    const btn = { tag: 'button', role: 'button', name: 'Menu', href: '', visible: true, disabled: false, path: 'b', nth: 0, x: 0, y: 600, w: 1, h: 1 }
    const out = candidates([...links, row, btn], { origin: 'http://x', perPage: 6 })
    const roles = out.map(c => c.role)
    assert.ok(roles.includes('clickable') && roles.includes('button'), roles.join(','))
    assert.equal(out.length, 6)
    assert.deepEqual(candidates([...links, row, btn].reverse(), { origin: 'http://x', perPage: 6 }).map(c => c.key), out.map(c => c.key), 'still deterministic')
  })
})

describe('risk words in content versus labels', () => {
  it('a list row that contains common words is not risky, a short label that starts with one is', () => {
    assert.equal(isRisky({ name: 'Spike Feed Third post 1 June 2026 at 12:00 Please send your thoughts to the editor and save the date' }), null)
    assert.equal(isRisky({ name: 'Third post' }), null)
    assert.match(isRisky({ name: 'Post comment' }), /post/)
    assert.match(isRisky({ name: 'Save' }), /save/)
  })
  it('a long text still counts as risky when its LINK or form says so', () => {
    const long = 'x'.repeat(60)
    assert.ok(isRisky({ name: long, href: 'http://x/account/delete' }))
    assert.ok(isRisky({ name: long, inForm: true, formMethod: 'post' }))
  })
})
