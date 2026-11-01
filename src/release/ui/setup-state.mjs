// What the dashboard can see of an app being set up: the step in progress and the last result per repository.
// Set-up steps (the paid proposal, the verification that builds both versions) used to report only to the
// dialog that pressed the button. This keeps their state on the server, like a run, so every page can show it
// on the repo's card and in the sidebar, and the last result survives a restart (out/onboard/state.json).
// No model calls, no commands: it only records what the onboard flow did.

const STATE_FILE = 'out/onboard/state.json'
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/
const APP_RE = /^[a-z0-9-]{1,40}$/
const STEPS = new Set(['propose', 'verify'])

const str = (v, n = 80) => (typeof v === 'string' ? v.slice(0, n) : null)
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g
/** One line of plain text: Playwright's colour codes and its multi-line call log collapse to a sentence. */
const oneLine = (v, n) => (typeof v === 'string' ? v.replace(ANSI, '').trim().replace(/\s*\n\s*/g, ' . ').replace(/\s+/g, ' ').slice(0, n) : null)

/** A check as the card shows it: name, pass or fail, one line of detail. Logs and pictures stay out. */
function slimCheck(c) {
  if (!c || typeof c !== 'object') return null
  return { name: str(c.name, 60) ?? '?', ok: c.ok === true, detail: oneLine(c.detail, 200) ?? '' }
}

/** The repository folder of a proposal: the last path segment of its `repo`. Null when it is not a safe name. */
export function repoOfProposal(profile) {
  const p = profile && typeof profile.repo === 'string' ? profile.repo.replace(/\/+$/, '') : ''
  const folder = p.split('/').pop() ?? ''
  return REPO_RE.test(folder) && !folder.startsWith('.') ? folder : null
}

export function createSetupState({ readFile, writeFile, now = () => Date.now() } = {}) {
  let running = null // { repo, name, step, good, cand, startedAt }
  let last = {} // by repo folder: { repo, name, step, ok, saved, startedAt, finishedAt, checks, error, usd }
  let loaded = false

  async function load() {
    if (loaded) return
    loaded = true
    if (typeof readFile !== 'function') return
    try {
      const j = JSON.parse(String(await readFile(STATE_FILE)))
      if (j && typeof j.last === 'object' && j.last) {
        for (const [repo, r] of Object.entries(j.last)) {
          if (!REPO_RE.test(repo) || !r || typeof r !== 'object') continue
          last[repo] = { ...r, checks: Array.isArray(r.checks) ? r.checks.map(slimCheck).filter(Boolean) : [] }
        }
      }
    } catch {
      last = {}
    }
  }

  async function persist() {
    if (typeof writeFile !== 'function') return
    try { await writeFile(STATE_FILE, JSON.stringify({ last }, null, 1)) } catch { /* the page still has it until a restart */ }
  }

  /** Records a step starting. Refuses a second step while one runs (the server already serialises them). */
  async function begin({ repo, name, step, good, cand } = {}) {
    await load()
    if (running) return { ok: false, error: `Another set-up step is running: ${running.step} for ${running.name}.` }
    if (!STEPS.has(step)) return { ok: false, error: `unknown step "${str(step, 20)}"` }
    if (typeof name !== 'string' || !APP_RE.test(name)) return { ok: false, error: 'invalid app name' }
    const folder = typeof repo === 'string' && REPO_RE.test(repo) && !repo.startsWith('.') ? repo : null
    running = { repo: folder, name, step, good: str(good, 60), cand: str(cand, 60), startedAt: now() }
    return { ok: true }
  }

  /** Records the step's result as the repo's last result and clears the step in progress. */
  async function end(result = {}) {
    await load()
    if (!running) return { ok: false, error: 'no step is running' }
    const r = running
    running = null
    const entry = {
      repo: r.repo, name: r.name, step: r.step, good: r.good, cand: r.cand, startedAt: r.startedAt, finishedAt: now(),
      ok: result.ok === true, saved: result.saved === true,
      checks: Array.isArray(result.checks) ? result.checks.map(slimCheck).filter(Boolean).slice(0, 12) : [],
      error: str(result.error, 300), usd: typeof result.usd === 'number' && Number.isFinite(result.usd) ? result.usd : null,
    }
    if (r.repo) last[r.repo] = entry
    await persist()
    return { ok: true, entry }
  }

  /** Everything a page needs: the step in progress (if any) and the last result per repo folder. */
  async function view() {
    await load()
    return { running: running ? { ...running } : null, last: { ...last } }
  }

  return { begin, end, view }
}

/** One line for a card or a sidebar row, from a repo's view. */
export function setupSummary(view, repo) {
  if (!view) return null
  const run = view.running
  if (run && run.repo === repo) {
    const what = run.step === 'propose' ? 'asking the model for a profile' : `verifying ${run.good ?? '?'} against ${run.cand ?? '?'}`
    return { state: 'running', text: `Setting up: ${what}.` }
  }
  const l = view.last && view.last[repo]
  if (!l) return null
  if (l.step === 'propose') {
    return l.ok
      ? { state: 'proposed', text: 'A profile was proposed and not yet verified. Open Set up this app to verify and save it.' }
      : { state: 'failed', text: `The proposal failed: ${l.error ?? 'no reason given'}.` }
  }
  const passed = l.checks.filter((c) => c.ok).length
  if (l.ok && l.saved) return { state: 'saved', text: `Verified and saved: ${passed} of ${l.checks.length} checks passed.` }
  const why = l.error ? ` ${l.error}` : ''
  return { state: 'failed', text: `Verification failed: ${passed} of ${l.checks.length} checks passed, nothing saved.${why}` }
}
