// node --test src/release/claimtext.test.mjs   (offline)
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changesText, plainClaim, testSentence } from './claimtext.mjs'

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
  it('an area that can no longer scroll, and a class list, read as such', () => {
    const p = plainClaim('2.0 differs from 1.0 in 2 recorded values, and 1 element present on 1.0 is missing (1 recorded fact): div[1]/main[1]#scrolls (was "y") is gone; div[1]/main[1]@class was "!overflow-auto flex", now "!overflow-hidden flex".')
    assert.deepEqual(p.items, ['a main area can no longer scroll', 'classes of a main area: "!overflow-auto flex" to "!overflow-hidden flex"'])
  })
  it('returns null for a claim it does not know how to read', () => {
    assert.equal(plainClaim('A further recording of v1 showed 0 differences from the baseline, so the noise filter holds.'), null)
    assert.equal(plainClaim(''), null)
  })
})

describe('a fact dropped from an element still there', () => {
  it('is written as dropped, not gone, and read back that way', () => {
    const text = changesText([{ kind: 'removed', key: 'body/div[1]/div[2]@data-v-abc', was: '', now: null, stillThere: true }, { kind: 'removed', key: 'body/aside[1]#text', was: 'Menu', now: null }])
    assert.equal(text, 'div[1]/div[2]@data-v-abc (was "") is dropped; body/aside[1]#text (was "Menu") is gone')
    const p = plainClaim(`2.0 differs from 1.0 in 1 element present on 1.0 is missing (2 recorded facts), and 1 recorded fact dropped from elements still there (data-v-abc): ${text}.`)
    assert.equal(p.lead, '2.0 against 1.0: 1 gone, 1 dropped (data-v-abc)')
    assert.deepEqual(p.items, ['data-v-abc dropped from a block (was empty)', 'a sidebar is gone (its text was "Menu")'])
  })
})

describe('testSentence says what an exported test checks', () => {
  const refs = { goodRef: '1.0', candRef: '2.0' }
  it('a class list, a text, an attribute, a vanished fact, an appearing state and a scroll area', () => {
    assert.equal(testSentence({ id: 'R1', fact: 'body/div[1]/div[3]@class', i: 0, good: '"!overflow-auto flex"', candidate: '"!overflow-hidden flex"' }, { label: '0:start', ...refs }),
      'Checks that after step 0 (start) the classes of a block at div[1]/div[3] are "!overflow-auto flex", as on 1.0. On 2.0 they were "!overflow-hidden flex".')
    assert.equal(testSentence({ id: 'R2', fact: 'body/a[1]#text', i: 2, good: '"Share"', candidate: '"Post"' }, refs), 'Checks that after step 2 the text of a link at body/a[1] is "Share", as on 1.0. On 2.0 it was "Post".')
    assert.equal(testSentence({ id: 'R3', fact: 'body/a[1]@href', i: 2, good: '"/x"', candidate: 'missing on the candidate', removed: true }, refs), 'Checks that after step 2 the href attribute of a link at body/a[1] is still "/x", as on 1.0. On 2.0 it was missing.')
    assert.equal(testSentence({ id: 'R4', fact: 'body/aside[1]@inert', i: 1, good: 'absent (not set on the previous release)', candidate: '""', appeared: true }, refs), 'Checks that after step 1 a sidebar at body/aside[1] has no inert attribute, as on 1.0. On 2.0 it was set to empty.')
    assert.equal(testSentence({ id: 'R5', fact: 'body/div[1]/main[1]#scrolls', i: 9, good: 'can scroll', candidate: 'cannot scroll on the candidate', removed: true }, { label: '9:click css=body > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(2) > section', ...refs }),
      'Checks that after step 9 (a click) a main area at div[1]/main[1] can still scroll, as on 1.0: the test turns the mouse wheel over it and asks whether it can scroll. On 2.0 it cannot.')
    assert.equal(testSentence({ id: 'R6', fact: 'window@scrollY', i: 3, good: 'the page scrolls by 300 pixels (the old version)', candidate: 'the page ends 300 pixels higher up than the old version leaves it' }, refs), 'Checks that after step 3 the page scrolls by 300 pixels (the old version), as on 1.0. On 2.0 the page ends 300 pixels higher up than the old version leaves it.')
    assert.equal(testSentence({ id: 'R8', fact: 'body/h1[1]#text', i: 14, good: '"Settings"', candidate: '"Options"' }, { label: '14:goto /settings', ...refs }), 'Checks that after step 14 (load /settings) the text of a heading at body/h1[1] is "Settings", as on 1.0. On 2.0 it was "Options".')
    assert.equal(testSentence({ id: 'R9', fact: 'body/h1[1]#text', i: 3, good: '"a"', candidate: '"b"' }, { label: '3:click role=button[name="Save"]', ...refs }), 'Checks that after step 3 (click role=button[name=\\"Save\\"]) the text of a heading at body/h1[1] is "a", as on 1.0. On 2.0 it was "b".')
    assert.equal(testSentence(null), null); assert.equal(testSentence({ id: 'R7' }), null)
  })
})
