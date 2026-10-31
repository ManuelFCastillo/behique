// A small pool: run N async jobs with at most `size` in flight.
// Pure: no processes, files, network or timers of its own.
// Tests: node --test src/release/pool.test.mjs
export async function runPool(jobs, worker, { size = 1, onDone } = {}) {
  const list = Array.isArray(jobs) ? jobs : []
  if (list.length === 0) return []
  const n = normSize(size)
  const results = new Array(list.length)
  const free = []
  for (let s = 0; s < n; s++) free.push(s)
  let next = 0
  let done = 0
  return new Promise(resolve => {
    const launch = () => {
      while (next < list.length && free.length > 0) {
        const index = next
        next += 1
        const slot = free.shift()
        const job = list[index]
        Promise.resolve()
          .then(() => worker(job, slot, index))
          .then(
            value => {
              results[index] = { ok: true, value }
            },
            err => {
              results[index] = { ok: false, error: formatError(err) }
            },
          )
          .then(() => {
            free.push(slot)
            done += 1
            if (typeof onDone === 'function') {
              try {
                onDone(results[index], index, slot)
              } catch {}
            }
            if (done === list.length) resolve(results)
            else launch()
          })
      }
    }
    launch()
  })
}

/** basePort + slot, or null when the sum is not a valid port. */
export function slotPort(basePort, slot) {
  const r = basePort + slot
  if (!Number.isInteger(r) || r < 1024 || r > 65535) return null
  return r
}

/** How many builds to run at once. Host builds share ports so they never overlap. */
export function poolSize({ setting, sandbox, perBuildMemoryMb, freeMemoryMb } = {}) {
  if (!sandbox) return 1
  let n
  if (Number.isInteger(setting)) n = Math.min(8, Math.max(1, setting))
  else n = 3
  if (typeof perBuildMemoryMb === 'number' && typeof freeMemoryMb === 'number' &&
    Number.isFinite(perBuildMemoryMb) && Number.isFinite(freeMemoryMb) &&
    perBuildMemoryMb > 0 && freeMemoryMb > 0) {
    const cap = Math.floor(freeMemoryMb / perBuildMemoryMb)
    if (cap < 1) return 1
    n = Math.min(n, cap)
  }
  return Math.min(8, Math.max(1, n))
}

/** Group results[i] by keyOf(i), keeping each group in job order. */
export function groupInOrder(results, keyOf) {
  const out = new Map()
  const list = Array.isArray(results) ? results : []
  for (let i = 0; i < list.length; i++) {
    const k = keyOf(i)
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(list[i])
  }
  return out
}

function normSize(size) {
  if (!Number.isInteger(size) || size < 1) return 1
  return size
}

function formatError(err) {
  let s
  if (err !== null && err !== undefined && typeof err.message !== 'undefined') s = String(err.message)
  else s = String(err)
  return s.split('\n')[0].slice(0, 300)
}
