// Deterministic checks a report must pass before it is accepted. No model is involved.
import { normPath } from './session.mjs'

/**
 * An api assertion may only use endpoints (and body fields) that the app's own pages have called.
 * Guessing a route like /api/login, or a field the app never sends, is the commonest false alarm.
 * Returns a reason string when the report is ungrounded, else null.
 */
export function groundingProblem(session, spec) {
  if (spec.kind !== 'api') return null
  const seenList = [...session.seen.keys()].join(', ') || 'none yet'
  for (const st of spec.steps ?? []) {
    const method = String(st?.method || 'GET').toUpperCase()
    const key = `${method} ${normPath(st?.path ?? '')}`
    if (!session.seen.has(key)) {
      return `the app's own pages have never called ${key}. An assertion may only use endpoints the app itself calls (seen so far: ${seenList}). Use the page's controls first so you can see which calls it makes`
    }
    const fields = session.seen.get(key)
    if (fields.size && st.body && typeof st.body === 'object') {
      const extra = Object.keys(st.body).filter(k => !fields.has(k))
      if (extra.length) return `the app's own requests to ${key} only use the field(s) ${[...fields].join(', ')}, not ${extra.join(', ')}`
    }
  }
  return null
}
