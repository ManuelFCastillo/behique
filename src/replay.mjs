// Replay a finding from a fresh app and a fresh browser: run its recorded actions, then evaluate the
// assertion. status: 'pass' (the app does what the assertion expects), 'fail' (it does not), 'unstable' (the answer changes over time), 'error'.
import { evaluate } from './assert.mjs'
import { Session } from './session.mjs'

export async function replayFinding(base, history, spec, { stable = false, delayMs = 2000 } = {}) {
  await fetch(base + '/api/reset', { method: 'POST' }).catch(() => {}) // replay servers run with ALLOW_RESET=1
  const s = new Session(base)
  try {
    await s.open()
    for (const a of history) await s.act(a)
    const r = await evaluate(s, spec)
    // Stability: judge the same assertion again after a delay. A result that changes is a transient state, not a defect.
    // Skipped for api assertions, which send requests and would change the app's data if repeated.
    if (stable && spec.kind !== 'api') {
      await s.page.waitForTimeout(delayMs)
      const r2 = await evaluate(s, spec)
      if (r2.pass !== r.pass) return { status: 'unstable', detail: `the result changed within ${delayMs} ms: ${r.detail} then ${r2.detail}` }
    }
    return { status: r.pass ? 'pass' : 'fail', detail: r.detail }
  } catch (e) {
    return { status: 'error', detail: String(e.message).split('\n')[0].slice(0, 200) }
  } finally {
    await s.close()
  }
}
