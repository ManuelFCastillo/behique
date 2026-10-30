import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { crawlProgress } from './crawl-run.mjs'

describe('crawlProgress', () => {
  it('follows the run from nothing to the comparison', () => {
    assert.equal(crawlProgress([]).phase, 'starting')
    assert.equal(crawlProgress(['step 1 of 2: crawling x 1.0 for click paths']).phase, 'crawling')
    const mid = crawlProgress(['step 1 of 2: crawling x 1.0 for click paths', '  path 1 -> a http://x/', '  path 2 -> b http://x/'])
    assert.match(mid.text, /2 pages looked at/)
    assert.ok(mid.fraction > 0.05 && mid.fraction <= 0.3)
    assert.equal(crawlProgress(['step 1 of 2: crawling', '24 page states, 13 flows, 31 steps (stopped: paths, 67 s)']).phase, 'crawled')
    assert.match(crawlProgress(['24 page states, 13 flows, 31 steps (stopped: paths, 67 s)']).text, /24 page states, 31 steps/)
    assert.equal(crawlProgress(['step 2 of 2: comparing a and b along the crawled steps']).phase, 'comparing')
    assert.equal(crawlProgress(['step 2 of 2: comparing', 'evidence: 2026_x']).fraction, 0.5)
  })
  it('reports a failure in the run\'s own words and never throws on junk', () => {
    const f = crawlProgress(['step 1 of 2: crawling', 'the crawl failed: no server'])
    assert.equal(f.phase, 'failed'); assert.match(f.text, /no server/)
    for (const junk of [null, undefined, 5, [null, 3, {}]]) assert.ok(crawlProgress(junk).phase)
  })
})
