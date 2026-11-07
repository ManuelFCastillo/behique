// Find the first commit where a proven native difference appears, with Behique's existing commit search (../bisect.mjs).
//   node --test src/release/native/bisect.test.mjs
// The search is the same one web checks use (skip-safe binary search, then the parent and the first bad commit each
// verified `runs` times). Only the test of one commit is native: build it, run the finding's case once on a fresh folder,
// and read the one fact the finding is about:
//   good  the fact has the good version's value
//   bad   the fact has the candidate's value (the difference showing on this commit)
//   skip  the build failed, the program could not start, or the fact has some third value: that says nothing about
//         this difference, so the search tries a neighbouring commit instead of guessing.
import { join } from 'node:path'
import { bisect } from '../bisect.mjs'
import { factsOf } from './facts.mjs'
import { runCase } from './run.mjs'
import { prepareVersion } from './versions.mjs'

/** Pure: classify one commit from the fact it produced. */
export function classifyNative(value, finding) {
  if (value === (finding.good ?? null)) return { verdict: 'good' }
  if (value === (finding.cand ?? null)) return { verdict: 'bad' }
  return { verdict: 'skip', why: `a different value: ${String(value).slice(0, 60)}` }
}

/** Test one commit for one finding. */
export async function testCommit(profile, finding, ref, { workRoot, runRoot, log = () => {} }) {
  const kase = profile.cases.find(c => c.id === finding.case)
  let v
  try { v = await prepareVersion(profile, ref, { workRoot, log }) } catch (e) { return { verdict: 'skip', why: `checkout failed: ${String(e.message).split('\n')[0].slice(0, 80)}` } }
  if (!v.ok) return { verdict: 'skip', why: 'build failed' }
  const r = await runCase(profile, kase, { src: v.src, build: v.build, runDir: join(runRoot, v.sha.slice(0, 12), `t${Date.now()}`) })
  if (r.spawnError) return { verdict: 'skip', why: 'the program could not start' }
  const value = factsOf(r, kase, profile).facts[finding.key] ?? null
  return classifyNative(value, finding)
}

/** Search good..cand for the first commit where `finding` appears. Returns the web bisect's result object. */
export function nativeBisect(profile, finding, { goodRef, candRef, workRoot, runs = 3, log = () => {}, onEvent = () => {} }) {
  const runRoot = join(workRoot, 'bisect-runs')
  return bisect({
    adapter: { repo: profile.repo, workRoot },
    goodRef, badRef: candRef, runs, log, onEvent,
    test: ({ ref }) => testCommit(profile, finding, ref, { workRoot, runRoot, log }),
  })
}
