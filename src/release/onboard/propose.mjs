// Propose a profile: build messages, parse the model answer, estimate cost.
//   node --test src/release/onboard/propose.test.mjs
import { validateProfile } from './profile.mjs'

export function buildMessages(facts, skillText, { good, cand } = {}) {
  const user = [
    `Compare two versions of the same app: good version "${good}" and candidate version "${cand}".`,
    'Facts about the repo (JSON):',
    JSON.stringify(facts, null, 2),
    'The answer must be a single JSON object and nothing else.'
  ].join('\n')
  return [
    { role: 'system', content: skillText },
    { role: 'user', content: user }
  ]
}

function extractFirstObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export function parseProfile(answer) {
  try {
    const text = String(answer)
    const slice = extractFirstObject(text)
    if (slice === null) return { profile: null, problems: ['answer contains no JSON object'] }
    let parsed
    try {
      parsed = JSON.parse(slice)
    } catch (err) {
      return { profile: null, problems: [`answer is not valid JSON: ${err.message}`] }
    }
    const problems = validateProfile(parsed)
    return { profile: parsed, problems }
  } catch (err) {
    return { profile: null, problems: [String(err && err.message ? err.message : err)] }
  }
}

export async function proposeProfile({ facts, skillText, ask, good, cand }) {
  const messages = buildMessages(facts, skillText, { good, cand })
  const res = await ask(messages)
  const raw = res.text
  const { profile, problems } = parseProfile(raw)
  if (profile !== null && typeof profile === 'object') {
    if (profile.defaults === undefined || profile.defaults === null || typeof profile.defaults !== 'object') {
      profile.defaults = { good, cand }
    } else {
      if (typeof profile.defaults.good !== 'string' || profile.defaults.good.length === 0) {
        profile.defaults.good = good
      }
      if (typeof profile.defaults.cand !== 'string' || profile.defaults.cand.length === 0) {
        profile.defaults.cand = cand
      }
    }
  }
  return { profile, problems, usage: { pt: res.pt, ct: res.ct }, raw, messages }
}

export function projectCost(messages, { priceIn = 1.25e-6, priceOut = 4.25e-6, expectedOut = 1500 } = {}) {
  let chars = 0
  for (const m of messages) chars += String(m && m.content ? m.content : '').length
  const promptTokens = chars / 3.5
  return promptTokens * priceIn + expectedOut * priceOut
}
