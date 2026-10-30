// Measure what the CURRENT set-up does on real public web repos: where it works, where it breaks and why.
//   node bench/onboard-bench.mjs propose [name ...]          ask the model for a profile (about $0.01 each), save it to out/onboard-bench/<name>.proposed.json
//   node bench/onboard-bench.mjs verify  [name ...] [--ignore-scripts]   verify the saved proposals (builds both versions, takes pictures); a person must have read the commands first
//   node bench/onboard-bench.mjs repair  [name ...]          the repair loop from the saved proposal: verify, on failure send the app's last output back (up to 3 rounds, $0.30 cap each); changed commands are approved only within src/release/onboard/approve.mjs, anything else stops
//   node bench/onboard-bench.mjs report                      print the table of results so far
// Nothing is saved to the real profiles folder. Repos are clones in ~/dev/behique-apps (public repos only: set-up text goes to a model).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectRepo } from '../src/release/onboard/inspect.mjs'
import { buildMessages, proposeProfile, projectCost } from '../src/release/onboard/propose.mjs'
import { defaultAsk, defaultSkillText } from '../src/release/onboard/onboard.mjs'
import { describeCommands, validateProfile } from '../src/release/onboard/profile.mjs'
import { verifyProfile } from '../src/release/onboard/verify.mjs'
import { repairProfile } from '../src/release/onboard/repair.mjs'
import { parseProfile } from '../src/release/onboard/propose.mjs'
import { scopedApprove } from '../src/release/onboard/approve.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'out', 'onboard-bench')
const APPS = join(homedir(), 'dev', 'behique-apps')
const CASES = JSON.parse(readFileSync(join(ROOT, 'bench', 'onboard-bench.json'), 'utf8'))
const RESULTS = join(OUT, 'results.json')
const [cmd, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter(a => a.startsWith('--')))
const names = rest.filter(a => !a.startsWith('--'))
const chosen = CASES.filter(c => !names.length || names.includes(c.name))
mkdirSync(OUT, { recursive: true })
const load = () => (existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {})
const save = r => writeFileSync(RESULTS, JSON.stringify(r, null, 2))
const price = u => (u.pt ?? 0) * 1.25e-6 + (u.ct ?? 0) * 4.25e-6

if (cmd === 'propose') {
  const results = load(), skillText = defaultSkillText()
  for (const c of chosen) {
    const path = join(APPS, c.repo)
    const { proposeError, problems, commands, validation, ...kept } = results[c.name] ?? {} // a new proposal starts clean: nothing from the last one may linger
    const entry = results[c.name] = { ...kept, name: c.name, good: c.good, cand: c.cand, note: c.note }
    try {
      const facts = await inspectRepo(path)
      const projected = projectCost(buildMessages(facts, skillText, { good: c.good, cand: c.cand }))
      if (projected > 0.05) throw new Error(`projected cost $${projected.toFixed(3)} is above the bench limit of $0.05`)
      const res = await proposeProfile({ facts, skillText, ask: defaultAsk, good: c.good, cand: c.cand })
      entry.proposeUsd = +price(res.usage).toFixed(4); entry.problems = res.problems
      if (res.profile) {
        const profile = { ...res.profile, name: c.name }
        writeFileSync(join(OUT, `${c.name}.proposed.json`), JSON.stringify(profile, null, 2) + '\n')
        entry.commands = describeCommands(profile); entry.validation = validateProfile(profile)
      } else entry.proposeError = (res.problems ?? []).join('; ') || 'no profile'
    } catch (e) { entry.proposeError = String(e.message).split('\n')[0] }
    console.log(`${c.name}: $${entry.proposeUsd ?? 0} ${entry.proposeError ? 'ERROR ' + entry.proposeError : 'commands: ' + (entry.commands ?? []).join(' | ')}`)
    save(results)
  }
} else if (cmd === 'verify') {
  const results = load()
  for (const c of chosen) {
    const file = join(OUT, `${c.name}.proposed.json`)
    if (!existsSync(file)) { console.log(`${c.name}: no proposal`); continue }
    const profile = JSON.parse(readFileSync(file, 'utf8'))
    if (flags.has('--ignore-scripts')) for (const s of profile.serve?.install ?? []) if (['npm', 'pnpm', 'yarn'].includes(s.cmd) && !(s.args ?? []).includes('--ignore-scripts')) s.args = [...(s.args ?? []), '--ignore-scripts'] // the person approving adds this
    const t0 = Date.now(), lines = []
    let rep
    try { rep = await verifyProfile(profile, { good: c.good, cand: c.cand, ports: [8301, 8302], log: l => { lines.push(l); console.log(`  ${l}`) } }) } catch (e) { rep = { ok: false, checks: [{ name: 'verify', ok: false, detail: String(e.message).split('\n')[0] }] } }
    const entry = results[c.name] ?? { name: c.name }
    entry.verify = { ok: rep.ok, seconds: +((Date.now() - t0) / 1000).toFixed(0), checks: rep.checks, ignoreScripts: flags.has('--ignore-scripts') }
    results[c.name] = entry; save(results)
    console.log(`${c.name}: ${rep.ok ? 'VERIFIED' : 'FAILED'} in ${entry.verify.seconds}s ${rep.ok ? '' : '| ' + rep.checks.filter(k => !k.ok).map(k => `${k.name}: ${k.detail}`).join(' | ').slice(0, 400)}`)
  }
} else if (cmd === 'repair') {
  const results = load(), skillText = defaultSkillText()
  for (const c of chosen) {
    const file = join(OUT, `${c.name}.proposed.json`)
    if (!existsSync(file)) { console.log(`${c.name}: no proposal`); continue }
    const initial = JSON.parse(readFileSync(file, 'utf8'))
    const facts = await inspectRepo(join(APPS, c.repo))
    const approved = new Set() // lines a person approved: the first profile (read before running), then only what approve.mjs allows
    const t0 = Date.now()
    console.log(`\n== ${c.name}`)
    const out = await repairProfile({
      facts, skillText, good: c.good, cand: c.cand, initial, name: c.name, maxRounds: 3, maxUsd: 0.30,
      ask: defaultAsk, parse: parseProfile, validate: validateProfile, describe: describeCommands,
      verify: async profile => {
        try { return await verifyProfile(profile, { good: c.good, cand: c.cand, ports: [8301, 8302], log: l => console.log(`  ${l}`) }) }
        catch (e) { return { ok: false, checks: [{ name: 'verify', ok: false, detail: String(e.message).split('\n')[0] }] } }
      },
      approve: ({ commands, added, round }) => {
        if (round === 1) { for (const l of added) approved.add(l); console.log(`  round 1: the proposal as read by a person`); return true }
        const r = scopedApprove({ added, approvedLines: [...approved] })
        for (const x of r.reasons) console.log(`  approved: ${x}`)
        for (const x of r.refused) console.log(`  NOT approved: ${x}`)
        if (r.ok) for (const l of added) approved.add(l)
        return r.ok
      },
    })
    for (const r of out.rounds) console.log(`  round ${r.n}: ${r.report?.ok ? 'VERIFIED' : 'failed'} | ${(r.report?.checks ?? []).filter(k => !k.ok).map(k => `${k.name}: ${String(k.detail).slice(0, 140)}`).join(' | ')} | changed: ${(r.added ?? []).join(' ; ') || 'nothing'}`)
    console.log(`${c.name}: ${out.ok ? 'REPAIRED/VERIFIED' : 'NOT repaired (' + out.reason + (out.error ? ': ' + out.error : '') + ')'} after ${out.rounds.length} round(s), asked $${Number(out.usd).toFixed(3)}, ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    if (out.profile) writeFileSync(join(OUT, `${c.name}.${out.ok ? 'repaired' : 'lastattempt'}.json`), JSON.stringify(out.profile, null, 2) + '\n')
    const entry = results[c.name] ?? { name: c.name }
    entry.repair = { ok: out.ok, reason: out.reason, rounds: out.rounds.length, usd: +Number(out.usd).toFixed(4), seconds: +((Date.now() - t0) / 1000).toFixed(0), steps: out.rounds.map(r => ({ n: r.n, ok: r.report?.ok === true, added: r.added, failing: (r.report?.checks ?? []).filter(k => !k.ok).map(k => `${k.name}: ${String(k.detail).slice(0, 200)}`) })) }
    results[c.name] = entry; save(results)
  }
} else if (cmd === 'report') {
  for (const e of Object.values(load())) console.log(`${e.name.padEnd(28)} propose $${e.proposeUsd ?? '-'} ${e.proposeError ? 'ERR' : 'ok '} verify ${e.verify ? (e.verify.ok ? 'PASS' : 'FAIL') : '-'} repair ${e.repair ? (e.repair.ok ? 'OK(' + e.repair.rounds + ')' : 'NO(' + e.repair.reason + ')') : '-'}  ${e.verify && !e.verify.ok ? e.verify.checks.filter(k => !k.ok).map(k => k.name).join(', ') : ''}`)
} else console.log('usage: node bench/onboard-bench.mjs propose|verify|repair|report [name ...] [--ignore-scripts]')
