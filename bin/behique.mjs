#!/usr/bin/env node
// behique: the command.
//   behique check <app> <good> <cand> [--bisect [--explain]] [--max-findings 5] [--recrawl] [--profile file.json --repo path] [--out file] [--json]
//   behique comment --result out/check/<case>.json --repo owner/name --pr 12 [--dry-run]
//   behique help
// `check` runs the same pipeline as the dashboard (crawl the good version, compare, prove each change with a test, optional
// bisect), then prints the result as Markdown, writes it as JSON and Markdown next to the evidence, and exits 0 for SHIP,
// 1 for HOLD, 2 for REVIEW, 3 when the evidence is incomplete. `--explain` (with --bisect) makes one paid model call about the first bad
// change and adds the answer, labelled a guess, to the result; it never changes the verdict or the exit code. `comment` posts a result on a pull request through `gh`.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCase } from '../src/release/evidence.mjs'
import { buildViewModel } from '../src/release/viewmodel.mjs'
import { normalizeProfile, saveProfile, validateProfile } from '../src/release/onboard/profile.mjs'
import { caseIdFrom, markdownOf, parseCheckArgs, resultOf } from '../src/release/cli/result.mjs'
import { commentBody, postComment } from '../src/release/cli/comment.mjs'
import { explainCase } from '../src/release/cli/explain.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, ...rest] = process.argv.slice(2)
const USAGE = `usage:
  behique check <app> <good> <cand> [--bisect [--explain]] [--max-findings 5] [--recrawl] [--profile file.json --repo path] [--out file] [--json] [--timeout-min 45] [--dashboard http://127.0.0.1:8790 | --no-dashboard]
  behique comment --result out/check/<case>.json --repo owner/name --pr 12 [--dry-run]
--explain: after the search names a first bad change, ask Meta's Muse Spark once why (about a cent). It sends the observed difference and that one commit's message and diff to Meta, needs META_API_KEY, and is recorded as a guess.
exit codes for check: 0 SHIP (nothing a person would notice changed), 1 HOLD (a proven change a person would notice), 2 REVIEW (changes seen, not proven), 3 evidence incomplete`

const fail = (msg, code = 2) => { console.error(msg); process.exit(code) }

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); process.exit(cmd ? 0 : 2) }
if (cmd === 'check') await check(rest)
else if (cmd === 'comment') await comment(rest)
else fail(`unknown command "${String(cmd).slice(0, 20)}"\n${USAGE}`)

async function check(argv) {
  const p = parseCheckArgs(argv)
  if (!p.ok) fail(p.error)
  const { app, good, cand, options } = p
  const env = {}
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
  const result = { ...resultOf(vm, { caseId, dashboard: options.dashboard }), ...(explainNote ? { explanationSkipped: explainNote } : {}) }
  const outBase = options.out ? resolve(options.out).replace(/\.(json|md)$/, '') : join(ROOT, 'out', 'check', caseId)
  mkdirSync(dirname(outBase), { recursive: true })
  writeFileSync(outBase + '.json', JSON.stringify(result, null, 2) + '\n')
  writeFileSync(outBase + '.md', markdownOf(result))
  console.log('\n' + (options.json ? JSON.stringify(result, null, 2) : markdownOf(result)))
  console.log(`result: ${outBase}.json`)
  process.exit(result.exitCode)
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
