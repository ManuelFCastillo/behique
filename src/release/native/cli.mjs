// `behique check` for a command profile: build both refs, run the native check, and report it the way a web check is
// reported (same words, same exit codes: 0 SHIP, 1 HOLD, 2 REVIEW, 3 incomplete).
//   node --test src/release/native/cli.test.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT } from '../cli/result.mjs'
import { openCase } from '../evidence.mjs'
import { checkVersions } from './check.mjs'
import { validateCommandProfile } from './profile.mjs'
import { prepareVersion } from './versions.mjs'

const WORD = { ship: 'SHIP', hold: 'HOLD', inconclusive: 'REVIEW', fail: 'INCOMPLETE' }
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const safeRef = r => String(r).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)

/** True when a parsed profile file is a command profile (native mode) rather than a web profile. */
export const isCommandProfile = p => Boolean(p && typeof p === 'object' && p.kind === 'command')

/**
 * Build `good` and `cand` from the profile's repository and check them. Returns
 * { result, markdown, exitCode, caseDir }. Never throws for a failing build: that is an INCOMPLETE result.
 */
export async function runNativeCheck(profile, good, cand, { outRoot, maxFindings = 5, recordRuns = 2, confirmRuns = 3, tol = 0, log = () => {} }) {
  const problems = validateCommandProfile(profile)
  if (problems.length) throw new Error(`the profile is not valid: ${problems.join('; ')}`)
  const workRoot = join(outRoot, 'work', profile.name)
  const versions = {}
  for (const [side, ref] of [['good', good], ['cand', cand]]) versions[side] = await prepareVersion(profile, ref, { workRoot, log })
  const caseId = `${stamp()}_${safeRef(good)}-vs-${safeRef(cand)}`
  const caseDir = join(outRoot, 'native', profile.name, caseId)
  mkdirSync(caseDir, { recursive: true })

  let result
  const broken = ['good', 'cand'].filter(s => !versions[s].ok)
  if (broken.length) {
    const ev = openCase(caseDir)
    ev.event('case.opened', { mode: 'native', app: profile.name, goodRef: good, candRef: cand, goodSha: versions.good.sha, candSha: versions.cand.sha })
    for (const s of broken) {
      const h = ev.artifact(`build-${s}.json`, versions[s].steps, 'application/json')
      ev.claim('verified_fact', `The ${s === 'good' ? 'good version' : 'candidate'} (${versions[s].ref}) did not build.`, { evidence: [h] })
    }
    ev.event('case.closed', { recommendation: 'fail' })
    result = { recommendation: 'fail', findings: [], unsteady: [], diffs: 0, churn: 0, masked: { count: 0, total: 0, byCase: {} }, notStarted: [], buildFailed: broken, caseDir }
  } else {
    result = await checkVersions(profile, versions, { caseDir, workDir: join(workRoot, 'runs', caseId), recordRuns, confirmRuns, maxFindings, tol, log })
  }
  result = { ...result, app: profile.name, good: { ref: good, sha: versions.good.sha, reusedBuild: versions.good.reused }, cand: { ref: cand, sha: versions.cand.sha, reusedBuild: versions.cand.reused }, caseId }
  const markdown = nativeMarkdown(result)
  writeFileSync(join(caseDir, 'result.json'), JSON.stringify(result, null, 1))
  writeFileSync(join(caseDir, 'result.md'), markdown)
  return { result, markdown, exitCode: EXIT[result.recommendation] ?? 3, caseDir }
}

const code = v => (v === null || v === undefined ? '_absent_' : '`' + String(v).replace(/`/g, "'").replace(/\|/g, '\\|').slice(0, 140) + '`')
const cell = s => String(s ?? '').replace(/\|/g, '\\|')

/** The result as Markdown for a person or a pull request. Pure. */
export function nativeMarkdown(r) {
  const lines = [`## Behique: ${WORD[r.recommendation] ?? r.recommendation} for ${r.app} ${r.good.ref} → ${r.cand.ref}`, '']
  lines.push(`Good \`${r.good.sha?.slice(0, 12)}\`, candidate \`${r.cand.sha?.slice(0, 12)}\`. Native mode: each case run in a fresh folder; a difference counts as proven only if its test passed every run on the good version and failed every run on the candidate.`, '')
  if (r.buildFailed?.length) lines.push(`**Incomplete:** ${r.buildFailed.map(s => (s === 'good' ? 'the good version' : 'the candidate')).join(' and ')} did not build. Nothing is recommended.`, '')
  if (r.notStarted?.length) lines.push(`**Incomplete:** case(s) ${r.notStarted.join(', ')} could not start on the good version. Nothing is recommended.`, '')
  if (r.findings.length) {
    lines.push('| Test | Case | What | Good | Candidate | Proof |', '| --- | --- | --- | --- | --- | --- |')
    for (const f of r.findings) {
      const grid = f.grid?.comparable ? ` (${f.grid.changed} of ${f.grid.cells} cells, largest change ${Number(f.grid.maxAbs.toPrecision(4))})` : ''
      // A printed message is named by its own text; its values are how many times it was printed.
      const msg = f.key.startsWith('message:') ? f.key.slice(8) : null
      const what = msg ? `printed ${code(msg)}` : `${cell(f.what)}${grid}`
      const val = v => (msg ? (v === null ? 'not printed' : `printed ${v}×`) : code(v))
      lines.push(`| ${f.id} | ${cell(f.case)} | ${what} | ${val(f.good)} | ${val(f.cand)} | ${f.verdict.replace(/_/g, ' ')}: good passed ${f.goodPassed}/${f.runs}, candidate failed ${f.candFailed}/${f.runs} |`)
    }
    lines.push('')
  } else if (!r.buildFailed?.length && !r.notStarted?.length) lines.push(r.diffs ? 'No difference could be turned into a test.' : 'No differences in the recorded facts.', '')
  if (r.unsteady?.length) {
    lines.push('**Varies between runs** (steady on one version, not on the other; a person has to look):', '')
    for (const u of r.unsteady) lines.push(`- ${cell(u.case)}: ${cell(u.what)} (\`${cell(u.key)}\`)`)
    lines.push('')
  }
  if (r.churn) lines.push(`${r.churn} output file(s) changed bytes with every value equal (formatting only); not counted.`, '')
  lines.push(`Not compared: ${r.masked.count} of ${r.masked.total} recorded facts changed between identical runs of the same version. A change hidden inside one of them is invisible to this check.`, '')
  lines.push(`Evidence: \`${r.caseDir}\` (hash-chained record). A person decides.`)
  return lines.join('\n') + '\n'
}
