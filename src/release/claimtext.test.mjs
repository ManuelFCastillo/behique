// node --test src/release/claimtext.test.mjs   (offline)
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changesText, plainClaim } from './claimtext.mjs'

describe('changesText', () => {
  it('counts identical changes once, keeps the first-seen order, and stops at max', () => {
    const changed = [
      { kind: 'changed', key: 'body/div[1]/span[1]#text', was: '1.0.0-rc.10', now: '1.0.0-rc.12' },
      { kind: 'changed', key: 'body/div[2]/span[1]#text', was: '1.0.0-rc.10', now: '1.0.0-rc.12' },
      { kind: 'changed', key: 'body/div[3]/span[1]#text', was: '1.0.0-rc.10', now: '1.0.0-rc.12' },
      { kind: 'added', key: 'body/div[1]/aside[1]@inert', now: '' },
      { kind: 'removed', key: 'body/nav[1]/a[3]', was: 'Team' },
    ]
    assert.equal(changesText(changed), 'div[1]/span[1]#text was "1.0.0-rc.10", now "1.0.0-rc.12" (3 places); div[1]/aside[1]@inert is newly set to ""; nav[1]/a[3] (was "Team") is gone')
    assert.equal(changesText(changed, { max: 1 }), 'div[1]/span[1]#text was "1.0.0-rc.10", now "1.0.0-rc.12" (3 places)')
  })
  it('a single change has no count', () => {
    assert.equal(changesText([{ kind: 'changed', key: 'a/b[1]@href', was: 'x', now: 'y' }]), 'a/b[1]@href was "x", now "y"')
  })
})

describe('plainClaim', () => {
  it('reads the differs claim into a lead and short items, naming elements by tag', () => {
    const text = 'v1.0.0-rc.12 differs from v1.0.0-rc.10 in 11 recorded values, and 3 state attributes newly set on v1.0.0-rc.12 (inert), and 11 elements present on v1.0.0-rc.10 are missing (319 recorded facts): span[1]/span[1]#text was "1.0.0-rc.10", now "1.0.0-rc.12" (4 places); div[1]/aside[1]@inert is newly set to ""; nav[1]/a[3] (was "Team") is gone.'
    const p = plainClaim(text)
    assert.equal(p.lead, 'v1.0.0-rc.12 against v1.0.0-rc.10: 11 changed, 3 newly set (inert), 11 gone')
    assert.deepEqual(p.items, [
      'text of a span: "1.0.0-rc.10" to "1.0.0-rc.12" in 4 places',
      'inert newly set on a sidebar',
      'a link is gone (its value was "Team")',
    ])
  })
  it('older claims without counts still read', () => {
    const p = plainClaim('2.0 differs from 1.0 in 1 recorded value: body/div[1]/a[1]@href was "x", now "y".')
    assert.equal(p.lead, '2.0 against 1.0: 1 changed')
    assert.deepEqual(p.items, ['href of a link: "x" to "y"'])
  })
  it('a claim recorded before counting that lists the same change four times reads as one item in 4 places', () => {
    const one = 'span[1]/span[1]#text was "1.0.0-rc.10", now "1.0.0-rc.12"'
    const p = plainClaim(`v1.0.0-rc.12 differs from v1.0.0-rc.10 in 11 recorded values: ${[one, one, one, one].join('; ')}.`)
    assert.deepEqual(p.items, ['text of a span: "1.0.0-rc.10" to "1.0.0-rc.12" in 4 places'])
  })
  it('returns null for a claim it does not know how to read', () => {
    assert.equal(plainClaim('A further recording of v1 showed 0 differences from the baseline, so the noise filter holds.'), null)
    assert.equal(plainClaim(''), null)
  })
})
