// Muse builder: give a spec (markdown, see spec.mjs) to Muse Spark through the Meta API and let it write the files the spec owns.
//   node tools/muse-build/build.mjs docs/specs/musicblocks/01-profile-and-runner.md [--dry-run] [--max-cost 0.75] [--rounds 3]
//                                   [--reasoning low] [--model meta|baseten] [--run-only] [--repair] [--force]
// --run-only: after a person has read the files, run the acceptance command again (no model call).
// --repair: like --run-only, but if the tests fail, send the failure back to the model and continue with the normal rounds.
// What it does: sends the spec and the context files it lists (never .env), writes ONLY the files in `owns`, scans them for risky
// patterns the spec did not allow, runs the spec's acceptance command, and on failure sends the output back for another round.
// The standard Muse Spark model is used (provider `meta`), not a contributor variant. Every call is cost-counted and capped.
// Nothing generated is trusted: a person reads the files, and `--run-only` runs the tests again after that review.
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parseFiles, parseSpec, scan, validateSpec } from './spec.mjs'

const run = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const MAX_CONTEXT_CHARS = 150_000

const SYSTEM = [
  'You are a careful senior engineer building one part of an existing Node.js codebase from a written spec.',
  'Reply with file blocks and nothing else, in exactly this format, once per file:',
  '=== FILE: <relative path> ===',
  '<the complete file content>',
  '=== END FILE ===',
  'Write complete files, never fragments. Write only the files the spec says you own. Follow the conventions in the spec and the style of the context files.',
  'Never use the long dash character (U+2014). Do not add explanations, summaries or code fences around the file blocks.',
].join('\n')

/** The messages for one round. `previous` is { files, output } after a failed round. */
export function buildMessages(spec, contextFiles, previous = null) {
  const ctx = contextFiles.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n')
  const task = [
    `# Spec: ${spec.part}`, '', spec.body, '',
    `You own exactly these files (write all of them): ${spec.owns.join(', ')}`,
    `The acceptance command is: ${spec.test}`, '',
    '# Context files (read-only, already in the repository)', '', ctx,
  ].join('\n')
  if (!previous) return [{ role: 'system', content: SYSTEM }, { role: 'user', content: task }]
  const mine = previous.files.map(f => `=== FILE: ${f.path} ===\n${f.content}=== END FILE ===`).join('\n')
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: task },
    { role: 'user', content: `Your previous attempt wrote these files:\n${mine}\n\nRunning \`${spec.test}\` gave this output (the end of it):\n${previous.output}\n\nFix the problem. Reply with the complete content of every file you change, in the same format. Only change a test if the test itself is wrong, and say nothing else.` }]
}

const defaultAsk = (model, reasoning) => async messages => {
  const { chat } = await import('../../src/llm.mjs')
  return chat(model, messages, { maxTokens: 24000, reasoning })
}

/** Run the acceptance command with a minimal environment: generated code never sees API keys. */
export function runTest(command, { root = ROOT, timeoutMs = 600_000 } = {}) {
  const [, ...args] = command.split(/\s+/)
  return new Promise(resolve => {
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
    const p = spawn(process.execPath, args, { cwd: root, env })
    let out = ''
    const take = d => { out += String(d); if (out.length > 400_000) out = out.slice(-200_000) }
    p.stdout.on('data', take); p.stderr.on('data', take)
    const timer = setTimeout(() => { p.kill(); out += '\n(timed out)' }, timeoutMs)
    p.on('close', code => { clearTimeout(timer); resolve({ code, output: out }) })
    p.on('error', e => { clearTimeout(timer); resolve({ code: 1, output: String(e.message) }) })
  })
}

async function modified(root, path) { // a tracked file with uncommitted changes is never overwritten without --force
  try { return Boolean((await run('git', ['-C', root, 'status', '--porcelain', '--', path])).stdout.match(/^( M|M |MM)/)) } catch { return false }
}

export async function runBuild(opts, deps = {}) {
  const { specPath, model = 'meta', reasoning = 'low', rounds = 3, maxCost = 0.75, dryRun = false, runOnlyFlag = false, repair = false, force = false, root = ROOT } = opts
  const lines = [], say = l => lines.push(l)
  const spec = parseSpec(readFileSync(join(root, specPath), 'utf8'))
  const bad = validateSpec(spec)
  if (bad.length) return { code: 2, lines: ['spec problems:', ...bad.map(b => '  ' + b)] }
  const context = spec.context.map(p => ({ path: p, content: existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null }))
  const missing = context.filter(c => c.content === null).map(c => c.path)
  if (missing.length) return { code: 2, lines: ['context files not found: ' + missing.join(', ')] }
  const size = context.reduce((n, c) => n + c.content.length, 0)
  if (size > MAX_CONTEXT_CHARS) return { code: 2, lines: [`context is ${size} characters, over the ${MAX_CONTEXT_CHARS} limit: list fewer files`] }
  const { estCost, PROVIDERS } = deps.llm ?? await import('../../src/llm.mjs')
  const first = buildMessages(spec, context)
  const promptChars = first.reduce((n, m) => n + m.content.length, 0)
  const projection = estCost(Math.round(promptChars / 3.5), 9000)
  say(`part ${spec.part}: ${spec.owns.length} files to write, ${context.length} context files (${size} characters), model ${PROVIDERS[model]?.model ?? model}`)
  say(`projection for one round: about ${Math.round(promptChars / 3.5)} tokens in, up to 9,000 out, about $${projection.toFixed(3)}; cap $${maxCost}, up to ${rounds} rounds`)
  if (dryRun) { say('dry run: nothing was sent'); return { code: 0, lines } }

  const ask = deps.ask ?? defaultAsk(model, reasoning)
  const test = deps.runTest ?? (c => runTest(c, { root }))
  const report = { part: spec.part, model: PROVIDERS[model]?.model ?? model, reasoning, rounds: [], costUsd: 0, passed: false }
  let previous = null, cost = 0
  const finish = (code, status) => {
    report.passed = status === 'passed'; report.status = status; report.costUsd = +cost.toFixed(4)
    const dir = join(root, 'out/muse-build'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${spec.part}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`), JSON.stringify(report, null, 1))
    say(`${status}; model cost about $${cost.toFixed(3)}`)
    return { code, lines, report }
  }

  if (runOnlyFlag) { // after a person has read the files: run the acceptance command again, no model call
    const t = await test(spec.test)
    say(`acceptance: ${t.code === 0 ? 'PASSED' : 'FAILED'}`); if (t.code !== 0) say(t.output.slice(-3000))
    report.rounds.push({ runOnly: true, test: { code: t.code } })
    if (t.code === 0 || !repair) return finish(t.code === 0 ? 0 : 1, t.code === 0 ? 'passed' : 'tests failed')
    // --repair: hand the reviewed files and the failure back to the model, then carry on with the normal rounds
    previous = { files: spec.owns.filter(p => existsSync(join(root, p))).map(p => ({ path: p, content: readFileSync(join(root, p), 'utf8') })), output: t.output.slice(-8000) }
  }

  for (let round = 1; round <= rounds; round++) {
    if (cost + projection > maxCost) { say(`stopping before round ${round}: it could take the cost past the cap`); return finish(1, 'cost cap') }
    const messages = buildMessages(spec, context, previous)
    const r = await ask(messages)
    cost += estCost(r.pt ?? 0, r.ct ?? 0)
    const files = parseFiles(r.text)
    const entry = { round, pt: r.pt, ct: r.ct, finish: r.finish ?? null, written: [], rejected: [], flagged: [], test: null }
    report.rounds.push(entry)
    if (!files.length) { say(`round ${round}: the answer had no file blocks (finish: ${r.finish ?? 'unknown'})`); previous = { files: previous?.files ?? [], output: 'Your answer had no file blocks. Use the exact format.' }; continue }
    const ok = []
    for (const f of files) {
      if (!spec.owns.includes(f.path)) { entry.rejected.push({ path: f.path, why: 'not an owned file' }); continue }
      if (!force && existsSync(join(root, f.path)) && await modified(root, f.path)) { entry.rejected.push({ path: f.path, why: 'has uncommitted changes (use --force)' }); continue }
      mkdirSync(dirname(join(root, f.path)), { recursive: true }); writeFileSync(join(root, f.path), f.content); ok.push(f); entry.written.push(f.path)
    }
    say(`round ${round}: wrote ${entry.written.length} files${entry.rejected.length ? `, rejected ${entry.rejected.map(x => `${x.path} (${x.why})`).join(', ')}` : ''}; ${r.ct} tokens out`)
    entry.flagged = scan(ok, spec.allow)
    if (entry.flagged.length) {
      say(`the scan flagged patterns this spec does not allow: ${entry.flagged.map(f => `${f.path} (${f.pattern})`).join(', ')}`)
      say('NOT running the tests. Read the files, then run again with --run-only if they are fine.')
      return finish(1, 'needs review')
    }
    const missingOwned = spec.owns.filter(p => !existsSync(join(root, p)))
    if (missingOwned.length) { previous = { files: ok, output: `These owned files do not exist yet: ${missingOwned.join(', ')}. Write them all.` }; say(`round ${round}: missing ${missingOwned.join(', ')}`); entry.test = { code: null, note: 'files missing' }; continue }
    const t = await test(spec.test)
    entry.test = { code: t.code, tail: t.output.slice(-1500) }
    say(`round ${round}: acceptance ${t.code === 0 ? 'PASSED' : 'FAILED'}`)
    if (t.code === 0) return finish(0, 'passed')
    previous = { files: spec.owns.filter(p => existsSync(join(root, p))).map(p => ({ path: p, content: readFileSync(join(root, p), 'utf8') })), output: t.output.slice(-8000) }
  }
  return finish(1, 'tests failed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d)
  const specPath = args.find(a => !a.startsWith('--') && !['--model', '--max-cost', '--rounds', '--reasoning'].includes(args[args.indexOf(a) - 1]))
  if (!specPath) { console.error('usage: node tools/muse-build/build.mjs <spec.md> [--dry-run] [--max-cost 0.75] [--rounds 3] [--reasoning low] [--model meta|baseten] [--run-only] [--repair] [--force]'); process.exit(2) }
  const r = await runBuild({ specPath, model: opt('model', 'meta'), reasoning: opt('reasoning', 'low'), rounds: +opt('rounds', 3), maxCost: +opt('max-cost', 0.75), dryRun: args.includes('--dry-run'), runOnlyFlag: args.includes('--run-only') || args.includes('--repair'), repair: args.includes('--repair'), force: args.includes('--force') })
  r.lines.forEach(l => console.log(l))
  process.exit(r.code)
}
