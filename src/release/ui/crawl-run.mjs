// Progress of a "crawl and compare" run before its report exists: read from the output lines of src/release/check-app.mjs.
// Once the comparison starts it writes its own record, and the dashboard follows that instead.
//   node --test src/release/ui/crawl-run.test.mjs

/** { phase, fraction, text } from the lines printed so far (oldest first). Never throws. */
export function crawlProgress(lines) {
  const list = Array.isArray(lines) ? lines.map(l => String(l ?? '')) : []
  const last = pattern => { for (let i = list.length - 1; i >= 0; i--) { const m = list[i].match(pattern); if (m) return m } return null }
  if (list.some(l => /^(the crawl failed|the crawl did not produce|unknown app|usage:)/.test(l))) {
    const why = list.filter(l => /^(the crawl failed|the crawl did not produce|unknown app|usage:)/.test(l)).at(-1)
    return { phase: 'failed', fraction: 0, text: why.slice(0, 160) }
  }
  if (list.some(l => l.startsWith('evidence: '))) return { phase: 'comparing', fraction: 0.5, text: 'Comparing both versions along the crawled steps' }
  if (list.some(l => l.startsWith('step 2 of 2'))) return { phase: 'comparing', fraction: 0.4, text: 'Recording both versions along the crawled steps' }
  const found = last(/^(\d+) page states, (\d+) flows, (\d+) steps/)
  if (found) return { phase: 'crawled', fraction: 0.35, text: `Crawled ${found[1]} page states, ${found[3]} steps to compare` }
  const tried = list.filter(l => /^\s+path \d+ ->/.test(l)).length
  if (list.some(l => l.startsWith('step 1 of 2'))) return { phase: 'crawling', fraction: Math.min(0.3, 0.05 + tried * 0.006), text: tried > 0 ? `Crawling the app for click paths (${tried} pages looked at)` : 'Crawling the app for click paths' }
  return { phase: 'starting', fraction: 0, text: 'Starting' }
}
