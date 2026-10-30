---
part: crawl-run
owns:
  - src/release/crawl/run.mjs
  - src/release/crawl/run.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/session.mjs
  - src/release/crawl/enumerate.mjs
  - src/release/crawl/plan.mjs
  - src/release/facts.mjs
test: node --test src/release/crawl/run.test.mjs
allow: [external_network]
---
# Part 18: the crawler

This part connects the two pure parts (`enumerate.mjs` decides what is worth clicking, `plan.mjs` keeps the bookkeeping) to a real browser. It opens a running app, explores it breadth first
without changing anything, and returns the click paths that reached new page states, as a list of steps a release check can replay on any version of the app. It never calls a model.

## `run.mjs` must export `crawlApp(base, options) -> Promise<result>`

`base` is the app's origin and base path, for example `http://127.0.0.1:8301` (no trailing slash). Options:
`{ startPath = '/', viewport = { width: 1280, height: 900 }, maxDepth = 2, maxPaths = 40, maxPerPage = 12, maxFlows = 8, budgetMs = 120000, log = () => {} }`.

Use `Session` from `src/session.mjs` for every page, exactly the way `recordRun` in `facts.mjs` does (`new Session(base, { viewport })`, `await s.open()`, `await s.act(action)`, `await s.close()` in `finally`), so the actions replay with the same semantics in the release check.
Create the planner with `createPlanner({ maxDepth, maxPaths, maxPerPage })`. Loop until `next()` returns `null` or the budget is used up:

1. Take `path = planner.next()`. Open a fresh `Session`. If `startPath` is not `/`, perform `{ type: 'goto', path: startPath }` first. Install the safety rules below. Replay the path's actions with `s.act`. If any action throws, call `planner.failed(path)`, close, and go on.
2. After the replay wait for the page to settle: `waitForLoadState('networkidle')` with a 2 second cap (ignore its failure), then 300 ms.
3. Read the interactive elements with ONE `page.evaluate` call that returns an array of descriptions in the shape defined in part 16 (`tag, role, name, href, type, disabled, visible, inForm, formMethod, download, path, nth, x, y, w, h`).
   Look at `a[href], button, summary, input, select, textarea, [role], [tabindex], [onclick]`. `role` is the `role` attribute or the implied one (`a[href]` link, `button` button, `summary` summary, `input` by its type: checkbox, radio, otherwise textbox, `select` combobox, `textarea` textbox).
   `name` is the first non-empty of `aria-label`, `aria-labelledby` text, the element's own visible text, `title`, `alt` of an image inside, `placeholder`, `value` for buttons. `visible` means a non-empty box that is not `visibility:hidden` or `display:none` (`checkVisibility` when available) and inside the document. `path` is a CSS path of `tag:nth-of-type(n)` steps from `body`.
   `nth` is the zero-based index among the returned elements that share the same `role` and cleaned `name`. At most 400 elements are read. Resolve `href` to an absolute URL.
4. `state = { key: stateKey(page.url(), descs), url: page.url(), title: await page.title(), candidates: candidates(descs, { origin: new URL(base).origin, perPage: maxPerPage }) }`; `planner.report(path, state)`.
5. Verify the candidates: for each candidate of a NEW state, the selector must resolve (`page.locator(selector).count() >= 1`) and its first match must be the intended element (compare the CSS path of the first match with the description's `path`); a candidate that fails this check is replaced by `css=<path>` as its selector. Do this before `report` so that the planner queues the verified selectors.

At the end return `{ steps, flows, states, stats, stoppedBy, ms }` where `flows = planner.flows({ max: maxFlows })`, `steps = planner.toSteps(flows, { startPath })`, `states = planner.states()`, `stats = planner.stats()` and `stoppedBy` is `'done'`, `'budget'` or `'paths'` (when `maxPaths` stopped the queueing). `log` receives one short line per path tried.

### Safety rules (the crawl must never change the app)

- Every request that is not `GET` or `HEAD` is aborted: `await s.ctx.route('**/*', route => (['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort()))`, installed right after `s.open()`.
- A request to an origin other than the app's is aborted too (the app is explored in isolation).
- Dialogs are dismissed, not accepted: `Session` accepts them by default, so in the crawl register `s.page.on('dialog', d => d.dismiss().catch(() => {}))` BEFORE replaying (the first listener to handle a dialog wins, so also call `s.page.removeAllListeners('dialog')` first and register only the dismiss one).
- Each path uses a new `Session` (a new browser), so cookies and local storage never carry over.
- The crawl does not type into fields and does not press keys: it only clicks the elements `candidates` returns.

## Tests (offline, a real Chromium against a local fixture server the test starts)

Start an `http.createServer` on `127.0.0.1` with port 0 serving these pages and recording every request (method and path):
- `/`: a heading, a nav with links `About` (to `/about`) and `Products` (to `/products`), a button `Menu` that, when clicked, reveals a link `Settings` (to `/settings`) by script (no navigation), a button `Delete all` that sends `fetch('/api/delete', { method: 'POST' })`, a link `Docs` to `http://example.invalid/`, and a `mailto:` link.
- `/about`, `/settings`: a heading and a link back to `/`.
- `/products`: three elements with `role="tab"` named `Red`, `Green`, `Blue`; clicking a tab shows a different paragraph by script.
- `/api/delete`: answers 200 and sets a flag `deleted = true` when it receives a POST (the test asserts it never happens).
Assert: the result has steps that click `About`, `Products` and the `Menu` then `Settings` flow and at least one of the tabs; no step clicks `Delete all`, `Docs` or the mailto link; the server saw no request other than GET (and no request at all for `example.invalid`) and `deleted` is false; `states` has at least 5 entries with distinct keys; a second run returns exactly the same `steps` (determinism); every step list replays without error on a fresh `Session` (use `s.act` for each one); `maxPaths: 3` stops early with `stoppedBy: 'paths'` and returns at most 3 tried paths; `budgetMs: 1` returns `stoppedBy: 'budget'` without throwing; a path whose element disappears (simulate by making the page remove the button on the second load) is counted in `stats.failed` and does not stop the crawl; the steps list has a `goto` between flows and never two in a row. Close the server in `after`.
