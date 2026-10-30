// The rules for asking the model why a proven regression happened, from the dashboard. The model call is the only paid step,
// so this is the only place it is allowed to start from a page: it looks at what would be sent, and refuses unless the person
// confirmed exactly that text.
//   askPreview(c)  -> what would be sent and what it would cost; calls nothing
//   askModel(c, { confirm })  -> the paid call, only if `confirm` is the fingerprint of the text askPreview shows right now
import { createHash } from 'node:crypto'
import { summarize } from './evidence.mjs'
import { LIMITS, hypothesize, preview } from './hypothesis.mjs'
import { verdictOf } from './viewmodel.mjs'

export const PROVIDER = 'meta'
const fingerprint = (messages, provider) => createHash('sha256').update(provider + '\n' + JSON.stringify(messages)).digest('hex').slice(0, 16)

/** Why a question cannot be asked of this report right now, or null. Cheap: reads only the record. */
export function whyNot(c, now = Date.now()) {
  const events = c.read(), s = summarize(events)
  if (verdictOf(events, s, now) === 'running') return 'The run has not finished. Ask once it has.'
  const guesses = s.claims.filter(k => k.label === 'ai_hypothesis').length
  if (guesses >= LIMITS.maxPerCase) return `This report already has ${guesses} AI guesses, the limit.`
  return null
}

/** Everything the page shows before a person may spend anything. Never throws; `ok: false` carries the reason. */
export async function askPreview(c, { now = Date.now(), provider = PROVIDER, previewFn = preview } = {}) {
  const guesses = summarize(c.read()).claims.filter(k => k.label === 'ai_hypothesis').length
  const base = { ok: false, guesses, limit: LIMITS.maxPerCase }
  const blocked = whyNot(c, now)
  if (blocked) return { ...base, reason: blocked }
  let p
  try { p = await previewFn(c, provider) } catch (e) { return { ...base, reason: String(e.message).replace(/^this case/, 'This report') } }
  return {
    ...base, ok: true, canSend: p.keyPresent, reason: p.keyPresent ? null : `No API key is set for ${provider}, so nothing can be sent.`,
    provider, model: p.est.model, est: p.est, symptoms: p.ctx.symptoms, truncated: p.ctx.truncated,
    sent: p.messages, confirm: fingerprint(p.messages, provider), // the text, word for word, as it would leave this machine
  }
}

/** Make the call, if the person confirmed what askPreview showed. Resolves { ok, status, error } on a refusal, never spends then. */
export async function askModel(c, { confirm, now = Date.now(), provider = PROVIDER, ask = hypothesize, previewFn } = {}) {
  const no = (status, error, extra = {}) => ({ ok: false, status, error, ...extra })
  const p = await askPreview(c, { now, provider, previewFn })
  if (!p.ok || !p.canSend) return no(400, p.reason)
  if (typeof confirm !== 'string' || confirm !== p.confirm) return no(409, 'What would be sent has changed, or you have not reviewed it. Review it again before sending.', { stale: true })
  const r = await ask(c, provider)
  return { ok: true, usd: r.usd, grounded: r.grounded, seq: r.seq }
}
