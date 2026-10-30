// Local demo server: serves demo/index.html and runs the release pipeline on request. No model calls.
//   node demo/server.mjs [port]      then open http://127.0.0.1:8790
// One pipeline job at a time (they share port 8300). Hand-test builds use their own ports (8301, 8302).
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
import { askModel, askPreview, whyNot } from '../src/release/ask.mjs'
import adapter from '../src/release/adapters/freshrss.mjs'
import { ENV, PROVIDERS } from '../src/llm.mjs'
import { validateVisualRun, visualArgv, visualProgress, caseIdOf } from '../src/release/ui/visual-run.mjs'
import { listCandidates, onboardPreview, onboardPropose, onboardVerify } from '../src/release/ui/onboard-flow.mjs'
import { crawlProgress } from '../src/release/ui/crawl-run.mjs'
import { cloneRun, clonePreview } from '../src/release/ui/clone-flow.mjs'
import { loadProfile, profilePath, validateProfile, describeCommands, saveProfile } from '../src/release/onboard/profile.mjs'
import { inspectRepo } from '../src/release/onboard/inspect.mjs'
import { buildMessages, projectCost, proposeProfile } from '../src/release/onboard/propose.mjs'
import { verifyProfile } from '../src/release/onboard/verify.mjs'
import { defaultAsk, defaultSkillText } from '../src/release/onboard/onboard.mjs'

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
// ---- apps Behique set up itself (saved profiles) and the guarded set-up steps ----
const APPS_ROOT = join(homedir(), 'dev/behique-apps') // only repositories already cloned here can be set up; nothing is cloned by the page
const profileDir = () => dirname(profilePath('x'))
const profileNames = () => { try { return readdirSync(profileDir()).filter(f => /^[a-z0-9-]+\.json$/.test(f)).map(f => f.slice(0, -5)).sort() } catch { return [] } }
const profiles = () => profileNames().flatMap(n => { try { return [loadProfile(n)] } catch { return [] } })
// Cloning: only repositories in the user's own GitHub list (already read through the fixed, read-only `gh` calls) can be cloned from the page,
// into the apps folder, with `git clone`, and only with the fingerprint of the preview that was shown.
let cloning = false
const cloneDeps = () => ({
  appsRoot: APPS_ROOT, exists: p => existsSync(p),
  repoInfo: async (owner, name) => {
    const r = (await github.repos()).repos.find(x => x.fullName === `${owner}/${name}`)
    if (!r) throw new Error('not in the connected GitHub account')
    return { sizeKb: r.sizeKb, isPrivate: r.private, isFork: r.fork, isArchived: r.archived, defaultBranch: r.defaultBranch }
  },
  exec: (command, { timeoutMs }) => new Promise(resolve => execFile(command[0], command.slice(1), { timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr ?? '') }))),
})
let onboarding = false // one paid proposal or verification at a time; verification uses the builds' ports
const onboardDeps = () => ({
  appsRoot: APPS_ROOT, isGitRepo: async p => { try { return statSync(join(p, '.git')).isDirectory() } catch { return false } }, /* a real clone only: a build worktree has a .git file instead */ readdir: async d => readdirSync(d), listProfiles: async () => profileNames(),
  inspectRepo, skillText: defaultSkillText(), buildMessages, projectCost, provider: 'meta', keyPresent: Boolean(ENV[PROVIDERS.meta.keyEnv]),
  ask: defaultAsk, proposeProfile, describeCommands, validateProfile, verifyProfile, saveProfile,
  writeFile: async (path, text) => { const f = join(ROOT, path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text, 'utf8') },
  readFile: async path => readFileSync(join(ROOT, path), 'utf8'),
})

// ---- runs started from the dashboard: they live in the background, independent of any open page ----
let uiRun = null // the current or most recent run: { runId, params, startedAt, caseId, lines, status, code, proc }
const runView = r => r && ({ runId: r.runId, kind: r.kind, running: r.status === 'running', status: r.status, code: r.code, caseId: r.caseId, params: r.params, startedAt: r.startedAt, lastLine: r.lines.at(-1) ?? null, ...(r.kind === 'visual' ? { progress: visualProgress(r.lines) } : r.kind === 'crawl' ? { progress: crawlProgress(r.lines) } : {}) })
const adapterOf = async app => (await import(`../src/release/adapters/${APPS[app].adapter}.mjs`)).default
function startUiRun(params, kind = 'release') {
  const argv = kind === 'visual' ? visualArgv(params) : kind === 'crawl' ? ['src/release/check-app.mjs', params.app, params.goodRef, params.candRef, ...(params.bisect ? ['--bisect'] : [])] : ['src/release/confirm.mjs', params.goodRef, params.candRef, '--scenario', params.scenario, ...(params.bisect ? ['--bisect'] : [])]
  const proc = spawn('node', argv, { cwd: ROOT })
  const r = uiRun = { runId: 'r' + Date.now().toString(36), kind, params, startedAt: new Date().toISOString(), caseId: null, lines: [], status: 'running', code: null, proc }
  job = proc
  let buf = ''
  const take = d => { buf += String(d); const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) { if (!l.trim()) continue; r.lines.push(l); if (r.lines.length > 400) r.lines.shift(); const m = l.match(/^(?:evidence|case): (\S+)$/) ?? (kind === 'visual' && l.match(/^case (\S+)$/)); if (m && /^[\w.-]+$/.test(m[1])) r.caseId = m[1] } }
  proc.stdout.on('data', take); proc.stderr.on('data', take)
  proc.on('error', e => { r.lines.push('could not start: ' + e.message) })
  proc.on('close', (code, signal) => { r.code = code; r.status = signal === 'SIGTERM' || code === 130 ? 'cancelled' : code === 0 || code === 1 ? 'finished' : 'failed'; if (job === proc) job = null })
  return r
}
const liveState = () => Object.fromEntries([GOOD, BAD].map(r => [r, live.has(r) ? { url: live.get(r).base + '/', sha: live.get(r).sha.slice(0, 12) } : null]))

// ---- watch page: where saved traces and live runs are written, and the test app they run against ----
const WATCH_SAVED = join(ROOT, 'out/senses-traces'), WATCH_LIVE = join(ROOT, 'out/senses-live'), WATCH_PROPOSALS = join(WATCH_SAVED, 'proposals.json')
const watchBugs = () => JSON.parse(readFileSync(join(ROOT, 'bench/fixtures/canvas-app/bugs.json'), 'utf8')).map(b => ({ id: b.id, what: b.what, object: b.object, detectable: b.detectable !== false }))
const watchVariantOk = v => typeof v === 'string' && (v === 'clean' || watchBugs().some(b => b.id === v))
let watchBusy = false, watchBase = null
const watchFixture = () => watchBase ?? (watchBase = new Promise(resolve => { // the test app on its own random local port, started the first time a live run needs it
  const html = readFileSync(join(ROOT, 'bench/fixtures/canvas-app/index.html'))
  const s = createServer((rq, rs) => { rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); rs.end(html) })
  s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}/`))
}))

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
    if (u.pathname === '/senses') return send(res, 200, readFileSync(join(ROOT, 'demo/senses.html'), 'utf8'), 'text/html; charset=utf-8')
    // ---- watch the canvas senses work: a saved trace (no cost) or a live run on the canvas test app (no model calls either) ----
    if (u.pathname === '/watch') return send(res, 200, readFileSync(join(ROOT, 'demo/watch.html'), 'utf8'), 'text/html; charset=utf-8')
    if (u.pathname === '/canvas-app/') return send(res, 200, readFileSync(join(ROOT, 'bench/fixtures/canvas-app/index.html')), 'text/html; charset=utf-8') // the app under test, for people to try by hand: ?bug=<id>
    if (u.pathname === '/api/watch/variants') return send(res, 200, [{ id: 'clean', what: 'The unchanged app.', object: null }, ...watchBugs()])
    if (u.pathname === '/api/watch/saved') {
      const v = u.searchParams.get('variant'), f = join(WATCH_SAVED, String(v), 'trace.json')
      if (!watchVariantOk(v) || !existsSync(f)) return send(res, 404, { error: 'no saved trace for that variant: run node bench/canvas-trace.mjs' })
      return send(res, 200, readFileSync(f, 'utf8'))
    }
    const wf = u.pathname.match(/^\/watch-files\/(saved|live)\/([\w-]+)\/(s\d+-(?:before|after|diff)\.png)$/) // exact names only
    if (wf && watchVariantOk(wf[2])) { const f = join(wf[1] === 'saved' ? WATCH_SAVED : WATCH_LIVE, wf[2], wf[3]); return existsSync(f) ? send(res, 200, readFileSync(f), 'image/png') : send(res, 404, { error: 'no such picture' }) }
    if (u.pathname === '/api/watch/run') { // run the senses on the test app now and stream each step as server-sent events
      const v = u.searchParams.get('variant')
      if (!watchVariantOk(v)) return send(res, 400, { error: 'unknown variant' })
      if (watchBusy) return send(res, 409, { error: 'a live run is already going' })
      if (!existsSync(WATCH_PROPOSALS)) return send(res, 409, { error: 'no proposals saved: run node bench/canvas-trace.mjs once' })
      watchBusy = true
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const emit = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
      try {
        const { traceVariant } = await import('../src/senses/trace.mjs')
        const controls = JSON.parse(readFileSync(WATCH_PROPOSALS, 'utf8'))
        const base = await watchFixture()
        emit('start', { variant: v, proposals: controls.length })
        await traceVariant({ url: base + (v === 'clean' ? '' : '?bug=' + v), controls, dir: join(WATCH_LIVE, v), variant: v, replays: 3, onEvent: e => emit(e.type, e) })
      } catch (e) { emit('failed', { error: String(e.message).slice(0, 200) }) } finally { watchBusy = false; res.end() }
      return
    }

    if (u.pathname === '/api/cases') return send(res, 200, listCases(EVIDENCE).map(id => { const s = summarize(openCase(join(EVIDENCE, id)).read()); return { id, decision: s.decision?.decision ?? null, proven: s.claims.some(c => c.label === 'reproduced_failure'), kind: s.opened?.kind ?? null } }))

    if (u.pathname === '/api/case') { // one case: its events, its claims, and whether the record is intact
      const c = caseOf(u.searchParams.get('id'))
      if (!c) return send(res, 404, { error: 'no such case' })
      const events = c.read()
      return send(res, 200, { id: u.searchParams.get('id'), events, summary: summarize(events), chain: c.verify(), labels: LABELS })
    }

    if (u.pathname === '/api/artifact-image') { // a saved PNG, shown as a picture; only files recorded as image/png whose bytes really are a PNG
      const c = caseOf(u.searchParams.get('id')), hash = u.searchParams.get('hash') ?? ''
      const p = c?.artifactPath(hash)
      const meta = p && c.read().find(e => e.type === 'artifact' && e.data.hash === hash)?.data
      const buf = p && meta?.mediaType === 'image/png' ? readFileSync(p) : null
      if (!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return send(res, 404, { error: 'no such picture' })
      res.writeHead(200, { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
      return res.end(buf)
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
      const why = whyNot(c); if (why) return send(res, 400, { error: why }) // not mid-run, not past the limit
      asking = true
      try { const r = await hypothesize(c); return send(res, 200, { ok: true, usd: r.usd, grounded: r.grounded }) }
      catch (e) { return send(res, 502, { error: String(e.message) }) }
      finally { asking = false }
    }

    if (u.pathname === '/api/ui/ask' && req.method === 'GET') { // what asking the model would send and cost; calls nothing
      const c = caseOf(u.searchParams.get('id'))
      if (!c) return send(res, 404, { error: 'no such case' })
      return send(res, 200, await askPreview(c))
    }
    if (u.pathname === '/api/ui/ask' && req.method === 'POST') { // the paid call: only with the fingerprint of the text the person was shown
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      let body; try { body = JSON.parse(await readBody(req) || '{}') } catch { return send(res, 400, { error: 'invalid JSON' }) }
      const c = caseOf(body.id)
      if (!c) return send(res, 404, { error: 'no such case' })
      if (asking) return send(res, 409, { error: 'A model call is already running.' })
      asking = true
      try {
        const r = await askModel(c, { confirm: body.confirm })
        if (!r.ok) return send(res, r.status, { error: r.error, stale: r.stale === true })
        return send(res, 200, { asked: { usd: r.usd, grounded: r.grounded }, vm: buildViewModel(c, { caseId: body.id }) })
      } catch (e) { return send(res, 502, { error: String(e.message) }) } // the model call failed or its reply was unusable; the record says what it cost
      finally { asking = false }
    }

    if (u.pathname === '/api/ui/repos') { // the sidebar's list: built-in apps, then the GitHub account's repos (read-only, nothing is cloned)
      const wantRefresh = u.searchParams.get('refresh') === '1' && Date.now() - lastGithubRefresh > 10_000 // at most one real refresh per 10 s
      if (wantRefresh) lastGithubRefresh = Date.now()
      return send(res, 200, await listApps({ github, refresh: wantRefresh, profiles: profiles() }))
    }
    if (u.pathname === '/api/ui/cases') { // the runs list for the dashboard: newest first
      return send(res, 200, listCases(EVIDENCE).map(id => { const vm = buildViewModel(openCase(join(EVIDENCE, id)), { caseId: id }); return { id, app: vm.appId, title: vm.title, scenario: vm.scenario?.label ?? null, verdict: vm.verdict, sub: vm.sub, decision: vm.decision?.choice ?? null, progress: vm.progress?.text ?? null } }))
    }
    if (u.pathname === '/api/ui/apps') { // what a run can target: apps, their known cases, and the versions found in the repository
      const visualApps = await Promise.all(profiles().map(async p => ({ name: p.name, label: p.label ?? p.name, kind: 'visual', defaults: p.defaults ?? null, regions: Object.keys(p.regions ?? {}), scenarios: [], tags: (await gitIn(p.repo)(['tag', '--sort=-creatordate'])).out.split('\n').filter(Boolean).slice(0, 40) })))
      return send(res, 200, [...await Promise.all(Object.entries(APPS).map(async ([name, a]) => {
        const tags = (await gitIn((await adapterOf(name)).repo)(['tag', '--sort=-creatordate'])).out.split('\n').filter(Boolean).slice(0, 40)
        return { name, label: a.label, defaults: a.defaults, tags, scenarios: Object.entries(SCENARIOS).filter(([, s]) => s.app === name).map(([id, s]) => ({ name: id, label: s.label, about: s.about })) }
      })), ...visualApps])
    }
    if (u.pathname === '/api/ui/runs' && req.method === 'POST') { // start a run
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      if (job) return send(res, 409, { error: 'A run is already in progress. Wait for it to finish, or cancel it.' })
      if (live.size) return send(res, 409, { error: 'The hand-test versions are running. Stop them first: a run reuses their folders.' })
      const body = JSON.parse(await readBody(req) || '{}')
      if (onboarding) return send(res, 409, { error: 'An app is being set up right now. Wait for it to finish: it uses the same ports.' })
      if (body.kind === 'crawl') { // a release check without hand-written steps: crawl the good version, compare both along the crawled steps (an app Behique set up, or FreshRSS)
        const builtin = async n => ({ repo: (await adapterOf(n)).repo, defaults: APPS[n].defaults, regions: {} })
        const v = await validateVisualRun({ ...body, region: undefined }, { listProfiles: async () => [...profileNames(), ...Object.keys(APPS)], loadProfile: async n => (profileNames().includes(n) ? loadProfile(n) : builtin(n)), git: gitIn })
        if (!v.ok) return send(res, 400, { error: v.error })
        return send(res, 200, { ...runView(startUiRun(v.params, 'crawl')), note: v.note })
      }
      if (body.kind === 'visual') { // a visual check of an app Behique set up itself
        const v = await validateVisualRun(body, { listProfiles: async () => profileNames(), loadProfile: async n => loadProfile(n), git: gitIn })
        if (!v.ok) return send(res, 400, { error: v.error })
        return send(res, 200, { ...runView(startUiRun(v.params, 'visual')), note: v.note })
      }
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

    if (u.pathname === '/api/ui/clone/preview') { // what cloning would run and how big it is; clones nothing
      const r = await clonePreview({ repo: u.searchParams.get('repo') }, cloneDeps())
      return send(res, r.ok ? 200 : r.status ?? 400, r)
    }
    if (u.pathname === '/api/ui/clone' && req.method === 'POST') { // the clone itself: only with the fingerprint of the preview
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      if (cloning) return send(res, 409, { error: 'Another clone is running.' })
      cloning = true
      try { const r = await cloneRun(JSON.parse(await readBody(req) || '{}'), cloneDeps()); return send(res, r.ok ? 200 : r.status ?? 400, r) } finally { cloning = false }
    }
    if (u.pathname === '/api/ui/onboard/candidates') return send(res, 200, await listCandidates(onboardDeps())) // repositories already cloned in the apps folder
    if (u.pathname === '/api/ui/onboard/preview' && req.method === 'POST') { // what would be sent and what it would cost; calls no model
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      const r = await onboardPreview(JSON.parse(await readBody(req) || '{}'), onboardDeps())
      return send(res, r.ok ? 200 : r.status ?? 400, r)
    }
    if (u.pathname === '/api/ui/onboard/propose' && req.method === 'POST') { // the paid call: only with the fingerprint of the text that was shown
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      if (onboarding) return send(res, 409, { error: 'Another set-up step is running.' })
      onboarding = true
      try { const r = await onboardPropose(JSON.parse(await readBody(req) || '{}'), onboardDeps()); return send(res, r.ok ? 200 : r.status ?? 400, r) } finally { onboarding = false }
    }
    if (u.pathname === '/api/ui/onboard/verify' && req.method === 'POST') { // build both versions, take pictures, measure noise; saves the profile only if all of it passed
      const bad = badPost(req); if (bad) return send(res, bad[0], { error: bad[1] })
      if (job || uiRun?.status === 'running') return send(res, 409, { error: 'A run is in progress. Wait for it to finish: verification builds both versions.' })
      if (live.size) return send(res, 409, { error: 'The hand-test versions are running. Stop them first: verification reuses their ports.' })
      if (onboarding) return send(res, 409, { error: 'Another set-up step is running.' })
      onboarding = true
      try { const r = await onboardVerify(JSON.parse(await readBody(req) || '{}'), { ...onboardDeps(), log: () => {} }); return send(res, r.ok ? 200 : r.status ?? 400, r) } finally { onboarding = false }
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
