// Local demo server: serves demo/index.html and runs the release pipeline on request. No model calls.
//   node demo/server.mjs [port]      then open http://127.0.0.1:8790
// One pipeline job at a time (they share port 8300). Hand-test builds use their own ports (8301, 8302).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBuild } from '../src/release/build.mjs'
import { LABELS, listCases, openCase, summarize, writeError } from '../src/release/evidence.mjs'
import { hypothesize, preview as previewHypothesis } from '../src/release/hypothesis.mjs'
import { APPS, SCENARIOS } from '../src/release/scenarios.mjs'
import { gitIn, validateRun } from '../src/release/runparams.mjs'
import { buildViewModel } from '../src/release/viewmodel.mjs'
import { listApps } from '../src/release/appregistry.mjs'
import { createGithub } from '../src/release/github.mjs'
import { recordDecision } from '../src/release/decision.mjs'
import adapter from '../src/release/adapters/freshrss.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = +(process.argv[2] ?? 8790)
const GOOD = '1.29.1', BAD = '1.30.0'
const JOBS = { diff: ['src/release/diff-builds.mjs', GOOD, BAD], confirm: ['src/release/confirm.mjs', GOOD, BAD, '--bisect'] }
const EVIDENCE = join(ROOT, 'out/evidence')
const UI_DIR = process.env.BEHIQUE_UI_DIR ?? join(homedir(), 'dev/behique-ui') // the dashboard project; served read-only
const SPEC = join(ROOT, 'out/regression', `${GOOD}-vs-${BAD}`, 'R1.spec.js')

let job = null // the running pipeline process
const live = new Map() // ref -> running build for hand testing
const LIVE_PORT = { [GOOD]: 8301, [BAD]: 8302 }

const HOST_OK = new RegExp(`^(127\\.0\\.0\\.1|localhost):${PORT}$`) // this server's own address: stops DNS-rebinding pages from reading it (it now serves private repo names)
const github = createGithub() // read-only, through the existing gh login
let lastGithubRefresh = 0
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) }
const caseOf = id => (/^[\w.-]+$/.test(id ?? '') && listCases(EVIDENCE).includes(id) ? openCase(join(EVIDENCE, id)) : null)
const readBody = req => new Promise((resolve, reject) => { let b = ''; req.on('data', d => { b += d; if (b.length > 4096) { reject(new Error('body too large')); req.destroy() } }); req.on('end', () => resolve(b)) })
let asking = false // one paid model call at a time, so a double click cannot spend twice
// Writes to a record only from this page, as JSON, from this origin.
const badPost = req => {
  if (req.headers.origin && !new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}$`).test(req.headers.origin)) return [403, 'wrong origin'] // this server's own port, not a fixed one
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return [415, 'send JSON']
  return null
}
// ---- runs started from the dashboard: they live in the background, independent of any open page ----
let uiRun = null // the current or most recent run: { runId, params, startedAt, caseId, lines, status, code, proc }
const runView = r => r && ({ runId: r.runId, running: r.status === 'running', status: r.status, code: r.code, caseId: r.caseId, params: r.params, startedAt: r.startedAt, lastLine: r.lines.at(-1) ?? null })
const adapterOf = async app => (await import(`../src/release/adapters/${APPS[app].adapter}.mjs`)).default
function startUiRun(params) {
  const argv = ['src/release/confirm.mjs', params.goodRef, params.candRef, '--scenario', params.scenario, ...(params.bisect ? ['--bisect'] : [])]
  const proc = spawn('node', argv, { cwd: ROOT })
  const r = uiRun = { runId: 'r' + Date.now().toString(36), params, startedAt: new Date().toISOString(), caseId: null, lines: [], status: 'running', code: null, proc }
  job = proc
  let buf = ''
  const take = d => { buf += String(d); const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) { if (!l.trim()) continue; r.lines.push(l); if (r.lines.length > 400) r.lines.shift(); const m = l.match(/^evidence: (\S+)$/); if (m) r.caseId = m[1] } }
  proc.stdout.on('data', take); proc.stderr.on('data', take)
  proc.on('error', e => { r.lines.push('could not start: ' + e.message) })
  proc.on('close', (code, signal) => { r.code = code; r.status = signal === 'SIGTERM' || code === 130 ? 'cancelled' : code === 0 || code === 1 ? 'finished' : 'failed'; if (job === proc) job = null })
  return r
}
const liveState = () => Object.fromEntries([GOOD, BAD].map(r => [r, live.has(r) ? { url: live.get(r).base + '/', sha: live.get(r).sha.slice(0, 12) } : null]))

createServer(async (req, res) => {
  if (!HOST_OK.test(req.headers.host ?? '')) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('wrong host') }
  const u = new URL(req.url, 'http://x')
  if (u.pathname.startsWith('/api/')) console.log(new Date().toISOString().slice(11, 19), req.method, req.url, (req.headers['user-agent'] ?? '').slice(0, 30))
  try {
    if (u.pathname === '/') return send(res, 200, readFileSync(join(ROOT, 'demo/index.html'), 'utf8'), 'text/html; charset=utf-8')
    const logo = u.pathname.match(/^\/assets\/(Green|Red|RG|GR)\.png$/)
    if (logo) return send(res, 200, readFileSync(join(ROOT, 'demo/assets', logo[1] + '.png')), 'image/png')
    if (u.pathname === '/bench') return send(res, 200, readFileSync(join(ROOT, 'bench/baseline.html'), 'utf8'), 'text/html; charset=utf-8')

    if (u.pathname === '/api/run') { // stream a pipeline job as server-sent events
      const name = u.searchParams.get('job')
      if (!JOBS[name]) return send(res, 400, { error: 'unknown job' })
      const scenario = u.searchParams.get('scenario') ?? 'share'
      if (!SCENARIOS[scenario]) return send(res, 400, { error: 'unknown scenario' })
      if (job) return send(res, 409, { error: 'a job is already running' })
      if (live.size) return send(res, 409, { error: 'stop the hand-test builds first: the pipeline reuses their folders' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      const t0 = Date.now()
      const mine = job = spawn('node', name === 'confirm' ? [...JOBS.confirm, '--scenario', scenario] : JOBS[name], { cwd: ROOT })
      const onData = d => String(d).split('\n').filter(Boolean).forEach(line => emit('line', line))
      mine.stdout.on('data', onData); mine.stderr.on('data', onData)
      mine.on('close', code => { emit('done', { code, seconds: +((Date.now() - t0) / 1000).toFixed(1) }); res.end(); if (job === mine) job = null })
      res.on('close', () => { if (mine.exitCode === null) mine.kill() }) // a closed page stops its own run, never someone else's
      return
    }

    if (u.pathname === '/api/busy') return send(res, 200, { reason: job ? 'A check is already running, wait for it to finish.' : live.size ? 'The hand-test versions are running. Stop them first, because the check reuses their folders.' : null })

    const ui = u.pathname.match(/^\/ui\/([\w.-]+\.(html|png))$/) // only plain html and png files by exact name; no paths, no dotfiles
    if (ui && !ui[1].startsWith('.') && existsSync(join(UI_DIR, ui[1]))) return send(res, 200, readFileSync(join(UI_DIR, ui[1]), ui[2] === 'html' ? 'utf8' : undefined), ui[2] === 'html' ? 'text/html; charset=utf-8' : 'image/png')

    if (u.pathname === '/report') return send(res, 200, readFileSync(join(ROOT, 'demo/report.html'), 'utf8'), 'text/html; charset=utf-8')

    if (u.pathname === '/api/cases') return send(res, 200, listCases(EVIDENCE).map(id => { const s = summarize(openCase(join(EVIDENCE, id)).read()); return { id, decision: s.decision?.decision ?? null, proven: s.claims.some(c => c.label === 'reproduced_failure') } }))

    if (u.pathname === '/api/case') { // one case: its events, its claims, and whether the record is intact
      const c = caseOf(u.searchParams.get('id'))
      if (!c) return send(res, 404, { error: 'no such case' })
      const events = c.read()
      return send(res, 200, { id: u.searchParams.get('id'), events, summary: summarize(events), chain: c.verify(), labels: LABELS })
    }

    if (u.pathname === '/api/artifact') { // evidence files are served as plain text so they can never run as a page
      const c = caseOf(u.searchParams.get('id')), hash = u.searchParams.get('hash') ?? ''
      const p = c?.artifactPath(hash)
      if (!p) return send(res, 404, { error: 'no such evidence' })
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
      return res.end(readFileSync(p))
    }

    if ((u.pathname === '/api/decision' || u.pathname === '/api/ui/decision') && req.method === 'POST') { // a person records ship or hold
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      let body; try { body = JSON.parse(await readBody(req) || '{}') } catch { return send(res, 400, { error: 'invalid JSON' }) }
      const c = caseOf(body.id)
      if (!c) return send(res, 404, { error: 'no such case' })
      const r = recordDecision(c, body) // the one writer: reason rules, override, nothing decided mid-run, no ship on incomplete evidence
      if (!r.ok) return send(res, r.status, { error: r.error, needsOverride: r.needsOverride === true })
      return send(res, 200, u.pathname === '/api/ui/decision' ? buildViewModel(c, { caseId: body.id }) : summarize(c.read()))
    }

    if (u.pathname === '/api/hypothesis' && req.method === 'GET') { // what an AI guess would send and cost; calls nothing
      const c = caseOf(u.searchParams.get('id'))
      if (!c) return send(res, 404, { error: 'no such case' })
      try {
        const p = await previewHypothesis(c)
        return send(res, 200, { ok: true, est: p.est, keyPresent: p.keyPresent, existing: p.ctx.existing, limit: p.limit, symptoms: p.ctx.symptoms, sent: p.messages, truncated: p.ctx.truncated })
      } catch (e) { return send(res, 200, { ok: false, reason: String(e.message) }) }
    }

    if (u.pathname === '/api/hypothesis' && req.method === 'POST') { // the one paid call, made only when a person asks
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      const c = caseOf(JSON.parse(await readBody(req) || '{}').id)
      if (!c) return send(res, 404, { error: 'no such case' })
      if (asking) return send(res, 409, { error: 'a model call is already running' })
      asking = true
      try { const r = await hypothesize(c); return send(res, 200, { ok: true, usd: r.usd, grounded: r.grounded }) }
      catch (e) { return send(res, 502, { error: String(e.message) }) }
      finally { asking = false }
    }

    if (u.pathname === '/api/ui/repos') { // the sidebar's list: built-in apps, then the GitHub account's repos (read-only, nothing is cloned)
      const wantRefresh = u.searchParams.get('refresh') === '1' && Date.now() - lastGithubRefresh > 10_000 // at most one real refresh per 10 s
      if (wantRefresh) lastGithubRefresh = Date.now()
      return send(res, 200, await listApps({ github, refresh: wantRefresh }))
    }
    if (u.pathname === '/api/ui/cases') { // the runs list for the dashboard: newest first
      return send(res, 200, listCases(EVIDENCE).map(id => { const vm = buildViewModel(openCase(join(EVIDENCE, id)), { caseId: id }); return { id, app: vm.appId, title: vm.title, scenario: vm.scenario?.label ?? null, verdict: vm.verdict, sub: vm.sub, decision: vm.decision?.choice ?? null, progress: vm.progress?.text ?? null } }))
    }
    if (u.pathname === '/api/ui/apps') { // what a run can target: apps, their known cases, and the versions found in the repository
      return send(res, 200, await Promise.all(Object.entries(APPS).map(async ([name, a]) => {
        const tags = (await gitIn((await adapterOf(name)).repo)(['tag', '--sort=-creatordate'])).out.split('\n').filter(Boolean).slice(0, 40)
        return { name, label: a.label, defaults: a.defaults, tags, scenarios: Object.entries(SCENARIOS).filter(([, s]) => s.app === name).map(([id, s]) => ({ name: id, label: s.label, about: s.about })) }
      })))
    }
    if (u.pathname === '/api/ui/runs' && req.method === 'POST') { // start a run
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      if (job) return send(res, 409, { error: 'A run is already in progress. Wait for it to finish, or cancel it.' })
      if (live.size) return send(res, 409, { error: 'The hand-test versions are running. Stop them first: a run reuses their folders.' })
      const body = JSON.parse(await readBody(req) || '{}')
      const sc = SCENARIOS[body.scenario]
      if (!sc) return send(res, 400, { error: 'Choose one of the known cases.' })
      const v = await validateRun(body, { scenarios: SCENARIOS, git: gitIn((await adapterOf(sc.app)).repo) })
      if (!v.ok) return send(res, 400, { error: v.error })
      return send(res, 200, { ...runView(startUiRun(v.params)), note: v.note })
    }
    if (u.pathname === '/api/ui/runs/current') return send(res, 200, uiRun ? runView(uiRun) : { running: false, status: 'none' })
    if (u.pathname === '/api/ui/runs/cancel' && req.method === 'POST') {
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      if (!uiRun || uiRun.status !== 'running') return send(res, 409, { error: 'No run from the dashboard is in progress.' })
      uiRun.proc.kill('SIGTERM') // the run stops its own builds, closes its record as cancelled, and exits
      return send(res, 200, { cancelling: true, runId: uiRun.runId })
    }

    if (u.pathname === '/api/ui/rules') { // may this actor write this kind of claim? answered by the record's own rule; writes nothing
      const actor = u.searchParams.get('actor') ?? '', kind = u.searchParams.get('kind') ?? ''
      const error = kind === 'human_decision' ? (actor === 'human' ? null : `${actor} may not write a human_decision claim (allowed: human)`) : writeError(kind, actor)
      return send(res, 200, { allowed: !error, error })
    }
    if (u.pathname === '/api/ui/case') { // one report in exactly the shape the dashboard renders
      const c = caseOf(u.searchParams.get('id'))
      if (!c) return send(res, 404, { error: 'no such case' })
      return send(res, 200, buildViewModel(c, { caseId: u.searchParams.get('id') }))
    }

    if (u.pathname === '/api/scenarios') return send(res, 200, Object.entries(SCENARIOS).map(([name, s]) => ({ name, label: s.label, about: s.about })))

    if (u.pathname === '/api/spec') return send(res, 200, existsSync(SPEC) ? readFileSync(SPEC, 'utf8') : '', 'text/plain; charset=utf-8')

    if (u.pathname === '/api/live') { // start or stop the two releases for hand testing
      const action = u.searchParams.get('action')
      if (action === 'start') {
        if (job) return send(res, 409, { error: 'a pipeline job is running, wait for it to finish' })
        for (const ref of [GOOD, BAD]) if (!live.has(ref)) {
          const port = LIVE_PORT[ref] // own feed port too, so both builds can run at once
          live.set(ref, await startBuild({ adapter: { ...adapter, feed: { ...adapter.feed, port: port + 100 } }, ref, port }))
        }
      } else if (action === 'stop') { for (const b of live.values()) await b.stop(); live.clear() }
      return send(res, 200, liveState())
    }
    send(res, 404, { error: 'not found' })
  } catch (e) { send(res, 500, { error: String(e.message ?? e) }) }
}).listen(PORT, '127.0.0.1', () => console.log(`demo on http://127.0.0.1:${PORT}`))

const bye = async () => { for (const b of live.values()) await b.stop(); job?.kill(); process.exit(0) }
process.on('SIGINT', bye); process.on('SIGTERM', bye)
