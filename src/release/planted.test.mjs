// Tests for the planted app with known changes and its scorer.
// Run with: node --test src/release/planted.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBaseApp, MUTATIONS, applyMutation, planHistory, scorePlanted } from './planted.mjs'

const EXPECTED_FILES = ['about.html', 'index.html', 'list.html', 'style.css'].sort()

function tagFor(id) {
  return 'm-' + id
}

function foundResult(tag, extra = {}) {
  return { tag, outcome: 'confirmed', candidateDifferences: 2, controlDifferences: 0, confirmed: 1, total: 2, ...extra }
}

function missedResult(tag, extra = {}) {
  return { tag, outcome: 'no_change', candidateDifferences: 0, controlDifferences: 0, confirmed: 0, total: 0, ...extra }
}

describe('buildBaseApp', () => {
  it('has exactly the expected files', () => {
    const { files } = buildBaseApp()
    assert.deepEqual(Object.keys(files).sort(), EXPECTED_FILES)
    for (const text of Object.values(files)) assert.equal(typeof text, 'string')
  })

  it('is deterministic across two calls', () => {
    assert.deepEqual(buildBaseApp(), buildBaseApp())
  })

  it('has the build comment exactly once per page', () => {
    const { files } = buildBaseApp()
    for (const name of ['index.html', 'about.html', 'list.html']) {
      const count = files[name].split('<!-- build 1 -->').length - 1
      assert.equal(count, 1)
    }
  })

  it('has the required titles and headings', () => {
    const { files } = buildBaseApp()
    assert.match(files['index.html'], /<title>Planted Home<\/title>/)
    assert.match(files['index.html'], /<h1>Planted Home<\/h1>/)
    assert.match(files['about.html'], /<title>About Planted<\/title>/)
    assert.match(files['about.html'], /<h1>About<\/h1>/)
    assert.match(files['list.html'], /<title>Planted List<\/title>/)
    assert.match(files['list.html'], /<h1>Planted list<\/h1>/)
  })

  it('pages are html with lang en and link the stylesheet', () => {
    const { files } = buildBaseApp()
    for (const name of ['index.html', 'about.html', 'list.html']) {
      assert.match(files[name], /<html lang="en">/)
      assert.match(files[name], /style\.css/)
    }
    assert.match(files['style.css'], /body \{ background: #ffffff; \}/)
  })

  it('has nav, counter, tabs and details on the home page', () => {
    const { files } = buildBaseApp()
    const home = files['index.html']
    assert.match(home, /<a href="\/about\.html" title="About this site">About<\/a>/)
    assert.match(home, /<a href="\/list\.html">List<\/a>/)
    assert.match(home, /<button id="count" data-step="1" aria-label="Increase the counter">/)
    assert.match(home, /<button id="reset" type="button">Reset<\/button>/)
    assert.match(home, /role="tab"/)
    assert.match(home, /aria-selected="true"/)
    assert.match(home, /aria-selected="false"/)
    assert.match(home, /Panel one text/)
    assert.match(home, /Panel two text/)
    assert.match(home, /<details><summary>More info<\/summary><p>Hidden details text<\/p><\/details>/)
  })

  it('has about and list content', () => {
    const { files } = buildBaseApp()
    assert.match(files['about.html'], /This is the about page\./)
    assert.match(files['list.html'], /<li data-id="item-1">First item<\/li>/)
    assert.match(files['list.html'], /<li data-id="item-4">Fourth item<\/li>/)
  })

  it('has no external urls, random or dates', () => {
    const { files } = buildBaseApp()
    for (const [name, text] of Object.entries(files)) {
      assert.ok(!text.includes('http://'), name + ' has http url')
      assert.ok(!text.includes('https://'), name + ' has https url')
      assert.ok(!text.includes('Math.random'), name + ' mentions random')
    }
  })
})

describe('MUTATIONS', () => {
  it('has nine entries with unique ids', () => {
    assert.equal(MUTATIONS.length, 9)
    assert.deepEqual(new Set(MUTATIONS.map((m) => m.id)).size, 9)
  })

  it('has the expected ids, kinds, files and expectations', () => {
    const byId = new Map(MUTATIONS.map((m) => [m.id, m]))
    assert.equal(byId.get('data-attr').kind, 'attribute')
    assert.equal(byId.get('heading-text').kind, 'text')
    assert.equal(byId.get('background').kind, 'visual')
    assert.equal(byId.get('background').expectDetected, false)
    for (const m of MUTATIONS) {
      if (m.id !== 'background') assert.equal(m.expectDetected, true)
      assert.equal(typeof m.why, 'string')
      assert.ok(m.why.length > 10)
    }
  })

  it('every find occurs exactly once and differs from replace', () => {
    const { files } = buildBaseApp()
    for (const m of MUTATIONS) {
      const text = files[m.file]
      assert.ok(typeof text === 'string', m.id)
      const count = text.split(m.find).length - 1
      assert.equal(count, 1, m.id + ' find count is ' + count)
      assert.notEqual(m.find, m.replace)
    }
  })

  it('applyMutation applies one file only and keeps the input untouched', () => {
    const { files } = buildBaseApp()
    const before = JSON.parse(JSON.stringify(files))
    for (const m of MUTATIONS) {
      const out = applyMutation(files, m.id)
      assert.equal(out.ok, true)
      assert.deepEqual(files, before)
      for (const name of Object.keys(files)) {
        if (name === m.file) assert.notDeepEqual(out.files[name], files[name])
        else assert.equal(out.files[name], files[name])
      }
      assert.ok(out.files[m.file].includes(m.replace))
    }
    assert.deepEqual(files, before)
  })

  it('applyMutation reports unknown id, missing file and non-unique find', () => {
    const { files } = buildBaseApp()
    const unknown = applyMutation(files, 'nope')
    assert.equal(unknown.ok, false)
    assert.match(unknown.error, /unknown/i)
    const missing = applyMutation({}, 'data-attr')
    assert.equal(missing.ok, false)
    assert.match(missing.error, /missing/i)
    const dup = { ...files, 'list.html': files['list.html'] + files['list.html'] }
    const bad = applyMutation(dup, 'data-attr')
    assert.equal(bad.ok, false)
    assert.match(bad.error, /exactly once|one match/i)
  })
})

describe('planHistory', () => {
  it('has 11 entries in order with tags and messages', () => {
    const history = planHistory()
    assert.equal(history.length, 11)
    assert.equal(history[0].tag, 'base')
    assert.equal(history[0].mutation, null)
    assert.equal(history[0].message, 'Planted app: base')
    const tags = history.map((h) => h.tag)
    assert.deepEqual(tags, ['base', ...MUTATIONS.map((m) => tagFor(m.id)), 'noop'])
    assert.equal(history[history.length - 1].message, 'Planted app: comment only')
    for (let i = 1; i <= MUTATIONS.length; i++) {
      assert.equal(history[i].message, 'Planted change: ' + MUTATIONS[i - 1].id)
      assert.equal(history[i].mutation, MUTATIONS[i - 1].id)
    }
  })

  it('each candidate differs from base in exactly one file and is not cumulative', () => {
    const history = planHistory()
    const base = history[0].files
    for (let i = 1; i <= MUTATIONS.length; i++) {
      const changed = Object.keys(base).filter((k) => history[i].files[k] !== base[k])
      assert.deepEqual(changed, [MUTATIONS[i - 1].file])
    }
    for (let i = 1; i <= MUTATIONS.length; i++) {
      for (let j = 1; j <= MUTATIONS.length; j++) {
        if (i === j) continue
        const other = MUTATIONS[j - 1]
        if (other.replace === '') continue // removal: an empty string is in every text
        assert.ok(!history[i].files[other.file].includes(other.replace) || MUTATIONS[i - 1].id === other.id, 'cumulative change')
      }
    }
  })

  it('noop changes every html file comment only', () => {
    const history = planHistory()
    const base = history[0].files
    const noop = history[history.length - 1].files
    assert.equal(noop['style.css'], base['style.css'])
    for (const name of ['index.html', 'about.html', 'list.html']) {
      assert.ok(noop[name].includes('<!-- build 2 -->'))
      assert.ok(!noop[name].includes('<!-- build 1 -->'))
      assert.equal(noop[name].split('<!-- build 2 -->').length - 1, 1)
    }
  })
})

describe('scorePlanted', () => {
  it('scores all found with no false positive', () => {
    const results = MUTATIONS.filter((m) => m.expectDetected).map((m) => foundResult(tagFor(m.id)))
    results.push({ tag: 'noop', outcome: 'no_change', candidateDifferences: 0, controlDifferences: 0, confirmed: 0, total: 0 })
    const score = scorePlanted(results)
    const visible = MUTATIONS.filter((m) => m.expectDetected)
    assert.equal(score.detectionRate, 1)
    assert.equal(score.confirmRate, 1)
    assert.equal(score.falsePositives, 0)
    assert.equal(score.errors, 0)
    assert.equal(score.blindSpotsConfirmed, 0)
    assert.ok(score.rows.find((r) => r.tag === 'noop'))
    assert.equal(visible.length, 8)
  })

  it('counts misses and rounds rates to two decimals', () => {
    const visible = MUTATIONS.filter((m) => m.expectDetected)
    const results = [
      foundResult(tagFor(visible[0].id)),
      missedResult(tagFor(visible[1].id)),
      missedResult(tagFor(visible[2].id))
    ]
    const score = scorePlanted(results)
    assert.equal(score.detectionRate, 0.33)
    assert.equal(score.confirmRate, 0.33)
    assert.equal(score.notRun, 6)
    assert.equal(score.falsePositives, null)
  })

  it('handles error, inconclusive and not run rows', () => {
    const visible = MUTATIONS.filter((m) => m.expectDetected)
    const results = [
      foundResult(tagFor(visible[0].id)),
      { tag: tagFor(visible[1].id), outcome: 'timeout', candidateDifferences: 0, controlDifferences: 0, confirmed: 0, total: 0 },
      foundResult(tagFor(visible[2].id), { controlDifferences: 3 })
    ]
    const score = scorePlanted(results)
    const byTag = new Map(score.rows.map((r) => [r.tag, r]))
    assert.equal(byTag.get(tagFor(visible[1].id)).status, 'error')
    assert.equal(byTag.get(tagFor(visible[2].id)).status, 'inconclusive')
    assert.equal(score.errors, 1)
    assert.equal(score.inconclusive, 1)
    assert.equal(score.detectionRate, 1)
  })

  it('treats every error outcome as an error', () => {
    for (const outcome of ['build_failed', 'crawl_failed', 'no_steps', 'timeout', 'error']) {
      const score = scorePlanted([{ tag: 'm-data-attr', outcome, candidateDifferences: 5, controlDifferences: 0, confirmed: 0, total: 0 }])
      assert.equal(score.rows.find((r) => r.tag === 'm-data-attr').status, 'error')
    }
  })

  it('flags a false positive when the noop is found, null when missing', () => {
    const yes = scorePlanted([{ tag: 'noop', outcome: 'confirmed', candidateDifferences: 1, controlDifferences: 0, confirmed: 0, total: 1 }])
    assert.equal(yes.falsePositives, 1)
    const none = scorePlanted([])
    assert.equal(none.falsePositives, null)
    const err = scorePlanted([{ tag: 'noop', outcome: 'error', candidateDifferences: 0, controlDifferences: 0, confirmed: 0, total: 0 }])
    assert.equal(err.falsePositives, null)
  })

  it('counts blind spots when the background change is detected', () => {
    const seen = scorePlanted([foundResult('m-background')])
    assert.equal(seen.blindSpotsConfirmed, 1)
    assert.equal(seen.rows.find((r) => r.tag === 'm-background').status, 'found')
    const missed = scorePlanted([missedResult('m-background')])
    assert.equal(missed.blindSpotsConfirmed, 0)
  })

  it('returns null rates when nothing ran', () => {
    const score = scorePlanted([])
    assert.equal(score.detectionRate, null)
    assert.equal(score.confirmRate, null)
    assert.equal(score.notRun, 9)
  })

  it('ignores unknown tags', () => {
    const score = scorePlanted([{ tag: 'm-unknown', outcome: 'confirmed', candidateDifferences: 9, controlDifferences: 0, confirmed: 1, total: 1 }])
    assert.ok(!score.rows.some((r) => r.tag === 'm-unknown'))
    assert.equal(score.detectionRate, null)
  })

  it('writes person readable lines', () => {
    const results = [foundResult('m-data-attr'), missedResult('m-heading-text')]
    results.push({ tag: 'noop', outcome: 'no_change', candidateDifferences: 0, controlDifferences: 0, confirmed: 0, total: 0 })
    const score = scorePlanted(results)
    assert.match(score.lines, /m-data-attr: found \(attribute\) detected/)
    assert.match(score.lines, /m-heading-text: missed \(text\)/)
    assert.match(score.lines, /detection rate: 50%/)
    assert.match(score.lines, /confirmed as a test: 50%/)
    assert.match(score.lines, /false positive on the comment-only change: no/)
    assert.match(score.lines, /errors: 0, inconclusive: 0, not run: 7/)
    const blind = scorePlanted([foundResult('m-background')])
    assert.match(blind.lines, /expected to be invisible to facts/)
  })
})
