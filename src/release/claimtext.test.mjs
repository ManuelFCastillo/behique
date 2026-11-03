// node --test src/release/claimtext.test.mjs   (offline)
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changesText, nameFromClasses, outcomeText, plainClaim, regressionText, testSentence } from './claimtext.mjs'

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

describe('regressionText says what the regression is for a person', () => {
  const refs = { goodRef: '1.0', candRef: '2.0' }
  it('names the element from its classes and reads layout classes', () => {
    assert.equal(nameFromClasses('"!overflow-auto flex splitpanes__pane"'), 'a split pane')
    assert.equal(nameFromClasses('flex items-center', 'sidebar-item'), 'a sidebar')
    assert.equal(nameFromClasses('flex py-4'), null)
    assert.equal(nameFromClasses('fixed flex right-4 top-4 z-modal'), null) // z-modal is a stacking order, not a dialog
    assert.equal(nameFromClasses('modal-body'), 'a dialog')
    const t = { fact: 'body/div[1]/div[3]@class', i: 0, good: '"!overflow-auto flex flex-1 splitpanes__pane"', candidate: '"!overflow-hidden flex flex-1 splitpanes__pane"', notice: { cls: 'visible', why: 'x' } }
    assert.equal(regressionText(t, refs), 'On the start page on 2.0, a split pane lost the style that lets it scroll (!overflow-auto to !overflow-hidden): content taller than it is cut off instead of scrolling.')
    assert.equal(regressionText(t, { ...refs, sameLook: true, scrollTest: { id: 'R3', when: 'after a click' } }), 'On the start page on 2.0, a split pane lost the style that lets it scroll (!overflow-auto to !overflow-hidden): content taller than it is cut off instead of scrolling. Nothing here is taller than it, so the recordings and screenshots at this step look the same on both versions; the test reads the class. R3 shows the lost scrolling itself, after a click.')
    assert.equal(regressionText({ fact: 'body/div[1]@class', i: 1, good: '"panel"', candidate: '"panel hidden"', notice: { cls: 'visible', why: 'x' } }, { ...refs, sameLook: true }), 'After step 1 on 2.0, a panel that was shown is now hidden (nothing to hidden). The recordings and screenshots at this step look the same on both versions: the difference is in the class, which the test reads.')
    assert.equal(regressionText(t, { ...refs, id: 'R1', sameLook: false, scrollTest: { id: 'R1' } }), 'On the start page on 2.0, a split pane lost the style that lets it scroll (!overflow-auto to !overflow-hidden): content taller than it is cut off instead of scrolling.')
    assert.equal(regressionText({ fact: 'body/section[1]/div[1]@class', i: 9, good: '"inline-flex items-center px-1 group hover:x focus:y rounded"', candidate: '"flex"', notice: { cls: 'visible', why: 'x' } }, { ...refs, label: '9:click css=x' }), 'After a click on 2.0, a block is laid out differently (inline-flex to flex): its contents may wrap, align or size differently.')
    assert.equal(regressionText({ fact: 'body/div[1]@class', i: 1, good: '"panel"', candidate: '"panel hidden"', notice: { cls: 'visible', why: 'x' } }, refs), 'After step 1 on 2.0, a panel that was shown is now hidden (nothing to hidden).')
    assert.equal(regressionText({ fact: 'body/section[3]/div[3]/div[1]@class', i: 9, good: '"-mx-1 cursor-pointer focus-visible:ring focus-visible:ring-accent focus:outline-none group hover:text-secondaryDark inline-flex items-center justify-center px-1 rounded transition"', candidate: '"flex items-center"', notice: { cls: 'visible', why: 'x' } }, { ...refs, label: '9:click css=x' }), 'After a click on 2.0, a block lost its clickable styling (hand cursor, hover colour, focus ring) and is laid out as flex instead of inline-flex: it no longer looks like something to click.')
    assert.equal(regressionText({ fact: 'body/div[1]@class', i: 0, good: '"flex"', candidate: '"flex cursor-pointer hover:bg-x"', notice: { cls: 'visible', why: 'x' } }, refs), 'On the start page on 2.0, a block gained clickable styling (hand cursor, hover colour): it now looks like something to click.')
    assert.equal(regressionText({ fact: 'body/section[1]/div[3]@class', i: 9, good: '"flex items-center py-4"', candidate: '"flex flex-col py-4 space-y-4"', notice: { cls: 'churn', why: 'a style class this check cannot read (items-center flex-col space-y-4); a general style change shows in the pictures' } }, refs),
      'After step 9 on 2.0, the style classes of a block changed (items-center to flex-col space-y-4). This is markup churn (a style class this check cannot read (items-center flex-col space-y-4); a general style change shows in the pictures): a person would not notice it, and it is here so the record is complete.')
    assert.equal(regressionText({ fact: 'body/div[1]@class', i: 0, good: '"a b c d e f g"', candidate: '"x"', notice: { cls: 'churn', why: 'w' } }, refs), 'On the start page on 2.0, the style classes of a block changed (a b c d and 3 more to x). This is markup churn (w): a person would not notice it, and it is here so the record is complete.')
  })
  it('a scroll area, an appearing state, a dropped attribute, a vanished element, a text and an attribute', () => {
    assert.equal(regressionText({ fact: 'body/div[1]/main[1]#scrolls', i: 9, good: 'can scroll', candidate: 'cannot scroll on the candidate', removed: true, notice: { cls: 'visible', why: 'x' } }, { ...refs, label: '9:click css=x' }), 'After a click on 2.0, a main area cannot be scrolled: the mouse wheel over it does nothing, so anything below its edge is out of reach. On 1.0 it scrolls.')
    assert.equal(regressionText({ fact: 'body/aside[1]@inert', i: 14, good: 'absent', candidate: '""', appeared: true, notice: { cls: 'visible', why: 'x' } }, { ...refs, label: '14:goto /guide' }), 'After load /guide on 2.0, a sidebar is inert: it cannot be clicked, focused or typed into. On 1.0 it is not.')
    assert.equal(regressionText({ fact: 'body/div[1]/div[1]@data-v-f947af81', i: 0, good: '""', candidate: 'missing', removed: true, stillThere: true, notice: { cls: 'churn', why: 'a framework attribute (data-v-f947af81)' } }, refs), 'On the start page on 2.0, the data-v-f947af81 attribute dropped off a block; the element itself is still there. This is markup churn (a framework attribute (data-v-f947af81)): a person would not notice it, and it is here so the record is complete.')
    assert.equal(regressionText({ fact: 'body/nav[1]/a[2]#text', i: 1, good: '"Share"', candidate: 'missing', removed: true, notice: { cls: 'visible', why: 'x' } }, refs), 'After step 1 on 2.0, a link is missing: on 1.0 it is there, reading "Share".')
    assert.equal(regressionText({ fact: 'body/div[1]/div[2]@class', i: 3, good: '"fixed flex z-modal"', candidate: 'missing', removed: true, names: ['Go to next slide'], namesTotal: 11, notice: { cls: 'visible', why: 'x' } }, refs), 'After step 3 on 2.0, a block ("Go to next slide" and 10 more) is missing: on 1.0 it is there, with the classes "fixed flex z-modal".')
    assert.equal(regressionText({ fact: 'body/div[1]/div[1]@data-v-f947af81', i: 0, good: '""', candidate: 'missing', removed: true, notice: { cls: 'churn', why: 'a framework attribute (data-v-f947af81)' } }, refs), 'On the start page on 2.0, a block is missing: on 1.0 it is there, carrying the data-v-f947af81 attribute. This is markup churn (a framework attribute (data-v-f947af81)): a person would not notice it, and it is here so the record is complete.')
    assert.equal(regressionText({ fact: 'body/h1[1]#text', i: 0, good: '"Settings"', candidate: '"Options"', notice: { cls: 'visible', why: 'x' } }, refs), 'On the start page on 2.0, the text of a heading reads "Options", where 1.0 reads "Settings".')
    assert.equal(regressionText({ fact: 'body/a[1]@href', i: 2, good: '"/x"', candidate: '"/y"', notice: { cls: 'visible', why: 'x' } }, refs), 'After step 2 on 2.0, the href of a link is "/y", where 1.0 has "/x".')
    assert.equal(regressionText(null), null)
  })
})

describe('outcomeText says what each recording shows', () => {
  const refs = { goodRef: '1.0', candRef: '2.0', id: 'R1' }
  it('classes, a scroll area, a state, a dropped attribute, a missing element, text, an attribute', () => {
    assert.deepEqual(outcomeText({ fact: 'body/div[1]/div[3]@class', i: 0, good: '"!overflow-auto flex splitpanes__pane"', candidate: '"!overflow-hidden flex splitpanes__pane"' }, refs), { pass: 'R1 passes on 1.0: the split pane still has the class "!overflow-auto".', fail: 'R1 fails on 2.0: the split pane has "!overflow-hidden" instead of "!overflow-auto".' })
    assert.deepEqual(outcomeText({ fact: 'body/main[1]#scrolls', i: 9, good: 'can scroll', candidate: 'cannot scroll on the candidate', removed: true }, refs), { pass: 'R1 passes on 1.0: the main area scrolls when the mouse wheel turns over it.', fail: 'R1 fails on 2.0: the main area does not move when the mouse wheel turns over it.' })
    assert.deepEqual(outcomeText({ fact: 'body/aside[1]@inert', i: 1, good: 'absent', candidate: '""', appeared: true }, refs), { pass: 'R1 passes on 1.0: the sidebar has no inert attribute.', fail: 'R1 fails on 2.0: the sidebar is inert: it cannot be clicked, focused or typed into.' })
    assert.deepEqual(outcomeText({ fact: 'body/div[1]@data-v-abc', i: 0, good: '""', candidate: 'missing', removed: true, stillThere: true }, refs), { pass: 'R1 passes on 1.0: the block carries the data-v-abc attribute.', fail: 'R1 fails on 2.0: the data-v-abc attribute is gone from the block.' })
    assert.deepEqual(outcomeText({ fact: 'body/nav[1]/a[2]#text', i: 1, good: '"Share"', candidate: 'missing', removed: true }, refs), { pass: 'R1 passes on 1.0: the link is there, reading "Share".', fail: 'R1 fails on 2.0: the link is missing.' })
    // a vanished element is named by the words a person saw inside it (the first three, and how many there were)
    assert.deepEqual(outcomeText({ fact: 'body/div[1]/div[2]@class', i: 3, good: '"fixed flex z-modal"', candidate: 'missing', removed: true, vanished: 11, names: ['Go to previous slide', 'Go to next slide', 'Show slide overview'], namesTotal: 11 }, refs), { pass: 'R1 passes on 1.0: the block ("Go to previous slide", "Go to next slide", "Show slide overview" and 8 more) is there.', fail: 'R1 fails on 2.0: the block ("Go to previous slide", "Go to next slide", "Show slide overview" and 8 more) is missing.' })
    assert.deepEqual(outcomeText({ fact: 'body/div[1]/div[2]/div[1]@title', i: 11, good: '"Resize notes panel"', candidate: 'missing', removed: true, vanished: 3, names: ['Resize notes panel'], namesTotal: 1 }, refs), { pass: 'R1 passes on 1.0: the block ("Resize notes panel") is there.', fail: 'R1 fails on 2.0: the block ("Resize notes panel") is missing.' })
    // a class change with nothing readable on one side says so instead of "the classes nothing"
    assert.deepEqual(outcomeText({ fact: 'body/div[1]/div[2]@class', i: 11, good: '"grid-container layout1"', candidate: '"flex flex-col gap-2"' }, refs), { pass: 'R1 passes on 1.0: the block has no "flex" class.', fail: 'R1 fails on 2.0: the block has "flex" added.' })
    assert.deepEqual(outcomeText({ fact: 'body/div[1]/div[2]@class', i: 11, good: '"flex flex-col gap-2"', candidate: '"grid-container layout1"' }, refs), { pass: 'R1 passes on 1.0: the block still has the class "flex".', fail: 'R1 fails on 2.0: the block has lost "flex".' })
    assert.deepEqual(outcomeText({ fact: 'body/h1[1]#text', i: 0, good: '"Settings"', candidate: '"Options"' }, refs), { pass: 'R1 passes on 1.0: the heading reads "Settings".', fail: 'R1 fails on 2.0: the heading reads "Options".' })
    assert.deepEqual(outcomeText({ fact: 'body/a[1]@href', i: 2, good: '"/x"', candidate: '"/y"' }, refs), { pass: 'R1 passes on 1.0: the href of the link is "/x".', fail: 'R1 fails on 2.0: the href of the link is "/y".' })
    assert.deepEqual(outcomeText({ fact: 'body/div[1]@class', i: 9, good: '"-mx-1 cursor-pointer inline-flex px-1 rounded"', candidate: '"flex"' }, refs), { pass: 'R1 passes on 1.0: the block still has the class "inline-flex".', fail: 'R1 fails on 2.0: the block has "flex" instead of "inline-flex".' })
    assert.equal(outcomeText(null), null)
  })
})
