# Behique in CI: the command and the GitHub Action

## The command

```
node bin/behique.mjs check <app> <good> <cand> [--bisect] [--max-findings 5] [--recrawl] [--profile file.json --repo path] [--out file] [--json]
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

Inputs: `profile` (default `.behique/profile.json`), `app`, `good` and `cand` (default: the pull request's base and head commits), `bisect`, `max-findings`, `sandbox` (`docker` on the runner's engine, or `off` for static profiles), `comment`, `fail-on-hold`, `github-token`. Outputs: `recommendation` and `result` (the JSON path). The Markdown also lands in the job summary.

What the comment holds: the recommendation and its one-line reason, the findings most noticeable first with their class (a person would notice, or markup churn), what changed, where, both values and the verdict; the first bad commit when a bisect ran; what the check could not see (masked facts and where they sit); the case id. Links to the dashboard are left out in CI (`--no-dashboard`) because the dashboard runs on the machine that ran the check.

The profile: copy the one the dashboard saved for the app (`src/release/onboard/profiles/<app>.json`) into the repository as `.behique/profile.json`. Its `repo` and `workRoot` fields are replaced by the action with the runner's checkout, so they can be anything.

## Limits

- Not run on GitHub's runners yet: the action was written and its command tested here (unit tests, a real `check` on a saved app, and `comment --dry-run`). The first real run on a runner will show what the runner's Docker engine and 7 GB of memory allow; a Next.js build in the sandbox may need the memory limit lowered (`BEHIQUE_SANDBOX_MEMORY_MB`).
- A check takes 2 to 10 minutes on a warm cache and longer on a cold one; the cache lives on the runner and is gone with it unless the job restores it (not built: a Docker image cache step).
- The comment is posted with the workflow's token, so it appears as `github-actions`. Posting needs `pull-requests: write`.
- No ground truth: "confirmed" means the test reproduces, not that the change matters; the class says whether a person would notice. A person still decides, in the dashboard or by reading the comment.
