// node --test src/release/notice.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { hostOf, isForeign, maskedAreas, maskedSentence, noticeOf, noticePhrase, noticeSummary, rankFindings, tokenOnlyChange } from './notice.mjs'

const ORIGIN = 'http://127.0.0.1:8300'
const n = (key, was, now) => noticeOf({ key, was, now }, { origin: ORIGIN })

test('text, scroll, links, states and human-readable attributes are what a person would notice', () => {
  assert.equal(n('body/div[1]/p[3]#text', 'for the last decade', 'for over a decade').cls, 'visible')
  assert.equal(n('window@scrollY', 4033, 0).cls, 'visible')
  assert.equal(n('body/div[1]/a[1]@href', '/docs/guide', '/docs/getting-started').cls, 'visible')
  assert.equal(n('body/form[1]@action', '/login', '/signin').cls, 'visible')
  assert.equal(n('body/div[1]/button[1]@disabled', '', null).cls, 'visible')
  assert.equal(n('body/div[1]/button[1]@aria-expanded', 'false', 'true').cls, 'visible')
  assert.equal(n('body/div[1]/img[1]@alt', 'Logo', 'Company logo').cls, 'visible')
  assert.equal(n('body/div[1]/input[1]@placeholder', 'Search', 'Search articles').cls, 'visible')
  // the FreshRSS share regression lives in data-* attributes that carry a link and a title: both noticeable
  assert.equal(n('body/div[1]/a[1]@data-url', 'http://127.0.0.1:8300/i/?a=1', 'http%3A%2F%2F127.0.0.1%3A8300%2Fi%2F%3Fa%3D1').cls, 'visible')
  assert.equal(n('body/div[1]/a[1]@data-title', 'A more humane web', 'A%20more%20humane%20web').cls, 'visible')
})

test('generated ids, framework data attributes, hashed asset names and rel are markup churn', () => {
  assert.deepEqual(n('body/div[1]/label[1]@for', '_r_1_', '_r_2_'), { cls: 'churn', why: 'a generated id (for)' })
  assert.equal(n('body/div[1]/div[2]@id', ':r3:', ':r5:').cls, 'churn')
  assert.equal(n('body/div[1]/div[2]@aria-labelledby', 'radix-12', 'radix-14').cls, 'churn')
  assert.equal(n('body/div[1]/button[1]@data-slot', null, 'button').cls, 'churn')
  assert.equal(n('body/div[1]/div[1]@data-state', 'closed', 'open').cls, 'churn')
  assert.equal(n('body/div[1]/img[1]@src', '/assets/logo-3f9a8c1d.png', '/assets/logo-7b2e0f44.png').cls, 'churn')
  assert.equal(n('body/div[1]/a[1]@href', '/_next/static/chunks/main-a1b2c3d4e5f6.js', '/_next/static/chunks/main-f6e5d4c3b2a1.js').cls, 'churn')
  assert.equal(n('body/div[1]/a[1]@rel', 'noopener', 'noopener noreferrer').cls, 'churn')
  // a changed image that is not only a hash is still something a person sees
  assert.equal(n('body/div[1]/img[1]@src', '/img/team.png', '/img/office.png').cls, 'visible')
  // an id that is a real name, not a counter, points somewhere else
  assert.equal(n('body/div[1]/label[1]@for', 'email', 'username').cls, 'visible')
})

test('content loaded from another host is third-party; links to other hosts are still the app\'s own choice', () => {
  const ad = n('body/div[1]/span[1]/a[1]/img[1]@src', 'https://srv.carbonads.net/static/30242/e1130b06f0096fbbd01a8d15bca68e6092cdebef', 'https://srv.carbonads.net/static/30242/622cd9813ee8ba51d6b762bf015c127a27a1e093')
  assert.equal(ad.cls, 'third_party'); assert.match(ad.why, /srv\.carbonads\.net/)
  assert.equal(n('body/div[1]/iframe[2]@src', 'https://platform.twitter.com/widgets/tweet_button.html#a', 'https://platform.twitter.com/widgets/tweet_button.html#b').cls, 'third_party')
  assert.equal(n('body/div[1]/img[1]@src', '//cdn.example.net/a.png', '//cdn.example.net/b.png').cls, 'third_party')
  assert.equal(n('body/div[1]/img[1]@src', 'http://127.0.0.1:8300/a.png', 'http://127.0.0.1:8300/b.png').cls, 'visible')
  assert.equal(n('body/div[1]/a[1]@href', 'https://github.com/org/a', 'https://github.com/org/b').cls, 'visible')
  assert.equal(noticeOf({ key: 'body/img[1]@src', was: 'https://app.example.com/a.png', now: 'https://app.example.com/b.png' }, { origin: 'https://app.example.com' }).cls, 'visible')
})

test('hostOf, isForeign and tokenOnlyChange', () => {
  assert.equal(hostOf('https://User:pw@Example.COM:8443/x?y'), 'example.com')
  assert.equal(hostOf('//cdn.example.net/a.png'), 'cdn.example.net')
  assert.equal(hostOf('/relative/path'), null); assert.equal(hostOf('plain text'), null); assert.equal(hostOf(''), null)
  assert.equal(isForeign('http://localhost:3000/a', ORIGIN), false)
  assert.equal(isForeign('https://x.example/a', null), true)
  assert.equal(tokenOnlyChange('a-3f9a8c1d.css', 'a-7b2e0f44.css'), true)
  assert.equal(tokenOnlyChange('v2.0.0-alpha.20', 'v2.0.0-alpha.21'), false, 'a version label is not a token')
  assert.equal(tokenOnlyChange('_r_1_', '_r_2_'), false); assert.equal(tokenOnlyChange('_r_1_', '_r_2_', { idLike: true }), true)
  assert.equal(tokenOnlyChange('same', 'same'), false)
})

test('rankFindings keeps visible first and the given order inside a class; noticeSummary says when only churn was proven', () => {
  const f = (id, cls) => ({ id, notice: cls ? { cls, why: '' } : undefined })
  const ranked = rankFindings([f('a', 'churn'), f('b', 'visible'), f('c'), f('d', 'third_party'), f('e', 'visible'), f('f', 'churn')])
  assert.deepEqual(ranked.map(x => x.id), ['b', 'e', 'a', 'f', 'd', 'c'])
  const j = (id, verdict, cls) => ({ id, verdict, notice: { cls, why: '' } })
  assert.deepEqual(noticeSummary([j('R1', 'confirmed', 'churn'), j('R2', 'confirmed', 'churn'), j('R3', 'unstable', 'visible')]), { confirmed: 2, visible: 0, churn: 2, churnOnly: true })
  assert.deepEqual(noticeSummary([j('R1', 'confirmed', 'churn'), j('R2', 'confirmed', 'visible')]), { confirmed: 2, visible: 1, churn: 1, churnOnly: false })
  assert.equal(noticeSummary([]).churnOnly, false)
  assert.equal(noticeSummary([{ id: 'R1', verdict: 'confirmed' }]).churnOnly, false, 'an old report without classes is never called churn-only')
  assert.match(noticePhrase({ cls: 'churn', why: 'a generated id (for)' }), /markup churn \(a generated id \(for\)\), not something a person would notice/)
  assert.match(noticePhrase({ cls: 'visible', why: 'text a person reads' }), /^A person would notice this one/)
  assert.equal(noticePhrase(null), '')
})

test('maskedAreas groups masked facts by where they sit; maskedSentence says what cannot be seen', () => {
  const volatile = {
    '0|body/div[1]/nav[1]/a[1]#text': {}, '1|body/div[1]/nav[1]/a[2]#text': {}, '2|body/div[1]/nav[1]/a[3]@href': {},
    '0|body/div[1]/main[1]/p[1]#text': {}, '0|body/div[1]/main[1]/p[2]#text': {},
    '0|body/footer[1]/span[1]#text': {}, '3|window@scrollY': {},
  }
  const m = maskedAreas(volatile)
  assert.equal(m.total, 7)
  assert.deepEqual(m.areas, [{ area: 'body/div[1]/nav[1]', count: 3 }, { area: 'body/div[1]/main[1]', count: 2 }, { area: 'body/footer[1]/span[1]', count: 1 }])
  assert.equal(maskedSentence({ masked: 7, total: 100, areas: m.areas }), '7 of 100 recorded facts (7.0%) were masked as noise, mostly under body/div[1]/nav[1] (3), body/div[1]/main[1] (2), body/footer[1]/span[1] (1). A change inside a masked fact cannot be seen by this check.')
  assert.match(maskedSentence({ masked: 0, total: 50, areas: [] }), /^No recorded fact was masked/)
  assert.deepEqual(maskedAreas(null), { total: 0, areas: [] })
})
