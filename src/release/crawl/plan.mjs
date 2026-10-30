// Crawl planner: pure breadth-first bookkeeping with no browser.
// Run tests with: node --test src/release/crawl/plan.test.mjs

function lastActionKey(action) {
  if (!action || typeof action !== 'object') return ''
  if (typeof action.key === 'string') return action.key
  if (typeof action.selector === 'string') return action.selector
  if (typeof action.label === 'string') return action.label
  return JSON.stringify(action)
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

  function next() {
    if (queue.length === 0) return null
    tried += 1
    return queue.shift()
  }

  function report(path, state) {
    if (!state || typeof state.key !== 'string') return { isNew: false, queued: 0 }
    if (seen.has(state.key)) {
      seenAgain += 1
      return { isNew: false, queued: 0 }
    }
    const safePath = Array.isArray(path) ? path : []
    const entry = {
      key: state.key,
      url: state.url,
      title: state.title,
      path: safePath,
      order: order.length,
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

  function flows({ max = 8 } = {}) {
    const rest = order.filter((e) => Array.isArray(e.path) && e.path.length > 0)
    const sorted = [...rest].sort((a, b) => {
      if (a.path.length !== b.path.length) return a.path.length - b.path.length
      return a.order - b.order
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
      })
    }
    return out
  }

  function toSteps(flowList, { startPath = '/' } = {}) {
    if (!Array.isArray(flowList) || flowList.length === 0) return []
    const steps = []
    const push = step => {
      if (step.type === 'goto' && steps.length > 0 && steps[steps.length - 1].type === 'goto') return // never two in a row
      steps.push({ ...step })
    }
    flowList.forEach((flow, index) => {
      const actions = flow && Array.isArray(flow.path) ? flow.path : []
      if (index > 0 && actions.length > 0) push({ type: 'goto', path: startPath }) // a fresh start for every flow after the first
      for (const action of actions) push(action)
    })
    return steps
  }

  return { next, report, failed, stats, states, flows, toSteps }
}
