// Keyword (BM25) retrieval over test-case chunks. No model, no network: it only needs the index JSON files.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STOP = new Set(['the', 'and', 'for', 'with', 'await', 'async', 'const', 'page', 'expect', 'test', 'from', 'import', 'this', 'that', 'true', 'false', 'return', 'function', 'locator', 'should'])
const tokens = s => String(s).toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP.has(t))

export function loadCorpus(names) {
  const chunks = []
  for (const n of names) {
    const p = join(ROOT, `corpus/index-${n}.json`)
    if (!existsSync(p)) throw new Error(`missing corpus index ${p}: run node corpus/build.mjs ${n} <dir>`)
    chunks.push(...JSON.parse(readFileSync(p, 'utf8')).chunks)
  }
  const docs = chunks.map(c => { const t = tokens(`${c.describe} ${c.title} ${c.title} ${c.text}`); const tf = new Map(); t.forEach(x => tf.set(x, (tf.get(x) ?? 0) + 1)); return { c, tf, len: t.length } })
  const df = new Map()
  docs.forEach(d => d.tf.forEach((_, k) => df.set(k, (df.get(k) ?? 0) + 1)))
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(docs.length, 1)
  const N = docs.length

  /** Top-k chunks for a query string. At most one chunk per file, so one big suite cannot fill all slots. */
  function search(query, k = 3) {
    const q = [...new Set(tokens(query))]
    const scored = docs.map(d => {
      let s = 0
      for (const t of q) {
        const f = d.tf.get(t); if (!f) continue
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5))
        s += idf * (f * 2.5) / (f + 1.5 * (0.25 + 0.75 * d.len / avg))
      }
      return { c: d.c, s }
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s)
    const seenFiles = new Set(), out = []
    for (const x of scored) {
      const key = x.c.repo + x.c.path
      if (seenFiles.has(key)) continue
      seenFiles.add(key); out.push(x.c)
      if (out.length >= k) break
    }
    return out
  }
  return { search, size: N, sets: names }
}

/** Build a query from what the tester can see: the accessibility tree and the latest actions. */
export function queryFrom(aria, recentActions) {
  const names = [...String(aria).matchAll(/- (\w+)(?: "([^"]*)")?/g)].map(m => `${m[1]} ${m[2] ?? ''}`).join(' ')
  return `${names} ${recentActions.join(' ')}`.slice(0, 1500)
}

export const render = chunks => chunks.map((c, i) => `Example ${i + 1} (${c.repo}, ${c.path}):\n${c.text.slice(0, 700)}`).join('\n\n')
