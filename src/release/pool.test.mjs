import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPool, slotPort, poolSize, groupInOrder } from './pool.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

test('7 jobs size 3: at most 3 in flight, ordered results, distinct slots', async () => {
  const jobs = [0, 1, 2, 3, 4, 5, 6]
  let inFlight = 0
  let maxInFlight = 0
  const usedSlots = new Set()
  const live = new Set()
  const worker = async (job, slot, index) => {
    assert.ok(slot === 0 || slot === 1 || slot === 2, `slot ${slot} in range`)
    assert.ok(!live.has(slot), `slot ${slot} not shared`)
    live.add(slot)
    usedSlots.add(slot)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    assert.ok(inFlight <= 3, 'at most 3 in flight')
    await sleep(10 + (index % 3) * 10)
    inFlight -= 1
    live.delete(slot)
    return job * 2
  }
  const results = await runPool(jobs, worker, { size: 3 })
  assert.equal(maxInFlight, 3)
  assert.equal(results.length, 7)
  for (let i = 0; i < 7; i++) {
    assert.deepEqual(results[i], { ok: true, value: i * 2 })
  }
  for (const s of usedSlots) assert.ok(s >= 0 && s <= 2)
})

test('worker that throws on job 2 gives ok false for job 2 only', async () => {
  const jobs = ['a', 'b', 'c', 'd']
  const results = await runPool(
    jobs,
    async job => {
      await sleep(5)
      if (job === 'b') throw new Error('boom line1\nline2')
      return job.toUpperCase()
    },
    { size: 2 },
  )
  assert.equal(results.length, 4)
  assert.deepEqual(results[0], { ok: true, value: 'A' })
  assert.equal(results[1].ok, false)
  assert.equal(results[1].error, 'boom line1')
  assert.deepEqual(results[2], { ok: true, value: 'C' })
  assert.deepEqual(results[3], { ok: true, value: 'D' })
})

test('error text is first line only and at most 300 chars', async () => {
  const long = 'x'.repeat(500) + '\nsecond'
  const results = await runPool([1], async () => { throw new Error(long) }, { size: 1 })
  assert.equal(results[0].ok, false)
  assert.equal(results[0].error.length, 300)
  assert.equal(results[0].error, 'x'.repeat(300))
})

test('onDone called 7 times in finish order with right index; throwing onDone ignored', async () => {
  const jobs = [0, 1, 2, 3, 4, 5, 6]
  const seen = []
  const worker = async (job, slot, index) => {
    await sleep(job === 0 ? 30 : 10)
    return index
  }
  const results = await runPool(jobs, worker, {
    size: 3,
    onDone: (result, index, slot) => {
      seen.push({ result, index, slot })
      if (index === 3) throw new Error('log failed')
    },
  })
  assert.equal(seen.length, 7)
  assert.deepEqual([...seen.map(s => s.index)].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6])
  for (const s of seen) {
    assert.deepEqual(s.result, results[s.index])
    assert.ok(s.slot >= 0 && s.slot <= 2)
  }
  assert.equal(seen[0].index !== 0, true)
})

test('size 1 runs strictly in sequence', async () => {
  const order = []
  const jobs = [1, 2, 3]
  await runPool(
    jobs,
    async job => {
      order.push(`start ${job}`)
      await sleep(10)
      order.push(`end ${job}`)
      return job
    },
    { size: 1 },
  )
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
})

test('size 0 and size 2.5 behave as 1', async () => {
  for (const size of [0, 2.5]) {
    let inFlight = 0
    let maxInFlight = 0
    await runPool([1, 2, 3], async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await sleep(10)
      inFlight -= 1
    }, { size })
    assert.equal(maxInFlight, 1, `size ${size} acts as 1`)
  }
})

test('size 50 with 3 jobs runs all 3 at once', async () => {
  let inFlight = 0
  let maxInFlight = 0
  let started = 0
  const results = await runPool([1, 2, 3], async job => {
    started += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await sleep(20)
    inFlight -= 1
    return job
  }, { size: 50 })
  assert.equal(started, 3)
  assert.equal(maxInFlight, 3)
  assert.equal(results.length, 3)
})

test('empty jobs resolves to []', async () => {
  const results = await runPool([], async () => 1, { size: 3 })
  assert.deepEqual(results, [])
})

test('slotPort adds slot and refuses bad ports', () => {
  assert.equal(slotPort(8300, 2), 8302)
  assert.equal(slotPort(65535, 1), null)
  assert.equal(slotPort(1023, 0), null)
  assert.equal(slotPort(1024, 0), 1024)
  assert.equal(slotPort(65535, 0), 65535)
})

test('poolSize: no sandbox is always 1', () => {
  assert.equal(poolSize({ sandbox: false, setting: 5 }), 1)
  assert.equal(poolSize({ setting: 8, perBuildMemoryMb: 1, freeMemoryMb: 100000 }), 1)
  assert.equal(poolSize({}), 1)
  assert.equal(poolSize(), 1)
})

test('poolSize: sandbox memory cap and setting defaults', () => {
  assert.equal(poolSize({ sandbox: true, setting: 3, freeMemoryMb: 27000, perBuildMemoryMb: 10240 }), 2)
  assert.equal(poolSize({ sandbox: true, setting: 3, freeMemoryMb: 27000, perBuildMemoryMb: 4096 }), 3)
  assert.equal(poolSize({ sandbox: true, setting: 'x' }), 3)
  assert.equal(poolSize({ sandbox: true, setting: 12 }), 8)
  assert.equal(poolSize({ sandbox: true, setting: 3, freeMemoryMb: 1000, perBuildMemoryMb: 4096 }), 1)
})

test('groupInOrder groups by key and keeps order', () => {
  const results = ['a', 'b', 'c', 'd', 'e']
  const m = groupInOrder(results, i => (i % 2 === 0 ? 'even' : 'odd'))
  assert.ok(m instanceof Map)
  assert.deepEqual(m.get('even'), ['a', 'c', 'e'])
  assert.deepEqual(m.get('odd'), ['b', 'd'])
})
