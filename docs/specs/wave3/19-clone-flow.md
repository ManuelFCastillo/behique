---
part: clone-flow
owns:
  - src/release/ui/clone-flow.mjs
  - src/release/ui/clone-flow.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/ui/onboard-flow.mjs
  - src/release/ask.mjs
test: node --test src/release/ui/clone-flow.test.mjs
allow: []
---
# Part 19: clone a GitHub repository into the apps folder, only after a person has confirmed exactly what will run

The set-up flow can only work on repositories that are already cloned in the apps folder. This part is the guarded step that clones one: a preview that shows the exact command, where it goes and how big the repository is,
and a clone that only happens with the fingerprint of that preview (the same idea as `ask.mjs` and `onboard-flow.mjs`: what is run is what was on screen). Cloning downloads files and runs none of them.
Every collaborator is injected, so every test is offline with fakes. Everything from the page (the repository name, the fingerprint) is untrusted.

## `clone-flow.mjs` must export

### `parseRepoRef(text) -> { owner, name } | null`
Accept `owner/name`, optionally with a leading `https://github.com/` and an optional trailing `.git` or `/`. `owner` matches `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` and `name` matches `^[A-Za-z0-9._-]{1,100}$`; `name` must not be `.` or `..`, must not start with `-` and must not contain `..`.
Anything else (other hosts, extra path parts, whitespace, a query string, a non-string) gives `null`.

### `clonePlan({ fullName, appsRoot, exists, info }) -> { ok: true, plan } | { ok: false, error }`
`fullName` is `owner/name` (run it through `parseRepoRef`; invalid gives `{ ok: false, error: 'That is not a GitHub repository name.' }`). `exists(path) -> boolean`. `info` is `{ sizeKb, isPrivate, isFork, isArchived, defaultBranch }` (any field may be missing).
The target folder name is the repository name; it must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$` and must not start with `w-` and must not be `work` (error `That name cannot be used as a folder in the apps folder.`). The target path is `join(appsRoot, name)` and must stay inside `appsRoot` (use `path.resolve` and check the prefix).
If `exists(path)` is true the error is `Already cloned: <name> is in the apps folder.`
`plan` is `{ owner, name, url: 'https://github.com/<owner>/<name>.git', path, command: ['git', 'clone', '--filter=blob:none', '--', url, path], sizeMb, isPrivate, isFork, isArchived, defaultBranch, warnings }` where `sizeMb` is `sizeKb / 1024` rounded to one decimal or `null`, and `warnings` are plain sentences: `This is a private repository.` when private; `This repository is archived.` when archived; `This repository is large (about <n> MB).` when `sizeMb` is above 500; `This is a fork.` when a fork. The command never contains anything but these literal parts and the validated `url` and `path`.

### `clonePreview(input, deps) -> Promise<{ ok, ... }>`
`input = { repo }`. `deps = { appsRoot, exists, repoInfo }` where `repoInfo(owner, name)` is async and returns the `info` object or throws (turn a throw into `{ ok: false, status: 404, error: 'Could not read that repository from GitHub.' }`).
Return `{ ok: true, plan, commandLine, confirm }` where `commandLine` is the command joined with single spaces for a person to read, and `confirm` is the first 16 hex characters of the sha256 (`node:crypto`) of `JSON.stringify(plan)`. Same input gives the same `confirm`; any difference in the plan changes it.
A failed `clonePlan` is `{ ok: false, status: 400, error }`. Never throws.

### `cloneRun(input, deps) -> Promise<{ ok, ... }>`
`input = { repo, confirm }`. `deps = { appsRoot, exists, repoInfo, exec, timeoutMs = 600000 }` where `exec(command, { timeoutMs }) -> Promise<{ code, stderr }>` runs the argument array without a shell.
Compute `clonePreview`; refuse with `{ ok: false, status: 400, error }` when it is not ok; with `status: 409`, `stale: true` and the message `What would be run has changed, or was not reviewed. Review it again before cloning.` when `input.confirm` is not a string equal to the preview's `confirm`. Only then call `exec(plan.command, { timeoutMs })` exactly once.
When `code` is 0 return `{ ok: true, path: plan.path, name: plan.name }`. Otherwise `{ ok: false, status: 502, error: 'The clone failed: <first line of stderr, at most 200 characters>' }`. A throwing `exec` gives the same 502 shape. `exec` is never called when anything above refused.

## Tests (offline, fakes only)

`parseRepoRef`: plain, with URL prefix, with `.git`, trailing slash, and the rejects (other host, extra path parts, `..`, leading dash, spaces, query string, non-strings, too long). `clonePlan`: the command array is exactly the literal form, an existing folder is refused, bad folder names (`w-x`, `work`) are refused, a path cannot escape `appsRoot` (a name that matches the pattern but resolves outside is impossible, still test `..` in the name through `parseRepoRef`), warnings for private, archived, large and fork, `sizeMb` rounding and `null`. `clonePreview`: stable `confirm`, changes when the size info changes, a throwing `repoInfo`. `cloneRun`: refuses a missing or wrong `confirm` (409, `exec` never called), refuses an existing folder, calls `exec` exactly once with the planned command on a good confirm, success shape, failure shape with a long stderr cut to 200 characters, a throwing `exec`.
