// `behique check --explain`: after a bisect names the first bad change, ask the model why, once, through the same guarded
// path as the dashboard's Ask card (`ask.mjs`): the exact text is previewed, the call is capped, the answer is recorded as an
// `ai_hypothesis` claim (a guess, never proof) and its quote is checked against the diff. Passing --explain is the person's
// confirmation of what is sent: the observed difference and that one commit's message and diff, nothing else.
// A refusal or a failure never changes the check's verdict or exit code; it only leaves the explanation out.
//   node --test src/release/cli/explain.test.mjs
import { askModel, askPreview } from '../ask.mjs'

/**
 * Resolves { ok: true, usd, grounded } after one recorded call, or { ok: false, reason } and nothing spent. Never throws.
 * `previewFn` and `ask` are the test seams that `ask.mjs` already offers.
 */
export async function explainCase(c, { previewFn, ask, log = () => {} } = {}) {
  try {
    const p = await askPreview(c, { previewFn })
    if (!p.ok || !p.canSend) return { ok: false, reason: p.reason ?? 'the model cannot be asked about this case' }
    log(`explain: sending the observed difference and one code change to ${p.model}; projected about $${p.est.expectedUsd.toFixed(4)}, worst case $${p.est.worstUsd.toFixed(4)} (estimate)`)
    const r = await askModel(c, { confirm: p.confirm, previewFn, ask })
    if (!r.ok) return { ok: false, reason: r.error }
    log(`explain: recorded an AI hypothesis (about $${r.usd.toFixed(4)}), its quote was ${r.grounded ? 'found' : 'NOT found'} in the change`)
    return { ok: true, usd: r.usd, grounded: r.grounded }
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e).slice(0, 300) }
  }
}
