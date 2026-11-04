// A push to the person's phone when a dashboard run ends, through ntfy. The topic is the secret, so it lives in a file outside the repository
// (~/.config/behique/ntfy.conf, a line NTFY_TOPIC=<topic>, the format of the host's own alert file), never in the code, a log or the message. With no file, nothing is sent and nothing fails.
//   node --test src/release/ui/notify.test.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CONFIG_PATH = join(homedir(), '.config', 'behique', 'ntfy.conf')
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/

/** The topic from the config text, or null. */
export function topicOf(text) {
  const m = String(text ?? '').match(/^\s*(?:NTFY_)?TOPIC\s*=\s*"?([^"\s]+)"?\s*$/m)
  return m && TOPIC_RE.test(m[1]) ? m[1] : null
}

const minutes = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : `${m} min` }

/** Title, body and priority for a finished run. `vm` is the report's view model, or null when there is no report. */
export function runMessage({ status, app, goodRef, candRef, startedAt }, vm, now = Date.now()) {
  const what = `${app ?? 'app'} ${goodRef ?? ''} vs ${candRef ?? ''}`.replace(/\s+/g, ' ').trim()
  const took = startedAt ? `, ${minutes(now - Date.parse(startedAt))}` : ''
  if (status === 'cancelled') return { title: `Behique: cancelled`, body: `${what}${took}`, priority: 'low' }
  const word = { hold: 'HOLD', ship: 'SHIP', inconclusive: 'REVIEW', fail: 'INCOMPLETE', pass: 'SHIP' }[vm?.verdict]
  if (status !== 'finished' || !word) return { title: 'Behique: run failed', body: `${what}${took}. No recommendation.`, priority: 'high' }
  return { title: `Behique: ${word}`, body: `${what}${took}. ${String(vm.sub ?? '').slice(0, 200)}`.trim(), priority: word === 'HOLD' || word === 'INCOMPLETE' ? 'high' : 'default' }
}

/** Send one push. Resolves true when it was accepted, false when there is no topic or the send failed; it never throws, since a run has already ended. */
export async function push(message, { configPath = CONFIG_PATH, fetchFn = fetch, read = readFileSync } = {}) {
  let topic
  try { topic = topicOf(read(configPath, 'utf8')) } catch { return false }
  if (!topic) return false
  try {
    const r = await fetchFn(`https://ntfy.sh/${topic}`, { method: 'POST', headers: { Title: message.title, Priority: message.priority ?? 'default', Tags: 'mag' }, body: message.body, signal: AbortSignal.timeout(10000) })
    return r.ok
  } catch { return false }
}
