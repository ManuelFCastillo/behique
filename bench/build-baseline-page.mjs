#!/usr/bin/env node
// Builds bench/baseline.html: the planted defects, in plain language, with the exact code change and
// the latest result per model. Reads bench/mutations.json and the newest bench/runs/<model>-*/results.jsonl.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mutations = JSON.parse(readFileSync(join(ROOT, 'bench/mutations.json'), 'utf8'))
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// tags: ui = visible on the page, api = only through HTTP, reload = shows after a reload, edge = needs an unusual input,
// setup = needs state built up first (many rows).
const X = {
  'S1-insert-untrimmed': { title: 'Saved text keeps its leading and trailing spaces', notice: 'Send POST /api/todos with the text "  buy milk  ". The correct app stores "buy milk". The page trims before sending, so only a direct API call shows it.', tags: ['api', 'edge'] },
  'S2-blank-accepted': { title: 'The API accepts a blank todo', notice: 'Send POST /api/todos with "   " (spaces only). The correct app answers 400 "text is required". This one answers 201 and stores an empty todo. The page blocks blanks itself, so only the API shows it.', tags: ['api', 'edge'] },
  'S3-patch-missing-200': { title: 'Updating a todo that does not exist says it worked', notice: 'Send PATCH /api/todos/9999. The correct app answers 404. This one answers 200 {"ok":true}.', tags: ['api', 'edge'] },
  'S4-delete-missing-204': { title: 'Deleting a todo that does not exist says it worked', notice: 'Send DELETE /api/todos/9999. The correct app answers 404. This one answers 204 as if something was deleted.', tags: ['api', 'edge'] },
  'S5-patch-always-done': { title: 'A todo can never be marked not-done on the server', notice: 'Tick a todo, untick it, reload. The correct app shows it unticked. This one comes back ticked, because the server stores "done" every time.', tags: ['ui', 'reload', 'api'] },
  'S6-order-desc': { title: 'The list comes back newest first', notice: 'Add "first", then "second", then reload. The correct app lists first, second. This one lists second, first.', tags: ['ui', 'reload', 'api'] },
  'S7-post-200': { title: 'Creating a todo returns 200, not 201', notice: 'Watch the response to POST /api/todos. A created resource should answer 201 Created. This one answers 200. Nothing on the page changes.', tags: ['api'] },
  'S8-done-number': { title: '"done" comes back as 0 or 1 instead of false or true', notice: 'Read GET /api/todos. The correct response has "done":false. This one has "done":0. The page still works, because 0 and 1 behave like false and true in its code.', tags: ['api'] },
  'S9-delete-too-many': { title: 'Deleting one todo also deletes every older one', notice: 'Add four todos and delete the third, then reload. The correct app keeps the other three. This one deletes todos 1, 2 and 3. The page only removes one row at a time, so it looks fine until the reload.', tags: ['ui', 'reload', 'setup'] },
  'S10-error-message': { title: 'The blank-text error no longer says what is wrong', notice: 'Send a blank todo to the API. The correct body is {"error":"text is required"}. This one says {"error":"bad request"}.', tags: ['api', 'edge'] },
  'C1-login-any-password': { title: 'Logging in as admin works with any password', notice: 'Enter admin and the wrong password "nope". The correct app says "Invalid credentials". This one says "Welcome, admin!".', tags: ['ui', 'edge'] },
  'C2-login-needs-both': { title: 'Login only asks for both fields when both are empty', notice: 'Fill in a username and leave the password empty, then submit. The correct app says "Username and password are required". This one says "Invalid credentials".', tags: ['ui', 'edge'] },
  'C3-count-includes-done': { title: '"tasks remaining" counts finished tasks too', notice: 'Add two todos and tick one. The correct count drops to 1. This one still says 2.', tags: ['ui'] },
  'C4-delete-not-persisted': { title: 'A deleted todo comes back after a reload', notice: 'Delete a todo, then reload the page. The correct app does not bring it back. This one only removed the row from the screen, never from the database.', tags: ['ui', 'reload'] },
  'C5-toggle-not-persisted': { title: 'A ticked todo is forgotten after a reload', notice: 'Tick a todo, then reload. The correct app shows it still ticked. This one never told the server.', tags: ['ui', 'reload'] },
  'C6-input-not-cleared': { title: 'The "New task" box keeps its text after Add', notice: 'Type a task and press Add. The correct app empties the box. This one leaves the old text, ready to be added twice.', tags: ['ui'] },
  'C7-panel-cannot-close': { title: 'The panel opens but a second click does not close it', notice: 'Click "Toggle panel" twice. The correct app shows then hides the panel. This one shows it and keeps it open.', tags: ['ui'] },
  'C8-color-shouting': { title: 'The colour message is upper-cased', notice: 'Choose Red in the colour list. The correct app says "You chose red". This one says "You chose RED".', tags: ['ui'] },
  'C9-alert-text': { title: 'The alert says something different', notice: 'Click "Show alert". The correct text is "Hello from the page!". This one says "Hello!". A tester has to read the dialog and know the expected wording.', tags: ['ui'] },
  'H1-username-untrimmed': { title: 'A username with stray spaces no longer logs in', notice: 'Enter " admin " (with spaces) and the right password. The correct app trims the spaces and logs in. This one says "Invalid credentials".', tags: ['ui', 'edge'] },
  'H2-non-string-accepted': { title: 'The API accepts a number as the todo text', notice: 'Send POST /api/todos with {"text":123}. The correct app answers 400. This one stores "123".', tags: ['api', 'edge'] },
  'H3-ids-not-reset': { title: 'After a reset, new todos keep counting from the old numbers', notice: 'Needs the test-only POST /api/reset helper, which the running app does not expose. A black-box tester has no way to reach it, so it is excluded from the score.', tags: ['api', 'unreachable'], unreachable: true },
  'H4-two-digit-ids': { title: 'Todos numbered 10 and up cannot be updated or deleted', notice: 'Add ten or more todos, then tick or delete number 10. The correct app works. This one answers 404 for any id with two digits. It only appears once the list is long enough.', tags: ['ui', 'api', 'setup'] },
  'H5-content-type': { title: 'JSON answers are labelled as plain text', notice: 'Look at the response headers of any /api call. The correct type is application/json. This one says text/plain. The page still works.', tags: ['api'] },
  'H6-no-loading-state': { title: '"Loading..." never appears during the delayed load', notice: 'Click "Load data (delayed)" and look straight away. The correct app shows "Loading..." for about 1.5 seconds, then "Data loaded!". This one shows nothing until the end.', tags: ['ui', 'edge'] },
  'H7-empty-colour-message': { title: 'Picking the blank colour option shows "You chose "', notice: 'Choose Red, then switch back to "-- choose --". The correct app clears the message. This one shows "You chose " with nothing after it.', tags: ['ui', 'edge'] },
  'H8-empty-add-posts': { title: 'Adding an empty task creates a broken row', notice: 'Press Add with the box empty. The correct app does nothing. This one sends the empty task, gets an error back, and draws a row with no text.', tags: ['ui', 'edge'] },
  'H9-html-injection': { title: 'Todo text is treated as HTML', notice: 'Add a todo whose text is <b>hi</b>. The correct app shows the characters as typed. This one shows bold text, and text like <img onerror=...> would run script.', tags: ['ui', 'edge'] },
}
const TAGLABEL = { ui: 'on the page', api: 'API only', reload: 'after reload', edge: 'unusual input', setup: 'needs many rows', unreachable: 'not reachable' }

const FINAL = JSON.parse(readFileSync(join(ROOT, 'bench/final-results.json'), 'utf8'))
const mapOf = m => Object.fromEntries(Object.entries(FINAL.models[m].perMutation).map(([id, v]) => [id, v.detected ? 'found' : 'missed']))
const res = { meta: { map: mapOf('meta') }, baseten: { map: mapOf('baseten') } }
const SMOKE = new Set(['C1-login-any-password', 'S2-blank-accepted'])

const diffOf = m => {
  const cut = s => (s.length > 170 ? s.slice(0, 170) + '...' : s)
  return `<span class="file">${esc(m.file)}</span>\n<span class="del">- ${esc(cut(m.find))}</span>\n<span class="add">${m.replace === '' ? '<span class="gone">(that line is removed)</span>' : '+ ' + esc(cut(m.replace))}</span>`
}
const chip = (label, state) => {
  const t = state === 'found' ? ['found', '&#10003;'] : state === 'missed' ? ['missed', '&#10005;'] : ['not run yet', '&middot;']
  return `<span class="res ${state ?? 'pending'}"><i aria-hidden="true">${t[1]}</i><b>${label}</b> ${t[0]}</span>`
}

const layerOf = m => (m.file === 'server.js' ? 'server' : 'page')
const tiers = { S: 'First pass', C: 'First pass', H: 'Hidden' }
const rows = mutations.map(m => {
  const x = X[m.id]
  const code = m.id.split('-')[0]
  const state = k => (x.unreachable ? 'n/a' : res[k].map[m.id])
  const resCell = x.unreachable
    ? '<span class="res na"><i aria-hidden="true">&ndash;</i> not scored</span>'
    : chip('Meta', state('meta')) + chip('Baseten', state('baseten'))
  return `<li class="row" data-layer="${layerOf(m)}" data-meta="${state('meta') ?? 'pending'}" data-baseten="${state('baseten') ?? 'pending'}" id="${esc(m.id)}">
  <div class="rid"><span class="code">${esc(code)}</span><span class="layer">${layerOf(m)}</span></div>
  <div class="rbody">
    <h3>${esc(x.title)}</h3>
    <p>${esc(x.notice)}</p>
    <ul class="tags">${x.tags.map(t => `<li>${TAGLABEL[t]}</li>`).join('')}${SMOKE.has(m.id) ? '<li class="smoke">seen in smoke test</li>' : ''}</ul>
    <details><summary>The code change</summary><pre>${diffOf(m)}</pre><p class="small">${esc(m.id)}: ${esc(m.what)}</p></details>
  </div>
  <div class="rres">${resCell}</div>
</li>`
}).join('\n')

const _unused = (k, v) => mutations.filter(m => !X[m.id].unreachable && res[k].map[m.id] === v).length
const _unused2 = k => Object.keys(res[k].map).length
const reachable = mutations.filter(m => !X[m.id].unreachable).length
const server = mutations.filter(m => layerOf(m) === 'server').length
const M = FINAL.models.meta, B = FINAL.models.baseten
const pct = (a, b) => Math.round((100 * a) / b) + '%'
const trueRate = m => pct(m.cats.validated + m.cats.real_unplanted, m.cats.validated + m.cats.real_unplanted + (m.cats.false_alarm ?? 0))
const tr = (label, a, b, strong) => `<tr${strong ? ' class="strong"' : ''}><th scope="row">${label}</th><td>${a}</td><td>${b}</td></tr>`
const titleOf = id => X[id].title
const idList = ids => ids.length ? ids.map(i => `<a href="#${esc(i)}">${esc(i.split('-')[0])}</a>`).join(' ') : 'none'
const resultsHtml = `<div class="tablewrap"><table class="results">
<thead><tr><th scope="col"></th><th scope="col">Meta Spark 1.3</th><th scope="col">Baseten Spark Open</th></tr></thead><tbody>
${tr('Planted bugs found, of ' + M.scored, `${M.detected} (${pct(M.detected, M.scored)})`, `${B.detected} (${pct(B.detected, B.scored)})`, true)}
${tr('Leaving out the two used while tuning, of ' + M.heldOutOf, M.heldOut, B.heldOut)}
${tr('Server-code bugs, of ' + M.server.of, M.server.detected, B.server.detected)}
${tr('Page-code bugs, of ' + M.page.of, M.page.detected, B.page.detected)}
${tr('Reports made in all runs', M.findings, B.findings, true)}
${tr('&nbsp;&nbsp;the planted bug, reproduced', M.cats.validated, B.cats.validated)}
${tr('&nbsp;&nbsp;a real bug nobody planted', M.cats.real_unplanted, B.cats.real_unplanted)}
${tr('&nbsp;&nbsp;a false alarm', M.cats.false_alarm ?? 0, B.cats.false_alarm ?? 0)}
${tr('&nbsp;&nbsp;did not reproduce, dropped', M.cats.not_reproduced ?? 0, B.cats.not_reproduced ?? 0)}
${tr('&nbsp;&nbsp;replay error', M.cats.error ?? 0, B.cats.error ?? 0)}
${tr('Reports that were true, among those that reproduced', trueRate(M), trueRate(B), true)}
${tr('Clean-app runs with a false alarm, of ' + M.clean.length, M.cleanRunsWithFalseAlarm, B.cleanRunsWithFalseAlarm)}
${tr('Runs stopped by the 20-step cap, of ' + M.runs, M.capped, B.capped)}
${tr('Average time per run', Math.round(M.secs / M.runs) + ' s', Math.round(B.secs / B.runs) + ' s')}
${tr('Estimated cost of all runs', '$' + M.cost.toFixed(2), '$' + B.cost.toFixed(2))}
</tbody></table></div>
<ul class="overlap">
<li><b>Found by both (${FINAL.overlap.both.length}):</b> ${idList(FINAL.overlap.both)}</li>
<li><b>Only Meta (${FINAL.overlap.metaOnly.length}):</b> ${idList(FINAL.overlap.metaOnly)}</li>
<li><b>Only Baseten (${FINAL.overlap.basetenOnly.length}):</b> ${idList(FINAL.overlap.basetenOnly)}</li>
<li><b>Found by neither (${FINAL.overlap.neither.length}):</b> ${idList(FINAL.overlap.neither)}</li>
</ul>`
const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' })

execFileSync('sips', ['-Z', '440', '--setProperty', 'format', 'jpeg', '--setProperty', 'formatOptions', '72', '/Users/mcastillo/Downloads/Behique/GR-B.png', '--out', '/tmp/behique-logo.jpg'], { stdio: 'ignore' })
const logo = 'data:image/jpeg;base64,' + readFileSync('/tmp/behique-logo.jpg').toString('base64')

const html = readFileSync(join(ROOT, 'bench/baseline.template.html'), 'utf8')
  .replace('%%LOGO%%', logo).replace('%%ROWS%%', rows).replace('%%STAMP%%', esc(stamp))
  .replaceAll('%%TOTAL%%', String(mutations.length)).replaceAll('%%REACHABLE%%', String(reachable))
  .replaceAll('%%SERVER%%', String(server)).replaceAll('%%PAGE%%', String(mutations.length - server))
  .replace('%%RESULTS%%', resultsHtml)
writeFileSync(join(ROOT, 'bench/baseline.html'), html)
console.log('wrote bench/baseline.html', html.length, 'bytes')
