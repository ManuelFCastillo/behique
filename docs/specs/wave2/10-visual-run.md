---
part: visual-run
owns:
  - src/release/ui/visual-run.mjs
  - src/release/ui/visual-run.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/runparams.mjs
  - src/release/visual/check.mjs
  - src/release/onboard/profile.mjs
test: node --test src/release/ui/visual-run.test.mjs
allow: []
---
# Part 10: start a visual check from the dashboard

The dashboard starts release checks with `POST /api/ui/runs`, which validates the request (see `runparams.mjs`), spawns a background process and shows its progress.
This part is the pure logic for doing the same for the VISUAL check (`src/release/visual/check.mjs`). The server wiring is done by a person afterwards: you write
only functions with injected collaborators, no spawning, no file access, no network, so every test is offline. Everything in a request comes from a web page and is untrusted.

## `visual-run.mjs` must export

### `validateVisualRun(input, { listProfiles, loadProfile, git }) -> Promise<{ ok: true, params, note } | { ok: false, error }>`
`input` is `{ app, goodRef, candRef, bisect, region }` (any field may be missing or of the wrong type: never throw, return `{ ok: false, error }`).
- `listProfiles()` returns the names of saved app profiles; `loadProfile(name)` returns the profile object (it may throw: turn that into an error message that does not include a file path);
  `git(repoPath)` returns a function `(args) => Promise<{ code, out }>` in the same shape as `gitIn` in `runparams.mjs` (it never throws).
- `app` must be one of `listProfiles()` (error `Choose one of the apps that has been set up.`).
- `goodRef` and `candRef`: when empty or missing use `profile.defaults.good` and `profile.defaults.cand`; otherwise each must match `REF` from `runparams.mjs` (import it, do not copy it), must not contain `..`, must not end with `/` or `.lock`, and must resolve in the profile's repository with
  `git(profile.repo)(['rev-parse', '--verify', '--quiet', ref + '^{commit}'])` (code 0 and non-empty output). Use messages in the style of `validateRun`: `The old version "x" is not a valid version name.` / `There is no old version "x" in the repository.` (and `new` for the candidate). Keep the first 30 characters of a bad ref in the message at most.
- `bisect` defaults to true. When the two resolved shas are equal, `bisect` becomes false and `note` says the versions are the same so this is a clean-run check. When `bisect` is true, the old version must be an ancestor of the new one (`git(...)(['merge-base', '--is-ancestor', goodSha, candSha])` with code 0), otherwise error: `For the search, the old version must come before the new one in the history. Switch them, or untick the search to compare anyway.`
- `region` is optional. When given it must be a string that is a key of `profile.regions` (error `That region is not in this app's profile.`). A profile with no regions and a `region` given is the same error. Do not accept a region just because it looks like a name.
- Success: `params = { app, goodRef, candRef, goodSha, candSha, bisect, region: region ?? null }` and `note` (a string or `null`).

### `visualArgv(params, { ports = [8301, 8302] } = {}) -> string[]`
The argument list (NOT including `node`) for `node src/release/visual/check.mjs <app> <goodRef> <candRef> [--bisect] [--region <name>] [--ports <a>,<b>]`, with `'src/release/visual/check.mjs'` as the first element. Never builds a shell string. Throws an `Error` (clear message) when any element would be unsafe:
`app` must match `^[a-z0-9-]+$`, refs must match `REF` and not contain `..`, the region must contain no whitespace and must not start with `-`, ports must be two integers from 1024 to 65535. `--region` is only added when `params.region` is set, `--bisect` only when `params.bisect` is true.

### `visualProgress(lines) -> { phase, fraction, text }`
`lines` is the array of output lines of a running check so far (strings, oldest first; it may be empty or contain junk). The check prints marker lines as it goes, exactly `progress: building both versions`, `progress: taking pictures`, `progress: measuring noise`, `progress: comparing regions`, `progress: searching`, `progress: recording`,
and during a search it prints lines from the existing bisect: `bisect range: good through #<a>, bad from #<b>, of <n>` and `bisect step <k>: <sha> (#<i> of <n>) good|bad|skip | <subject>`; at the end it prints `case <caseId>` and `outcome: <text>`. A failed search prints `bisect failed: <reason>`.
Use the LAST marker line to pick the phase, then:
- `building both versions`: `{ phase: 'building', fraction: 0.05, text: 'Building both versions' }`
- `taking pictures`: phase `pictures`, 0.2, `Taking settled pictures of both versions`
- `measuring noise`: phase `noise`, 0.35, `Measuring how much the old version differs from itself`
- `comparing regions`: phase `comparing`, 0.5, `Comparing the regions`
- `searching`: phase `searching`; the fraction is `0.55 + 0.35 * progress`, where `progress = 1 - log2(left) / log2(n)`, `n` is the `of <n>` of the latest `bisect range` line and `left = b - a` of that same line (clamp `left` to at least 1 and `n` to at least 2; with no range line yet use `progress = 0`). Text: `Searching <n> code changes: step <k+1>, <left> still possible` (`k` = number of `bisect step` lines seen; without a range line: `Searching for the first change`).
- `recording`: phase `recording`, 0.95, `Writing the report`
- no marker line at all: phase `starting`, 0, `Starting`.
Overrides, checked first: a line starting `case ` means `{ phase: 'done', fraction: 1, text: 'Finished' }`; a line starting `bisect failed:` or `could not` or `usage:` means `{ phase: 'failed', fraction: <what it would have been>, text: <that line, at most 160 characters> }` (a `case` line wins over a failure line that came before it).

### `caseIdOf(lines) -> string | null`
The id from the last line of the form `case <id>` where `<id>` matches `^[\w.-]+$`, otherwise `null`.

## Tests (offline)

- `validateVisualRun`: fake `listProfiles`, `loadProfile` and a fake `git` that maps refs to shas (and answers the ancestor question). Cover: success with explicit refs; success using the profile's defaults; unknown app; a missing app; a ref that is not valid, ends with `.lock`, contains `..`, or does not resolve; same sha gives `bisect: false` and a note; old not an ancestor of new with bisect on gives the error and with bisect off is fine; region valid / unknown / on a profile with no regions; `loadProfile` throwing; non-object input and wrong types never throw.
- `visualArgv`: exact output for a full request; flags only when set; each unsafe element throws (an app with a space or `;`, a ref starting with `-`, a region with a space, bad ports); a hostile region such as `--help` is refused.
- `visualProgress`: each phase, the search fraction moving up as the range narrows (compare two `bisect range` lines), `case` and failure overrides, empty and junk input. `caseIdOf` with and without a case line and with an id that has a slash (returns `null`).
