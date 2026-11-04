// Crawl planner: pure breadth-first bookkeeping with no browser.
// Run tests with: node --test src/release/crawl/plan.test.mjs

function lastActionKey(action) {
  if (!action || typeof action !== 'object') return ''
  if (typeof action.key === 'string') return action.key
  if (typeof action.selector === 'string') return action.selector
  if (typeof action.label === 'string') return action.label
  return JSON.stringify(action)
}

/** The path and query of a page's address, as a `goto` step takes it, or null when the address cannot be read. */
function pathOf(url) {
  try {
    const u = new URL(String(url))
    const p = u.pathname + u.search
    return p.startsWith('/') && !p.startsWith('//') ? p : null
  } catch {
    return null
  }
}

function pathHasKey(path, candidate) {
  const key = candidate.key
  const sel = candidate.action && candidate.action.selector
  return path.some((a) => {
    if (!a || typeof a !== 'object') return false
    if (key !== undefined && (a.key === key || a.selector === key)) return true
    if (sel !== undefined && a.selector === sel) return true
    return false
  })
}

export function createPlanner({ maxDepth = 2, maxPaths = 40, maxPerPage = 12 } = {}) {
  const queue = [[]]
  let totalQueued = 1
  let tried = 0
  let seenAgain = 0
  let failedCount = 0
  const seen = new Map()
  const order = []
  // A path that lands on a state already reached another way (a sidebar link and a "previous page" link to the same page) is not a
  // new state and queues nothing, but it is still a thing a person does, and whether that control still gets there is exactly what a
  // release can break: it is kept as a flow of its own, after the states, in the order it was found.
  const again = []
  let found = 0

  function next() {
    if (queue.length === 0) return null
    tried += 1
    return queue.shift()
  }

  function report(path, state) {
    if (!state || typeof state.key !== 'string') return { isNew: false, queued: 0 }
    if (seen.has(state.key)) {
      seenAgain += 1
      if (Array.isArray(path) && path.length > 0) again.push({ key: state.key, url: state.url, title: state.title, path, order: seen.get(state.key).order, found: found++, repeat: true })
      return { isNew: false, queued: 0 }
    }
    const safePath = Array.isArray(path) ? path : []
    const entry = {
      key: state.key,
      url: state.url,
      title: state.title,
      path: safePath,
      order: order.length,
      found: found++,
    }
    seen.set(state.key, entry)
    order.push(entry)
    let queued = 0
    if (safePath.length < maxDepth) {
      const candidates = Array.isArray(state.candidates) ? state.candidates.slice(0, maxPerPage) : []
      for (const candidate of candidates) {
        if (totalQueued >= maxPaths) break
        if (!candidate || !candidate.action || typeof candidate.action !== 'object') continue
        if (candidate.key !== undefined && pathHasKey(safePath, candidate)) continue
        const step = { ...candidate.action, label: candidate.label }
        queue.push([...safePath, step])
        totalQueued += 1
        queued += 1
      }
    }
    return { isNew: true, queued }
  }

  function failed(path) {
    failedCount += 1
  }

  function stats() {
    return {
      tried,
      states: order.length,
      seenAgain,
      failed: failedCount,
      queued: queue.length,
    }
  }

  function states() {
    return order.map((e) => ({ key: e.key, url: e.url, title: e.title, path: e.path, order: e.order }))
  }

  // Click flows first (at most `max`), then direct loads: every page the clicks reached is also loaded on its own, by address,
  // once (at most `direct`). A page loaded directly is a different state from the same page reached by a click: a full load
  // hydrates from scratch, and bugs live there that a client-side navigation never shows (a sidebar left inert after a hard load).
  function flows({ max = 8, direct = 8, startPath = '/' } = {}) {
    const rest = [...order, ...again].filter((e) => Array.isArray(e.path) && e.path.length > 0)
    const sorted = [...rest].sort((a, b) => {
      if (a.path.length !== b.path.length) return a.path.length - b.path.length
      return a.found - b.found
    })
    const used = new Set()
    const out = []
    for (const entry of sorted) {
      if (out.length >= max) break
      const last = entry.path[entry.path.length - 1]
      const k = lastActionKey(last)
      if (used.has(k)) continue
      used.add(k)
      out.push({
        path: entry.path,
        state: { key: entry.key, url: entry.url, title: entry.title, path: entry.path, order: entry.order },
        ...(entry.repeat ? { repeat: true } : {}), // lands on a page another control already reached
      })
    }
    const seen = new Set([startPath])
    let loads = 0
    for (const entry of [...out.map(f => f.state), ...[...rest].sort((a, b) => a.found - b.found)]) {
      if (loads >= direct) break
      const p = pathOf(entry.url)
      if (!p || seen.has(p)) continue
      seen.add(p)
      out.push({
        path: [{ type: 'goto', path: p, label: `load ${p} directly` }],
        state: { key: entry.key, url: entry.url, title: entry.title, path: entry.path, order: entry.order },
        direct: true,
      })
      loads += 1
    }
    return out
  }

  function toSteps(flowList, { startPath = '/' } = {}) {
    if (!Array.isArray(flowList) || flowList.length === 0) return []
    const steps = []
    const push = step => {
      const last = steps[steps.length - 1]
      if (step.type === 'goto' && last && last.type === 'goto' && last.path === step.path) return // never the same load twice in a row
      steps.push({ ...step })
    }
    flowList.forEach((flow, index) => {
      const actions = flow && Array.isArray(flow.path) ? flow.path : []
      const startsFresh = actions[0] && actions[0].type === 'goto' // a direct load is its own fresh start
      if (index > 0 && actions.length > 0 && !startsFresh) push({ type: 'goto', path: startPath }) // a fresh start for every flow after the first
      for (const action of actions) push(action)
    })
    return steps
  }

  return { next, report, failed, stats, states, flows, toSteps }
}
