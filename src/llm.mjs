// OpenAI-compatible chat client for the two hackathon endpoints, with token accounting.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadEnv() {
  const env = { ...process.env }
  const p = join(ROOT, '.env')
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m && m[2].trim()) env[m[1]] = m[2].trim()
    }
  }
  return env
}

export const ENV = loadEnv()
export const PROVIDERS = {
  baseten: { url: 'https://inference.baseten.co/v1/chat/completions', model: 'meta-models/muse-spark-open-1026', keyEnv: 'BASETEN_API_KEY' },
  meta: { url: 'https://api.meta.ai/v1/chat/completions', model: 'muse-spark-1.3', keyEnv: 'META_API_KEY' },
}

// Estimate only: $1.25 / $4.25 per million tokens is a third-party price for Meta's Spark, unverified.
// It is applied to both providers so the per-run cap means the same thing everywhere.
export const PRICE = { inPerTok: 1.25e-6, outPerTok: 4.25e-6 }
export const estCost = (pt, ct) => pt * PRICE.inPerTok + ct * PRICE.outPerTok

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function chat(name, messages, { maxTokens = 6000, reasoning = null, temperature = null } = {}) {
  const p = PROVIDERS[name]
  const key = ENV[p.keyEnv]
  if (!key) throw new Error(`${p.keyEnv} is empty (put it in .env)`)
  // reasoning_effort (minimal|low|medium|high|xhigh) and temperature are sent only when asked for, so default runs are unchanged.
  const body = JSON.stringify({ model: p.model, max_tokens: maxTokens, messages, ...(reasoning ? { reasoning_effort: reasoning } : {}), ...(temperature !== null ? { temperature } : {}) })
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = Date.now()
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(240_000),
      })
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
        if ([429, 500, 502, 503, 504].includes(res.status)) { await sleep(3000 * (attempt + 1)); continue }
        throw lastErr
      }
      const data = await res.json()
      const ch = data.choices[0]
      return { text: ch.message.content ?? '', finish: ch.finish_reason, pt: data.usage?.prompt_tokens ?? 0, ct: data.usage?.completion_tokens ?? 0, rt: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0, ms: Date.now() - t0 }
    } catch (e) {
      lastErr = e
      if (e.name === 'TimeoutError' || e.name === 'TypeError') { await sleep(3000); continue }
      throw e
    }
  }
  throw lastErr
}
