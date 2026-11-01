// The rules for a person's Ship or Hold decision, and the one place a decision is written.
// Behique RECOMMENDS (the verdict, read from the record); a person DECIDES. The two are kept apart: every decision records
// what Behique recommended at that moment, whether it went against that recommendation (an override), and which earlier
// decision it replaces. The record is append-only, so a decision can be superseded but never removed.
import { basename, dirname } from 'node:path'
import { anchor } from './anchor.mjs'
import { summarize } from './evidence.mjs'
import { verdictOf } from './viewmodel.mjs'

export const REASON = { min: 3, minOverride: 10, max: 500, whoMax: 80 }
export const OVERRIDE_PROMPT = 'A reproduced failure exists. Ship anyway?'

/**
 * Pure rules. Returns { ok: true, choice, reason, who, override } or { ok: false, status, error, needsOverride? }.
 * Beyond the reason rules: nothing can be decided while a run is still going, and Ship is refused while the evidence is
 * incomplete (Hold stays possible), because shipping on missing evidence is not a judgement about what was found.
 */
export function checkDecision({ verdict, choice, reason, who = '', confirmOverride = false }) {
  const no = (status, error, extra = {}) => ({ ok: false, status, error, ...extra })
  if (choice !== 'ship' && choice !== 'hold') return no(400, 'A decision must be ship or hold.')
  if (verdict === 'running') return no(400, 'The run has not finished, so there is nothing to decide yet.')
  if (choice === 'ship' && verdict === 'fail') return no(400, 'Cannot ship: the evidence is incomplete. You can still hold.')
  const name = String(who ?? '').trim()
  if (name.length > REASON.whoMax) return no(400, `The name is too long (${REASON.whoMax} characters at most).`)
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim() // one line
  if (text.length < REASON.min) return no(400, `A reason is required (at least ${REASON.min} characters).`)
  if (text.length > REASON.max) return no(400, `The reason is too long (${REASON.max} characters at most).`)
  const override = choice === 'ship' && verdict === 'hold'
  if (override) {
    if (confirmOverride !== true) return no(409, `${OVERRIDE_PROMPT} Confirm the override and give a reason of at least ${REASON.minOverride} characters.`, { needsOverride: true })
    if (text.length < REASON.minOverride) return no(400, `Shipping against a proven change needs a reason of at least ${REASON.minOverride} characters.`)
  }
  return { ok: true, choice, reason: text, who: name, override }
}

/** Read the record, apply the rules, and append the decision. A refused decision appends nothing. */
export function recordDecision(c, input, now = Date.now()) {
  const events = c.read()
  if (!events.length) return { ok: false, status: 404, error: 'This record is empty or does not exist.' }
  const s = summarize(events), verdict = verdictOf(events, s, now)
  const r = checkDecision({ verdict, choice: input?.decision, reason: input?.note, who: input?.who, confirmOverride: input?.confirmOverride === true })
  if (!r.ok) return r
  const supersedes = s.decisions.at(-1)?.seq ?? null
  const seq = c.decide(r.choice, { who: r.who, note: r.reason, override: r.override, recommendation: verdict, supersedes })
  // a decision is the moment a person signs the record, so its head goes to the ledger outside the case folder
  let anchored = null
  try { anchored = anchor(dirname(c.dir), basename(c.dir), c, { mirror: process.env.BEHIQUE_ANCHOR_MIRROR || null }).seq } catch {}
  return { ok: true, seq, override: r.override, recommendation: verdict, supersedes, anchored }
}
