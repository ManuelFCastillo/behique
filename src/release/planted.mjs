// A tiny static app with one known change per candidate, plus a scorer.
// Run tests with: node --test src/release/planted.test.mjs
const BUILD_COMMENT = '<!-- build 1 -->'
const NOOP_COMMENT = '<!-- build 2 -->'

function indexHtml() {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Planted Home</title>',
    '<link rel="stylesheet" href="/style.css">',
    '</head>',
    '<body>',
    BUILD_COMMENT,
    '<h1>Planted Home</h1>',
    '<nav><a href="/about.html" title="About this site">About</a> <a href="/list.html">List</a></nav>',
    '<button id="count" data-step="1" aria-label="Increase the counter">Count: <span id="n">0</span></button>',
    '<button id="reset" type="button">Reset</button>',
    '<div>',
    '<button role="tab" aria-selected="true">One</button>',
    '<button role="tab" aria-selected="false">Two</button>',
    '<div role="tabpanel">Panel one text</div>',
    '<div role="tabpanel" hidden>Panel two text</div>',
    '</div>',
    '<details><summary>More info</summary><p>Hidden details text</p></details>',
    '<script>',
    'var n = document.getElementById("n");',
    'var count = document.getElementById("count");',
    'var reset = document.getElementById("reset");',
    'var tabs = Array.prototype.slice.call(document.querySelectorAll(\'[role="tab"]\'));',
    'var panels = Array.prototype.slice.call(document.querySelectorAll(\'[role="tabpanel"]\'));',
    'count.addEventListener("click", function () {',
    '  var step = Number(count.getAttribute("data-step"));',
    '  n.textContent = String(Number(n.textContent) + step);',
    '});',
    'reset.addEventListener("click", function () {',
    '  n.textContent = "0";',
    '});',
    'tabs.forEach(function (tab, i) {',
    '  tab.addEventListener("click", function () {',
    '    tabs.forEach(function (t, j) { t.setAttribute("aria-selected", j === i ? "true" : "false"); });',
    '    panels.forEach(function (p, j) { if (j === i) { p.removeAttribute("hidden"); } else { p.setAttribute("hidden", ""); } });',
    '  });',
    '});',
    '</script>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

function aboutHtml() {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>About Planted</title>',
    '<link rel="stylesheet" href="/style.css">',
    '</head>',
    '<body>',
    BUILD_COMMENT,
    '<h1>About</h1>',
    '<p>This is the about page.</p>',
    '<a href="/">Home</a>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

function listHtml() {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Planted List</title>',
    '<link rel="stylesheet" href="/style.css">',
    '</head>',
    '<body>',
    BUILD_COMMENT,
    '<h1>Planted list</h1>',
    '<a href="/">Home</a>',
    '<ul>',
    '<li data-id="item-1">First item</li>',
    '<li data-id="item-2">Second item</li>',
    '<li data-id="item-3">Third item</li>',
    '<li data-id="item-4">Fourth item</li>',
    '</ul>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

function styleCss() {
  return [
    'body { background: #ffffff; }',
    'h1 { color: #111111; }',
    'nav a { margin-right: 8px; }',
    'button { font-size: 16px; }',
    ''
  ].join('\n')
}

export function buildBaseApp() {
  return {
    files: {
      'index.html': indexHtml(),
      'about.html': aboutHtml(),
      'list.html': listHtml(),
      'style.css': styleCss()
    }
  }
}

export const MUTATIONS = [
  {
    id: 'data-attr',
    kind: 'attribute',
    file: 'list.html',
    find: 'data-id="item-2"',
    replace: 'data-id="item-2-changed"',
    expectDetected: true,
    why: 'The second list item carries a different data id.'
  },
  {
    id: 'heading-text',
    kind: 'text',
    file: 'list.html',
    find: '<h1>Planted list</h1>',
    replace: '<h1>Planted list (new)</h1>',
    expectDetected: true,
    why: 'The list page heading shows new text.'
  },
  {
    id: 'link-title',
    kind: 'attribute',
    file: 'index.html',
    find: 'title="About this site"',
    replace: 'title="About us"',
    expectDetected: true,
    why: 'The About link shows a different title attribute.'
  },
  {
    id: 'remove-item',
    kind: 'removal',
    file: 'list.html',
    find: '<li data-id="item-3">Third item</li>',
    replace: '',
    expectDetected: true,
    why: 'The third list item is removed from the list.'
  },
  {
    id: 'counter-step',
    kind: 'behaviour',
    file: 'index.html',
    find: 'data-step="1"',
    replace: 'data-step="2"',
    expectDetected: true,
    why: 'The counter button adds two per click instead of one.'
  },
  {
    id: 'aria-label',
    kind: 'attribute',
    file: 'index.html',
    find: 'aria-label="Increase the counter"',
    replace: 'aria-label="Add one"',
    expectDetected: true,
    why: 'The counter button exposes a different accessible label.'
  },
  {
    id: 'reset-disabled',
    kind: 'attribute',
    file: 'index.html',
    find: '<button id="reset" type="button">',
    replace: '<button id="reset" type="button" disabled>',
    expectDetected: true,
    why: 'The reset button starts out disabled.'
  },
  {
    id: 'panel-text',
    kind: 'text',
    file: 'index.html',
    find: 'Panel two text',
    replace: 'Panel two text (new)',
    expectDetected: true,
    why: 'The second tab panel shows new text.'
  },
  {
    id: 'background',
    kind: 'visual',
    file: 'style.css',
    find: 'background: #ffffff;',
    replace: 'background: #f0f0f0;',
    expectDetected: false,
    why: 'The page background uses a slightly different shade.'
  }
]

function countOccurrences(text, find) {
  if (find === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(find, from)
    if (at === -1) return count
    count += 1
    from = at + find.length
  }
}

export function applyMutation(files, id) {
  const mutation = MUTATIONS.find((m) => m.id === id)
  if (!mutation) return { ok: false, error: 'Unknown mutation id: ' + String(id) + '.' }
  const current = files?.[mutation.file]
  if (typeof current !== 'string') return { ok: false, error: 'Missing file for mutation: ' + mutation.file + '.' }
  const times = countOccurrences(current, mutation.find)
  if (times !== 1) return { ok: false, error: 'Expected one match for mutation ' + mutation.id + ' but found ' + times + '.' }
  const next = { ...files }
  next[mutation.file] = current.replace(mutation.find, mutation.replace)
  return { ok: true, files: next }
}

export function planHistory() {
  const base = buildBaseApp().files
  const history = [{ tag: 'base', message: 'Planted app: base', files: { ...base }, mutation: null }]
  for (const m of MUTATIONS) {
    const applied = applyMutation(base, m.id)
    if (!applied.ok) throw new Error('Cannot plan mutation ' + m.id + ': ' + applied.error)
    history.push({ tag: 'm-' + m.id, message: 'Planted change: ' + m.id, files: applied.files, mutation: m.id })
  }
  const noopFiles = {}
  for (const [path, text] of Object.entries(base)) {
    noopFiles[path] = text.split(BUILD_COMMENT).join(NOOP_COMMENT)
  }
  history.push({ tag: 'noop', message: 'Planted app: comment only', files: noopFiles, mutation: null })
  return history
}

const ERROR_OUTCOMES = new Set(['build_failed', 'crawl_failed', 'no_steps', 'timeout', 'error'])

function round2(value) {
  return Math.round(value * 100) / 100
}

function byTag(tag) {
  if (tag === 'noop') return { id: 'noop', kind: 'noop', expectDetected: false, isNoop: true }
  if (typeof tag === 'string' && tag.startsWith('m-')) {
    const id = tag.slice(2)
    const mutation = MUTATIONS.find((m) => m.id === id)
    if (mutation) return { id: mutation.id, kind: mutation.kind, expectDetected: mutation.expectDetected, isNoop: false }
  }
  return null
}

export function scorePlanted(results) {
  const list = Array.isArray(results) ? results : []
  const seen = new Map()
  for (const r of list) {
    if (!r || typeof r.tag !== 'string') continue
    if (!byTag(r.tag)) continue
    if (!seen.has(r.tag)) seen.set(r.tag, r)
  }
  const rows = []
  for (const m of MUTATIONS) {
    const tag = 'm-' + m.id
    const r = seen.get(tag)
    if (!r) {
      rows.push({ tag, id: m.id, kind: m.kind, expectDetected: m.expectDetected, status: 'not_run', detected: false, confirmedAsTest: false })
      continue
    }
    if (ERROR_OUTCOMES.has(r.outcome)) {
      rows.push({ tag, id: m.id, kind: m.kind, expectDetected: m.expectDetected, status: 'error', detected: false, confirmedAsTest: false })
      continue
    }
    if (Number(r.controlDifferences) > 0) {
      rows.push({ tag, id: m.id, kind: m.kind, expectDetected: m.expectDetected, status: 'inconclusive', detected: false, confirmedAsTest: false })
      continue
    }
    const detected = Number(r.candidateDifferences) > 0
    const confirmedAsTest = Number(r.confirmed) > 0
    rows.push({ tag, id: m.id, kind: m.kind, expectDetected: m.expectDetected, status: detected ? 'found' : 'missed', detected, confirmedAsTest })
  }
  const noopResult = seen.get('noop')
  let noopRow = null
  if (noopResult) {
    if (ERROR_OUTCOMES.has(noopResult.outcome)) {
      noopRow = { tag: 'noop', id: 'noop', kind: 'noop', expectDetected: false, status: 'error', detected: false, confirmedAsTest: false }
    } else if (Number(noopResult.controlDifferences) > 0) {
      noopRow = { tag: 'noop', id: 'noop', kind: 'noop', expectDetected: false, status: 'inconclusive', detected: false, confirmedAsTest: false }
    } else {
      const detected = Number(noopResult.candidateDifferences) > 0
      const confirmedAsTest = Number(noopResult.confirmed) > 0
      noopRow = { tag: 'noop', id: 'noop', kind: 'noop', expectDetected: false, status: detected ? 'found' : 'missed', detected, confirmedAsTest }
    }
    rows.push(noopRow)
  }

  const rateRows = rows.filter((r) => r.expectDetected === true && (r.status === 'found' || r.status === 'missed'))
  const found = rateRows.filter((r) => r.status === 'found').length
  const missed = rateRows.filter((r) => r.status === 'missed').length
  const denom = found + missed
  const detectionRate = denom === 0 ? null : round2(found / denom)
  const confirmedCount = rateRows.filter((r) => r.confirmedAsTest).length
  const confirmRate = denom === 0 ? null : round2(confirmedCount / denom)

  let falsePositives = null
  if (noopRow) {
    if (noopRow.status === 'found') falsePositives = 1
    else if (noopRow.status === 'missed') falsePositives = 0
    else falsePositives = null
  }

  const blindSpotsConfirmed = rows.filter((r) => r.expectDetected === false && r.detected === true).length
  const errors = rows.filter((r) => r.status === 'error').length
  const inconclusive = rows.filter((r) => r.status === 'inconclusive').length
  const notRun = rows.filter((r) => r.status === 'not_run').length

  const lines = []
  for (const r of rows) {
    let line = r.tag + ': ' + r.status + ' (' + r.kind + ')'
    if (r.detected) line += ' detected'
    if (r.confirmedAsTest) line += ' confirmed as a test'
    if (r.expectDetected === false && r.status !== 'not_run') line += ' expected to be invisible to facts'
    lines.push(line)
  }
  const pct = (v) => (v === null ? 'n/a' : String(Math.round(v * 100)))
  lines.push('detection rate: ' + pct(detectionRate) + '%')
  lines.push('confirmed as a test: ' + pct(confirmRate) + '%')
  const fpText = falsePositives === null ? 'not measured' : (falsePositives === 1 ? 'yes' : 'no')
  lines.push('false positive on the comment-only change: ' + fpText)
  lines.push('errors: ' + errors + ', inconclusive: ' + inconclusive + ', not run: ' + notRun)

  return { rows, detectionRate, confirmRate, falsePositives, blindSpotsConfirmed, errors, inconclusive, notRun, lines: lines.join('\n') }
}
