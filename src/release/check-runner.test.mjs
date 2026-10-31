// Run: node --test src/release/check-runner.test.mjs   (tiny local node processes only)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnRunner } from './check-runner.mjs'

describe('spawnRunner', () => {
  const run = spawnRunner({ root: process.cwd() })
  it('collects output lines from both streams and the exit code', async () => {
    const r = await run(['-e', 'console.log("a"); console.error("b"); process.stdout.write("no newline"); process.exitCode = 3'])
    assert.equal(r.code, 3); assert.equal(r.timedOut, false)
    assert.deepEqual([...r.lines].sort(), ['a', 'b', 'no newline'])
  })
  it('passes env and stops a run that takes too long', async () => {
    const e = await run(['-e', 'console.log(process.env.BQ_TEST)'], { env: { BQ_TEST: 'hi' } })
    assert.deepEqual(e.lines, ['hi'])
    const t = await run(['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300 })
    assert.equal(t.timedOut, true)
  })
})
