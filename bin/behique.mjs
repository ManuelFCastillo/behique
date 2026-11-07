#!/usr/bin/env node
// behique: the command.
//   behique check <app> <good> <cand> [--bisect [--explain]] [--ai | --ai-tests --ai-flows --ai-describe --ai-triage --ai-canvas] [--ai-budget 0.25] [--max-findings 5] [--recrawl] [--profile file.json --repo path] [--out file] [--json]
//   behique ai <caseId> [--ai ...] [--ai-budget 0.25]   (run the AI stages on a saved case)
//   behique comment --result out/check/<case>.json --repo owner/name --pr 12 [--dry-run]
//   behique help
// `check` runs the same pipeline as the dashboard (crawl the good version, compare, prove each change with a test, optional
// bisect), then prints the result as Markdown, writes it as JSON and Markdown next to the evidence, and exits 0 for SHIP,
// 1 for HOLD, 2 for REVIEW, 3 when the evidence is incomplete. `--explain` (with --bisect) makes one paid model call about the first bad
// change and adds the answer, labelled a guess, to the result; it never changes the verdict or the exit code. The --ai flags run the
// optional AI stages (src/release/cli/ai-stages.mjs) AFTER the verdict is computed, under one cost cap (--ai-budget, default US$0.25),
// and add their output, labelled AI guesses, to the result and the comment; the recommendation and exit code are taken before they run. `comment` posts a result on a pull request through `gh`.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCase } from '../src/release/evidence.mjs'
import { buildViewModel } from '../src/release/viewmodel.mjs'
import { normalizeProfile, saveProfile, validateProfile } from '../src/release/onboard/profile.mjs'
import { aiSection, caseIdFrom, markdownOf, parseCheckArgs, resultOf } from '../src/release/cli/result.mjs'
import { commentBody, postComment } from '../src/release/cli/comment.mjs'
import { explainCase } from '../src/release/cli/explain.mjs'
import { runAiStages, selectedStages, verdictFingerprint } from '../src/release/cli/ai-stages.mjs'
import { isCommandProfile, runNativeCheck } from '../src/release/native/cli.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, ...rest] = process.argv.slice(2)
const USAGE = `usage:
  behique check <app> <good> <cand> [--bisect [--explain]] [--ai | --ai-tests --ai-flows --ai-describe --ai-triage --ai-canvas] [--ai-budget 0.25] [--max-findings 5] [--recrawl] [--profile file.json --repo path] [--out file] [--json] [--timeout-min 45] [--dashboard http://127.0.0.1:8790 | --no-dashboard]
  behique ai <caseId> [--explain] [--full] [--ai | --ai-tests --ai-flows --ai-describe --ai-triage --ai-canvas] [--ai-budget 0.25] [--json]   (run the AI stages on a saved case; prints the "AI guesses" section only)
  behique comment --result out/check/<case>.json --repo owner/name --pr 12 [--dry-run]
--explain: after the search names a first bad change, ask Meta's Muse Spark once why (about a cent). It sends the observed difference and that one commit's message and diff to Meta, needs META_API_KEY, and is recorded as a guess.
--ai: also run the four optional AI stages after the verdict (tests a model wrote, click paths it proposed, a description of the pictures, a ranking of unproven differences); each is skipped if its module is not in this build. --ai-tests, --ai-flows, --ai-describe, --ai-triage pick one. --ai-canvas (not part of --ai): for a canvas app such as Music Blocks, one screenshot of a PUBLIC app goes to the model, which lists the controls; code clicks them on both versions. --ai-budget caps the total AI spend in US dollars (default 0.25, counting --explain). Everything a model writes is labelled an AI guess, shows its cost, and never changes the verdict or the exit code.
exit codes for check: 0 SHIP (nothing a person would notice changed), 1 HOLD (a proven change a person would notice), 2 REVIEW (changes seen, not proven), 3 evidence incomplete`

const fail = (msg, code = 2) => { console.error(msg); process.exit(code) }

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); process.exit(cmd ? 0 : 2) }
if (cmd === 'check') await check(rest)
else if (cmd === 'ai') await aiOnCase(rest)
else if (cmd === 'comment') await comment(rest)
else fail(`unknown command "${String(cmd).slice(0, 20)}"\n${USAGE}`)

async function check(argv) {
  const p = parseCheckArgs(argv)
  if (!p.ok) fail(p.error)
  const { app, good, cand, options } = p
  const env = {}
  if (options.profile) { // a command profile (a native program, not a web app) runs the native check instead
    let raw
    try { raw = JSON.parse(readFileSync(resolve(options.profile), 'utf8')) } catch (e) { fail(`could not read the profile: ${String(e.message).slice(0, 200)}`) }
    if (isCommandProfile(raw)) return nativeCheck(raw, app, good, cand, options)
  }
  if (options.profile) { // a profile file from the repository under test, pointed at that checkout, saved where only this run looks
    let profile
    try { profile = normalizeProfile(JSON.parse(readFileSync(resolve(options.profile), 'utf8'))) } catch (e) { fail(`could not read the profile: ${String(e.message).slice(0, 200)}`) }
    const repo = resolve(options.repo)
    if (!existsSync(join(repo, '.git'))) fail(`--repo must be a git checkout: ${repo} has no .git`)
    profile = { ...profile, name: app, repo, workRoot: join(ROOT, 'out', 'work') }
    const problems = validateProfile(profile)
    if (problems.length) fail(`the profile is not valid: ${problems.join('; ')}`)
    const dir = join(ROOT, 'out', 'profiles')
    saveProfile(profile, dir)
    env.BEHIQUE_PROFILE_DIR = dir
    process.env.BEHIQUE_PROFILE_DIR = dir // the explanation step reads the profile too, in this process
  }
  const argvCheck = ['src/release/check-app.mjs', app, good, cand, '--max-findings', String(options.maxFindings), ...(options.bisect ? ['--bisect'] : []), ...(options.recrawl ? ['--recrawl'] : [])]
  const lines = []
  // the check's own lines are passed through as they come, so a CI log shows progress
  const r = await runStreaming(argvCheck, env, options.timeoutMin * 60_000, lines)
  const caseId = caseIdFrom(lines)
  if (!caseId) fail(`the check ended (exit ${r.code}${r.timedOut ? ', timed out' : ''}) without an evidence case; see the lines above`, 3)
  const evidenceCase = openCase(join(ROOT, 'out', 'evidence', caseId))
  let explainNote = null
  if (options.explain) {
    if (!buildViewModel(evidenceCase, { caseId }).bisect?.commit) explainNote = 'no first bad change was found, so there is nothing to explain'
    else { const e = await explainCase(evidenceCase, { log: l => console.log(l) }); if (!e.ok) explainNote = e.reason }
    if (explainNote) console.log(`explain: skipped (${explainNote}); the verdict is unaffected`)
  }
  const vm = buildViewModel(evidenceCase, { caseId })
  let result = { ...resultOf(vm, { caseId, dashboard: options.dashboard }), ...(explainNote ? { explanationSkipped: explainNote } : {}) }
  const stages = selectedStages(options)
  if (stages.length && !['ship', 'hold', 'inconclusive'].includes(result.recommendation)) console.log(`ai: skipped (the check ended without finished evidence: ${result.word}), nothing was sent to a model`)
  else if (stages.length) {
    // the verdict and exit code are already in `result`; the stages only add a separate, labelled section
    const fingerprint = verdictFingerprint(result)
    const ai = await runAiStages({ caseDir: join(ROOT, 'out', 'evidence', caseId), stages, budgetUsd: options.aiBudget, spentBeforeUsd: result.explanation?.estUsd ?? 0, context: { app, good, cand, prepare: prepareStage(app, good) }, log: l => console.log(l) })
    result = { ...result, ai }
    for (const s of ai.stages) console.log(`ai: ${s.id}: ${s.status}${s.reason ? ` (${s.reason})` : ''}${s.status === 'ran' ? `, ${s.items.length} item${s.items.length === 1 ? '' : 's'}, about $${s.spentUsd.toFixed(4)}` : ''}`)
    console.log(`ai: total about $${ai.totalUsd.toFixed(4)} of a $${options.aiBudget.toFixed(2)} budget; the verdict is unaffected`)
    const again = resultOf(buildViewModel(openCase(join(ROOT, 'out', 'evidence', caseId)), { caseId }), { caseId, dashboard: options.dashboard })
    if (verdictFingerprint(again) !== fingerprint) console.log('ai: WARNING the case reads differently after the AI stages; the result above keeps the verdict computed before them')
  }
  const outBase = options.out ? resolve(options.out).replace(/\.(json|md)$/, '') : join(ROOT, 'out', 'check', caseId)
  mkdirSync(dirname(outBase), { recursive: true })
  writeFileSync(outBase + '.json', JSON.stringify(result, null, 2) + '\n')
  writeFileSync(outBase + '.md', markdownOf(result))
  console.log('\n' + (options.json ? JSON.stringify(result, null, 2) : markdownOf(result)))
  console.log(`result: ${outBase}.json`)
  process.exit(result.exitCode)
}

/** `behique check` with a command profile: a native program built from two refs of --repo, with --bisect to find the first bad commit. No model is called. */
async function nativeCheck(profile, app, good, cand, options) {
  const unsupported = [['explain', '--explain'], ['ai', '--ai'], ['aiTests', '--ai-tests'], ['aiFlows', '--ai-flows'], ['aiDescribe', '--ai-describe'], ['aiTriage', '--ai-triage'], ['aiCanvas', '--ai-canvas'], ['recrawl', '--recrawl']]
    .filter(([k]) => options[k]).map(([, f]) => f)
  if (unsupported.length) fail(`${unsupported.join(', ')} ${unsupported.length > 1 ? 'are' : 'is'} not available for command profiles yet.`)
  const repo = resolve(options.repo)
  if (!existsSync(join(repo, '.git'))) fail(`--repo must be a git checkout: ${repo} has no .git`)
  let run
  try {
    run = await runNativeCheck({ ...profile, name: app, repo }, good, cand, { outRoot: join(ROOT, 'out'), maxFindings: options.maxFindings, bisect: options.bisect, log: l => console.log(l) })
  } catch (e) { fail(String(e.message).slice(0, 2000), 3) }
  if (options.out) writeFileSync(resolve(options.out), JSON.stringify(run.result, null, 2))
  console.log('\n' + (options.json ? JSON.stringify(run.result, null, 2) : run.markdown))
  console.log(`evidence: ${run.caseDir}`)
  process.exit(run.exitCode)
}

/** `behique ai <caseId> --ai ...`: the AI stages on a case that is already saved. The case's verdict is read, never recomputed or changed. */
async function aiOnCase(argv) {
  const id = argv.find(a => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a))
  if (!id || !/^[0-9TZ]{16}_[A-Za-z0-9._\-/]+$/.test(id) || id.includes('..')) fail('usage: behique ai <caseId> [--explain] [--full] [--ai | --ai-tests --ai-flows --ai-describe --ai-triage --ai-canvas] [--ai-budget 0.25] [--json]')
  const full = argv.includes('--full'), explain = argv.includes('--explain')
  const p = parseCheckArgs(['x', 'a', 'b', '--bisect', ...argv.filter(a => a !== id && a !== '--full')])
  if (!p.ok) fail(p.error)
  const stages = selectedStages(p.options)
  if (!stages.length && !explain) fail('pick at least one of --explain, --ai, --ai-tests, --ai-flows, --ai-describe, --ai-triage, --ai-canvas')
  const dir = join(ROOT, 'out', 'evidence', id)
  if (!existsSync(join(dir, 'events.ndjson'))) fail(`no such case: ${id}`)
  const c = openCase(dir)
  const opened = c.read().find(e => e.type === 'case.opened')?.data ?? {}
  const app = opened.app ?? String(opened.adapter ?? '').replace(/^visual-/, '')
  const before = resultOf(buildViewModel(c, { caseId: id }), { caseId: id, dashboard: null })
  if (!['ship', 'hold', 'inconclusive'].includes(before.recommendation)) fail(`that case has no finished verdict (${before.word}), so nothing was sent to a model`, 3)
  let explainNote = null
  if (explain) { // the same guarded single call as `check --explain`, on the saved case
    if (!before.culprit) explainNote = 'no first bad change was found, so there is nothing to explain'
    else { const e = await explainCase(c, { log: l => console.log(l) }); if (!e.ok) explainNote = e.reason }
    if (explainNote) console.log(`explain: skipped (${explainNote}); the verdict is unaffected`)
  }
  const withGuess = { ...resultOf(buildViewModel(openCase(dir), { caseId: id }), { caseId: id, dashboard: null }), ...(explainNote ? { explanationSkipped: explainNote } : {}) }
  const ai = await runAiStages({ caseDir: dir, stages, budgetUsd: p.options.aiBudget, spentBeforeUsd: withGuess.explanation?.estUsd ?? 0, context: { app, good: opened.goodRef, cand: opened.candRef, prepare: prepareStage(app, opened.goodRef) }, log: l => console.log(l) })
  const after = resultOf(buildViewModel(openCase(dir), { caseId: id }), { caseId: id, dashboard: null })
  console.log(`verdict ${before.word}, exit code ${before.exitCode}: ${verdictFingerprint(after) === verdictFingerprint(before) ? 'unchanged by the AI stages' : 'WARNING: reads differently after the stages'}`)
  if (full) { console.log('\n' + markdownOf({ ...withGuess, ai })); return }
  console.log('\n' + (p.options.json ? JSON.stringify(ai, null, 2) : aiSection({ ...withGuess, ai }).join('\n\n')))
}

/** What an AI stage needs from the app: its adapter (tests), or the good version running read-only (click paths). Resolved only when the stage runs. */
function prepareStage(app, good) {
  return async stage => {
    if (stage.id !== 'tests' && stage.id !== 'flows') return null
    const { resolveApp } = await import('../src/release/crawl/cli.mjs')
    const resolved = await resolveApp(app)
    const { needsSandbox, SANDBOX_REQUIRED } = await import('../src/release/ui/settings.mjs')
    if (resolved.kind === 'profile' && needsSandbox(resolved.adapter?.profile) && !process.env.BEHIQUE_SANDBOX) throw new Error(SANDBOX_REQUIRED) // the same rule as the dashboard: a repo's own code never runs on this machine unsandboxed
    if (stage.id === 'tests') return { extra: { adapter: resolved.adapter } }
    const { startBuild } = await import('../src/release/build.mjs')
    const { startPathOf } = await import('../src/release/crawl/reuse.mjs')
    const b = await startBuild({ adapter: resolved.adapter, ref: good, port: 8321 })
    return { extra: { base: b.base, startPath: startPathOf(resolved), readOnly: true }, stop: () => b.stop() }
  }
}

/** Run check-app as a child, printing and collecting its lines as they arrive; SIGTERM then SIGKILL on timeout. */
function runStreaming(argvCheck, env, timeoutMs, lines) {
  return new Promise(resolveP => {
    const child = spawn('node', argvCheck, { cwd: ROOT, env: { ...process.env, ...env } })
    const rest = { out: '', err: '' }
    let timedOut = false
    const take = key => d => { rest[key] += String(d); const parts = rest[key].split('\n'); rest[key] = parts.pop(); for (const l of parts) { lines.push(l); console.log(l) } }
    child.stdout.on('data', take('out')); child.stderr.on('data', take('err'))
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10_000).unref() }, timeoutMs)
    process.on('SIGTERM', () => child.kill('SIGTERM')); process.on('SIGINT', () => child.kill('SIGTERM'))
    child.on('close', code => { clearTimeout(timer); for (const k of ['out', 'err']) if (rest[k]) { lines.push(rest[k]); console.log(rest[k]) } resolveP({ code: code ?? 1, timedOut }) })
  })
}

async function comment(argv) {
  const opt = (n, d) => (argv.includes('--' + n) ? argv[argv.indexOf('--' + n) + 1] : d)
  const file = opt('result'), repo = opt('repo'), pr = Number(opt('pr')), dry = argv.includes('--dry-run')
  if (!file || !repo || !pr) fail('usage: behique comment --result out/check/<case>.json --repo owner/name --pr 12 [--dry-run]')
  let result
  try { result = JSON.parse(readFileSync(resolve(file), 'utf8')) } catch (e) { fail(`could not read the result: ${String(e.message).slice(0, 200)}`) }
  if (dry) { console.log(commentBody(result)); console.log(`(dry run: nothing was posted to ${repo} pull request ${pr})`); return }
  const run = args => new Promise(resolveP => execFile('gh', args, { timeout: 60_000, maxBuffer: 20e6, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => resolveP({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })))
  const writeBody = text => { const dir = join(ROOT, 'out', 'check'); mkdirSync(dir, { recursive: true }); const path = join(dir, `comment-${pr}.md`); writeFileSync(path, text); return path }
  const res = await postComment({ repo, pr, result, run, writeBody })
  if (!res.ok) fail(res.error, 3)
  console.log(`comment ${res.action} on ${repo} pull request ${pr}${res.id ? ` (id ${res.id})` : ''}`)
}
