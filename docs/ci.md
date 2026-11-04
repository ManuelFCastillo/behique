# Behique in CI: the command and the GitHub Action

## The command

```
node bin/behique.mjs check <app> <good> <cand> [--bisect [--explain]] [--ai | --ai-tests --ai-flows --ai-describe --ai-triage] [--ai-canvas] [--ai-budget 0.25] [--max-findings 5] [--recrawl] [--profile file.json --repo path] [--out file] [--json]
node bin/behique.mjs comment --result out/check/<case>.json --repo owner/name --pr 12 [--dry-run]
```

`npm link` (or installing the package) puts it on the path as `behique`.

`check` runs the same pipeline as the dashboard's "Check: Behaviour": crawl the good version for click paths (reused when the same commit was crawled before), record both versions along them, prove each changed fact with a test that must pass every run on the good version and fail every run on the candidate, take screenshots, and with `--bisect` find the first commit that makes the test fail. It streams the pipeline's own lines, then prints the result as Markdown, writes `<case>.json` and `<case>.md` under `out/check/` (or `--out`), and exits:

| Exit | Recommendation | Meaning |
|---|---|---|
| 0 | SHIP | nothing changed in the recorded steps, or every proven change is markup churn (generated ids, framework attributes) |
| 1 | HOLD | at least one proven change a person would notice |
| 2 | REVIEW | changes were seen but not proven by a repeatable test |
| 3 | incomplete | the noise filter could not be trusted, a build failed, the run was cancelled or produced no evidence |

`<app>` is a saved profile (the dashboard's "Set up an app", or `src/release/onboard/profiles/`). With `--profile file.json --repo path`, the profile comes from the repository under test and is pointed at that checkout; it is saved under `out/profiles/` for this run only. The sandbox is chosen by `BEHIQUE_SANDBOX` exactly as for the dashboard (`docker`, `docker:ssh://host`, or unset for this machine, which only static profiles may use).

`comment` posts the Markdown of a result as one comment on a pull request through `gh api`, with `GH_TOKEN` or the `gh` login, and updates that same comment on later runs (it is marked with `<!-- behique-check -->`). `--dry-run` prints the body and posts nothing.

## The AI flags (all opt-in, all after the verdict)

Without an AI flag a check makes no model call. With one, the verdict and the exit code are computed first, from tests that ran; the AI stages then run against the finished case and add a separate section, titled "AI guesses (a model wrote these; none of it changes the verdict or the exit code)", to the Markdown, the JSON (`ai`) and the pull request comment. The recommendation, the exit code and every finding are taken before the stages run, and `src/release/cli/ai-stages.test.mjs` proves they are identical with and without the flags.

| Flag | Stage | What the model does | What code does with it |
|---|---|---|---|
| `--explain` (with `--bisect`) | ask why | one guess about the first bad commit | checks its quoted line is in the diff |
| `--ai-tests` | `src/release/aitest.mjs` | writes a readable Playwright test for each proven difference | runs it on fresh builds of both versions; keeps it only if it passes on good and fails on candidate |
| `--ai-flows` | `src/release/crawl/propose-flows.mjs` | proposes multi-step click paths the read-only crawl cannot reach | validates, refuses unsafe steps, replays on the good version; keeps only stable ones |
| `--ai-describe` | `src/release/visual/describe.mjs` | describes what differs in the screenshots | checks each described place really changed in the pixels |
| `--ai-triage` | `src/release/triage.mjs` | ranks the differences no test could prove | nothing: it is a ranking, shown as unverified |
| `--ai` | the four stages above | | |
| `--ai-canvas` (not part of `--ai`) | `src/release/cli/canvas-senses.mjs` | lists the controls in one screenshot of a canvas app | clicks every control by code on both versions, twice, in fresh browsers |

`--ai-budget <usd>` (default 0.25, at most 10) caps everything AI in the run, `--explain` included. Every call is checked against it before it is sent and recorded in the case as a `model.call` event with the model, tokens and estimated cost; the stage's output is saved as `ai-<stage>.json` evidence. A stage whose module is not in this build, or that fails, is listed as skipped or failed with the reason; it never stops the check or changes its exit code. The model is Meta Muse Spark 1.3 through `src/llm.mjs` and needs `META_API_KEY`. Each stage sends different data (see `docs/model-use.md`); `--ai-describe` and `--ai-canvas` send screenshots, which is why they are opt-in and why `--ai-canvas` refuses an app whose repository GitHub does not confirm as public.

## The GitHub Action

`action.yml` at the root of this repository is a composite action. In the repository under test:

```yaml
# .github/workflows/behique.yml
name: Behique
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # both the base and the head commit must be in the checkout
      - uses: ManuelFCastillo/behique@main
        with:
          profile: .behique/profile.json
          app: my-app
          bisect: "true"
```

Inputs: `profile` (default `.behique/profile.json`), `app`, `good` and `cand` (default: the pull request's base and head commits), `bisect`, `explain` and `meta-api-key`, `ai`, `ai-tests`, `ai-flows`, `ai-describe`, `ai-triage`, `ai-canvas` and `ai-budget` (see above; all default off), `max-findings`, `sandbox` (`docker` on the runner's engine, or `off` for static profiles), `comment`, `fail-on-hold`, `github-token`. Outputs: `recommendation` and `result` (the JSON path). The Markdown also lands in the job summary.

What the comment holds: the recommendation and its one-line reason, the findings most noticeable first with their class (a person would notice, or markup churn), what changed, where, both values and the verdict; the first bad commit when a bisect ran; when an AI flag was used, the "AI guesses" section (each item with the model that wrote it, the stage's cost and what code checked about it); what the check could not see (masked facts and where they sit); the case id. Links to the dashboard are left out in CI (`--no-dashboard`) because the dashboard runs on the machine that ran the check.

The profile: copy the one the dashboard saved for the app (`src/release/onboard/profiles/<app>.json`) into the repository as `.behique/profile.json`. Its `repo` and `workRoot` fields are replaced by the action with the runner's checkout, so they can be anything.

## Limits

- Not run on GitHub's runners yet: the action was written and its command tested here (unit tests, a real `check` on a saved app, and `comment --dry-run`). The first real run on a runner will show what the runner's Docker engine and 7 GB of memory allow; a Next.js build in the sandbox may need the memory limit lowered (`BEHIQUE_SANDBOX_MEMORY_MB`).
- A check takes 2 to 10 minutes on a warm cache and longer on a cold one; the cache lives on the runner and is gone with it unless the job restores it (not built: a Docker image cache step).
- The comment is posted with the workflow's token, so it appears as `github-actions`. Posting needs `pull-requests: write`.
- No ground truth: "confirmed" means the test reproduces, not that the change matters; the class says whether a person would notice. A person still decides, in the dashboard or by reading the comment.
