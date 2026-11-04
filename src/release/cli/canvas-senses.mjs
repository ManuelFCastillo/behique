// Canvas senses in the main check (`behique check ... --ai-canvas`): for an app drawn on a canvas (Music Blocks), a model looks at
// ONE settled screenshot of the good version and lists the controls it sees; code then clicks every control, in fresh browsers,
// twice on each version, and says where the pictures reacted differently. The model proposes the controls; the pixels decide what
// each click did; nothing here is proof of a bug and nothing here touches the verdict. It runs as the "canvas" AI stage of
// ai-stages.mjs (same budget, same model.call records, same labelled section in the comment).
//
// Rules: opt-in; only a public repository is ever screenshotted to a model (checked against GitHub without a login, and refused
// when that cannot be confirmed); the exact projected cost is logged before anything is sent; external hosts are blocked in the
// browser. Everything that touches a browser or the network is injected, so the tests are offline.
//   node --test src/release/cli/canvas-senses.test.mjs
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const sh = promisify(execFile)
export const VIEWPORT = { width: 1280, height: 800 }
export const DPR = 2
export const PROBE_KINDS = new Set(['button', 'icon', 'toggle', 'checkbox', 'swatch']) // sliders and draggable objects are listed, not clicked here
export const MAX_CONTROLS = 10
// Per-app set-up found by looking at the app (the welcome tour's close button), keyed by the app's profile name. Anything not listed gets none.
export const PREP = { musicblocks: { closeTourAt: [220, 155] } }
const PRICE = { inPerTok: 1.25e-6, outPerTok: 4.25e-6 }
export const projectedUsd = (calls = 1) => calls * (6000 * PRICE.inPerTok + 2000 * PRICE.outPerTok) // measured shape: about 6,000 tokens in, 2,000 out per screenshot

/** Is this a canvas app? The profile names regions or anchors (a visual profile), or the case already recorded a canvas comparison. */
export function qualifies(profile, events = []) {
  if (events.some(e => e.type === 'canvas.compared' || (e.type === 'case.opened' && (e.data?.kind === 'visual' || e.data?.kind === 'canvas')))) return true
  return Boolean(profile && (Object.keys(profile.regions ?? {}).length || Object.keys(profile.anchors ?? {}).length))
}

/** The owner/name of a GitHub remote url, or null. */
export function githubSlug(url) {
  const m = String(url ?? '').trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

/** True only when GitHub itself says, without any login, that the repository of this checkout is public. Anything unknown is "not public". */
export async function isPublicRepo(repoDir, { run = (cmd, args) => sh(cmd, args, { timeout: 10_000 }), fetchFn = globalThis.fetch } = {}) {
  try {
    const { stdout } = await run('git', ['-C', repoDir, 'remote', 'get-url', 'origin'])
    const slug = githubSlug(stdout)
    if (!slug) return { ok: false, why: 'the repository has no github.com remote, so it cannot be confirmed public' }
    const res = await fetchFn(`https://api.github.com/repos/${slug}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'behique' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false, why: `GitHub does not show ${slug} without a login (HTTP ${res.status}), so it is treated as private` }
    const j = await res.json()
    return j.private === false ? { ok: true, slug } : { ok: false, why: `${slug} is not public` }
  } catch (e) { return { ok: false, why: `could not confirm the repository is public (${String(e.message ?? e).slice(0, 100)})` } }
}

const POINT = p => `${Math.round(p[0] * 100)}%, ${Math.round(p[1] * 100)}% of the screen`
const doesWhat = v => (v === 'changed' ? 'changed the picture' : v === 'no_change' ? 'changed nothing' : String(v).replace(/^skipped_/, 'was skipped: '))

/**
 * Compare the click outcomes of the same controls on two versions. `rows` hold { side: 'good'|'cand', i, run: 'A'|'B', verdict, ready }.
 * A control is unstable (left out, counted) when its two runs on one version disagree, a run errored, or its page had not settled.
 */
export function compareControls(controls, rows) {
  const at = (side, i, run) => rows.find(r => r.side === side && r.i === i && r.run === run)
  const differs = [], unstable = []
  let compared = 0
  controls.forEach((c, i) => {
    const r = ['good', 'cand'].flatMap(side => ['A', 'B'].map(run => at(side, i, run)))
    if (r.some(x => !x)) { unstable.push(c); return }
    const [gA, gB, cA, cB] = r
    if (r.some(x => x.verdict === 'error' || x.ready === false) || gA.verdict !== gB.verdict || cA.verdict !== cB.verdict) { unstable.push(c); return }
    if (String(gA.verdict).startsWith('skipped') || String(cA.verdict).startsWith('skipped')) return
    compared++
    if ((gA.verdict === 'changed') !== (cA.verdict === 'changed')) differs.push({ control: c, good: gA.verdict, cand: cA.verdict })
  })
  return { compared, differs, unstable }
}

/** The default browser: Chromium, external hosts blocked, the viewport and scale the senses were measured at. */
async function browserDeps(prep) {
  const { chromium } = await import('playwright')
  const { act, settle, shot } = await import('../../senses/hands.mjs')
  const { emptiness, scaleBox } = await import('../../senses/pixels.mjs')
  let browser = null
  const get = async () => (browser ??= await chromium.launch())
  const prepare = async base => {
    const ctx = await (await get()).newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })
    await ctx.route(url => !/^(127\.0\.0\.1|localhost)$/.test(new URL(url).hostname) && !url.protocol.startsWith('data') && url.protocol !== 'blob:', r => r.abort())
    const page = await ctx.newPage()
    await page.goto(base, { waitUntil: 'load' })
    const s1 = await settle(page, { stableMs: 1500, pollMs: 300, maxMs: 40000 })
    if (prep?.closeTourAt) await page.mouse.click(...prep.closeTourAt)
    const s2 = await settle(page, { stableMs: 1500, pollMs: 300, maxMs: 20000 })
    return { ctx, page, png: s2.png, settled: s1.settled && s2.settled }
  }
  return {
    async screenshot(base) { const p = await prepare(base); try { return { png: p.png, settled: p.settled } } finally { await p.ctx.close() } },
    async probe(base, control) {
      const p = await prepare(base)
      try {
        const at = { x: control.point[0] * VIEWPORT.width, y: control.point[1] * VIEWPORT.height }
        const guard = async (pg, a, vp) => emptiness(await shot(pg), scaleBox({ x: a.x - 32, y: a.y - 32, w: 64, h: 64 }, vp.dpr)) >= 0.995 ? 'skipped_blank' : null
        const r = await act(p.page, { type: 'click_at', ...at }, { guard, settling: { stableMs: 1200, pollMs: 300, maxMs: 15000 } })
        return { verdict: r.verdict, ready: p.settled, changed: r.diff?.changed ?? null }
      } finally { await p.ctx.close() }
    },
    close: async () => { if (browser) await browser.close() },
  }
}

async function pool(jobs, n) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) { const k = i++; out[k] = await jobs[k]() } })); return out }

/**
 * The "canvas" AI stage. `context` is { app, good, cand, log }. Resolves the same shape the other stages do:
 * { label: 'ai_hypothesis', items, calls: [], spentUsd: 0, notes } (the seam counts the one model call itself).
 */
export async function run({ caseDir, ask, maxUsd = 0.25, context = {}, deps = {} } = {}) {
  const out = { label: 'ai_hypothesis', items: [], calls: [], spentUsd: 0, notes: [] }
  const { app, good, cand } = context
  const log = context.log ?? (() => {})
  if (!app || !good || !cand) { out.notes.push('the canvas senses need the app and both versions'); return out }
  const loadProfile = deps.loadProfile ?? (async n => (await import('../onboard/profile.mjs')).loadProfile(n))
  const toAdapter = deps.profileToAdapter ?? (async p => (await import('../onboard/profile.mjs')).profileToAdapter(p))
  let profile
  try { profile = await loadProfile(app) } catch (e) { out.notes.push(`canvas senses skipped: ${app} has no saved profile (${String(e.message).slice(0, 80)})`); return out }
  let events = []
  try { const { openCase } = await import('../evidence.mjs'); events = openCase(caseDir).read() } catch {}
  if (!qualifies(profile, events)) { out.notes.push('canvas senses skipped: this app is not a canvas app (its profile names no regions or anchors and the check recorded no canvas)'); return out }
  const needs = deps.needsSandbox ?? (async p => (await import('../ui/settings.mjs')).needsSandbox(p))
  if (await needs(profile) && !process.env.BEHIQUE_SANDBOX) { out.notes.push('canvas senses skipped: this app runs the repository\'s own code, and the sandbox is off'); return out }
  const pub = await (deps.isPublic ?? isPublicRepo)(profile.repo)
  if (!pub.ok) { out.notes.push(`canvas senses skipped: only public apps are screenshotted to a model, and ${pub.why}`); return out }
  const projected = projectedUsd(1)
  if (projected > maxUsd) { out.notes.push(`canvas senses skipped: one call is projected at about $${projected.toFixed(3)}, over the remaining AI budget of $${maxUsd.toFixed(3)}`); return out }
  log(`canvas senses: sending ONE screenshot (${VIEWPORT.width * DPR}x${VIEWPORT.height * DPR}, the viewport only) of ${app} ${good} to Meta muse-spark-1.3 to list the controls it sees; projected about $${projected.toFixed(3)} (estimate). Every control is then clicked by code, not by the model.`)
  const adapter = await toAdapter(profile)
  const startBuild = deps.startBuild ?? (async o => (await import('../build.mjs')).startBuild(o))
  const browser = deps.browser ?? await browserDeps(PREP[app] ?? null)
  const { discover } = deps.vision ?? await import('../../senses/vision.mjs')
  const builds = {}
  try {
    builds.good = await startBuild({ adapter, ref: good, port: 8311 })
    builds.cand = await startBuild({ adapter, ref: cand, port: 8312 })
    const shot = await browser.screenshot(builds.good.base)
    if (!shot.settled) out.notes.push(`the ${good} page had not stopped changing when the screenshot was taken, so some clicks may be unstable`)
    const size = { W: shot.png.readUInt32BE(16), H: shot.png.readUInt32BE(20) }
    const askVision = (text, png) => ask([{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }] }], { reasoning: 'low', maxTokens: 8000 })
    const found = await discover(shot.png, size, askVision)
    out.sent = { model: 'muse-spark-1.3', about: 'one screenshot of the good version, viewport only; the prompt is discoverPrompt() in src/senses/vision.mjs', image: size, reply: String(found.raw ?? '').slice(0, 6000), controls: found.controls, dropped: found.dropped }
    try { const { openCase } = await import('../evidence.mjs'); openCase(caseDir).artifact('canvas-screenshot-the-model-saw.png', shot.png, 'image/png') } catch {}
    log(`canvas senses: the model's reply listed ${found.controls.length} control${found.controls.length === 1 ? '' : 's'}${found.dropped ? ` (${found.dropped} malformed entries dropped)` : ''}${found.controls.length ? `: ${[...new Set(found.controls.map(c => c.kind))].join(', ')}` : ''}`)
    if (found.parseFailed) { out.notes.push('the model\'s list of controls could not be read'); return out }
    const picked = found.controls.filter(c => PROBE_KINDS.has(c.kind)).slice(0, MAX_CONTROLS)
    const notClicked = found.controls.length - picked.length
    if (!picked.length) { out.notes.push('the model listed no control that can be clicked'); return out }
    log(`canvas senses: the model listed ${found.controls.length} controls; clicking ${picked.length} of them on each version, twice, in fresh browsers`)
    const jobs = []
    for (const side of ['good', 'cand']) picked.forEach((c, i) => { for (const run of ['A', 'B']) jobs.push(async () => { let r; try { r = await browser.probe(builds[side].base, c) } catch (e) { r = { verdict: 'error', error: String(e.message).slice(0, 100) } } return { side, i, run, ...r } }) })
    const rows = await pool(jobs, deps.concurrency ?? 2)
    const cmp = compareControls(picked, rows)
    out.items.push({ text: `From one screenshot of ${good}, the model listed ${found.controls.length} controls${notClicked ? ` (${notClicked} were sliders or draggable objects, not clicked)` : ''}. Code clicked ${picked.length}, twice on each version in fresh browsers: ${cmp.compared} gave a steady result on both versions, ${cmp.unstable.length} ${cmp.unstable.length === 1 ? 'was' : 'were'} unsteady and ${cmp.unstable.length === 1 ? 'is' : 'are'} left out, ${cmp.differs.length} reacted differently on ${cand}.`, status: 'unverified', detail: 'the list of controls is the model\'s; the click results are measured by code' })
    for (const d of cmp.differs) {
      out.items.push({ text: `"${d.control.label}" (${d.control.kind}, at ${POINT(d.control.point)}): clicking it ${doesWhat(d.good)} on ${good} and ${doesWhat(d.cand)} on ${cand}.`, status: 'measured by code', detail: 'same click, same result in both of 2 fresh runs on each version; a difference between versions, not proof of a bug' })
    }
    if (!cmp.differs.length) out.notes.push(`no control reacted differently on ${cand}; this is not proof that none does, only that the ${cmp.compared} the model found did not`)
    out.notes.push('Only a public app was sent to the model. The model never clicks and never judges; the verdict does not use any of this.')
  } finally {
    await Promise.all(Object.values(builds).map(b => b.stop?.().catch(() => {})))
    try { await browser.close?.() } catch {}
  }
  return out
}
