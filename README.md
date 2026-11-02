# Behique

Release verification for web apps. Give it a known-good version and a candidate; it builds both, walks the app along click paths it found on its own, records what each page says and does, and turns every difference into a Playwright test that must pass on the good version and fail on the candidate, run after run, on fresh builds. With `--bisect` it then finds the first commit that makes the test fail. The result is a recommendation (SHIP, HOLD, REVIEW) with the evidence behind it, in a dashboard, on the command line, or as a comment on a pull request.

A model proposes, code verifies, a person approves. The pipeline makes no model calls. The one optional model call (a hypothesis about the culprit commit) shows its exact text and cost before it is sent.

## Start

```bash
npm install && npx playwright install chromium
npm start
```

That opens the dashboard at http://127.0.0.1:8790/dashboard. From there: set up an app from a git repository (Behique inspects it, proposes how to install, build and serve it, and asks you to approve each command), run a check between two versions, read the report, and record your Ship or Hold decision with a reason.

Apps that run a repository's own code are run in a Docker sandbox, on this machine's engine or on another host over ssh (Settings in the dashboard, or `BEHIQUE_SANDBOX=docker` / `docker:ssh://host`). Static sites can run without one. Details and measurements: [docs/sandbox.md](docs/sandbox.md).

## The command

```bash
node bin/behique.mjs check <app> <good> <cand> [--bisect] [--max-findings 5] [--recrawl]
```

`<app>` is an app set up in the dashboard (a profile under `src/release/onboard/profiles/`); `<good>` and `<cand>` are tags, branches or commits. The command streams the pipeline's own log, prints the result as Markdown, writes it as JSON and Markdown under `out/check/`, and exits 0 for SHIP, 1 for HOLD, 2 for REVIEW, 3 when the evidence is incomplete. `npm link` puts it on the path as `behique`.

In CI, the composite action at [action.yml](action.yml) runs the same check on a pull request's base and head and posts the verdict as a comment that is updated on later runs. A profile checked into the repository under test is all it needs:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: ManuelFCastillo/behique@main
  with:
    profile: .behique/profile.json
    app: my-app
```

The command and the Action, their inputs, exit codes and limits: [docs/ci.md](docs/ci.md).

## What a report means

- **SHIP**: nothing changed in the recorded steps, or every proven change is markup churn (generated ids, framework attributes, hashed asset names) that no person would notice.
- **HOLD**: at least one change a person would notice was reproduced by a test: text, a link or form target, a control's state, the page scrolling differently, an element that is gone. The test passed every run on the good version and failed every run on the candidate, each run on a fresh build. With `--bisect`, the first commit that makes it fail is named, and the commit before it is checked too.
- **REVIEW**: differences were seen but no test could reproduce them reliably, so a person has to look.
- **Incomplete**: the noise filter could not be trusted, a build failed, or the run was cut short. Nothing is recommended on incomplete evidence.

Findings are ranked by whether a person would notice them, so the first finding is the one to read and the bisect follows it. Each report also says what the check could not see: how many recorded facts were masked as noise (values that differ between two runs of the same version) and where on the page they sit. A change inside a masked fact is invisible to the check, and the report says so rather than claiming coverage it does not have.

Every run is an evidence case under `out/evidence/<case>/`: a hash-chained event log and the artifacts (facts, diffs, tests, test runs, screenshots, the bisect log) by content hash. Claims are labelled by how they were established (a verified fact, a reproduced failure, a statistical observation, or a hypothesis from a model), and the report page shows each claim with the artifact that backs it.

## Limits

- Apps behind a login or needing data: a profile can declare a `login` step (the password comes from the environment, or a documented public default; it is never written to the record), `serve.prepare` commands that run before every start (migrations), and `seed` files for the sandbox's database sidecars. Without those, the crawl sees what an anonymous visitor sees. The seed-file path has not yet been run end to end.
- Facts are attributes, class lists, text, scroll position, whether an area can scroll, and pictures. A class change counts as something a person would notice only when a class that shows, hides or scrolls comes or goes (`overflow-hidden`, `hidden`, `d-none` and the like); any other class change is reported as churn, and a general style change shows in the pictures. Console errors, failed requests and accessibility names are not recorded yet.
- "Confirmed" means the test reproduces, not that the change matters. The class (a person would notice, or markup churn) is a rule, not a judgment; a person decides.
- Third-party content (images and media from other hosts) is excluded from findings, since it changes on its own.
- A check takes from under a minute (a static site, warm cache) to about ten minutes (a Next.js app, with bisect) on the measured apps; see [docs/speed-plan.md](docs/speed-plan.md). The GitHub Action has not been run on GitHub's own runners yet.

## Tests

```bash
node --test $(find src -name "*.test.mjs" -not -path "*/senses/*")
```

849 tests, no network, no model calls (the crawl's own test launches a browser against a local fake site and takes a few minutes). The canvas senses have their own tests under `src/senses/`, which launch a browser.

## More

- [docs/STATUS.md](docs/STATUS.md): what is built, what was measured, known limits.
- [docs/CHECKLIST.md](docs/CHECKLIST.md): done, left, and what is next.
- [docs/sandbox.md](docs/sandbox.md), [docs/speed-plan.md](docs/speed-plan.md), [docs/ci.md](docs/ci.md), [docs/canvas-senses-plan.md](docs/canvas-senses-plan.md).
