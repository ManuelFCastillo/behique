---
part: onboard-flow
owns:
  - src/release/ui/onboard-flow.mjs
  - src/release/ui/onboard-flow.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/ask.mjs
  - src/release/onboard/onboard.mjs
  - src/release/onboard/propose.mjs
  - src/release/onboard/inspect.mjs
  - src/release/onboard/verify.mjs
  - src/release/onboard/profile.mjs
test: node --test src/release/ui/onboard-flow.test.mjs
allow: []
---
# Part 12: set up an app from the dashboard, with a person approving each step

The command line (`onboard.mjs`) can inspect a repository, ask a model to propose how to run it, and verify the proposal. This part is the same flow as four guarded steps for a web page,
in the style of `ask.mjs` (read it: the preview shows the exact text and cost, and the paid call only happens with the fingerprint of that text). Nothing here spawns a process, reads
the network or touches a file directly: every collaborator is injected, so every test is offline with fakes. The rule that runs through it all: **a model proposes, code verifies, a person approves.**
A command a model proposed never runs until a person has approved it, and a profile is only saved after verification passed. Everything from the page (names, refs, paths) is untrusted.

Only repositories that are ALREADY cloned inside one apps folder (`appsRoot`) can be set up; cloning is not part of this.

## `onboard-flow.mjs` must export

### `listCandidates({ appsRoot, readdir, isGitRepo, listProfiles }) -> Promise<[{ name, path, hasProfile }]>`
`readdir(dir)` returns entry names, `isGitRepo(path)` returns a boolean, `listProfiles()` returns saved profile names. Return the entries of `appsRoot` that are git repositories, skipping names that start with `.`, start with `w-` (build worktrees), or are `work`, and names that do not match `^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$`. `path` is the absolute path, `hasProfile` is true when a saved profile has the same name. Sorted by name.

### `resolveRepo(appsRoot, name, { isGitRepo }) -> Promise<string>`
The absolute path of the repository folder called `name`, or a thrown `Error` with a clear message. `name` must be a string matching the pattern above, the joined path must stay inside `appsRoot` after `path.resolve` (no `..`, no separators in `name`, no absolute paths), and `isGitRepo` must say true. Never include more of the input than 30 characters in a message.

### `onboardPreview(input, deps) -> Promise<{ ok, ... }>`
`input = { repo, name, good, cand }`. `deps = { appsRoot, isGitRepo, listProfiles, inspectRepo, skillText, buildMessages, projectCost, provider = 'meta', keyPresent }`. It calls NO model.
Steps: validate `name` (`^[a-z0-9-]+$`, at most 40 characters) and refuse (`ok: false, status: 400, error`) if a saved profile with that name already exists; `good` and `cand` must be non-empty strings of at most 60 characters with no whitespace and not starting with `-`; `resolveRepo`; `facts = await inspectRepo(path)`; `messages = buildMessages(facts, skillText, { good, cand })`.
Return `{ ok: true, canSend: keyPresent, reason, provider, model: 'muse-spark-1.3', sent: messages, usdExpected: projectCost(messages), facts: <a small summary: path, isGit, hasIndexHtml, tags (at most 5), scripts (names only)>, confirm: <fingerprint> }`. `sent` is the text word for word as it would leave this machine. `reason` is `null` or `No API key is set for <provider>, so nothing can be sent.`. The fingerprint is the first 16 hex characters of a sha256 over `provider + '\n' + JSON.stringify(messages)` (use `node:crypto`). It must be identical for identical input and different when any part of the text differs. Never throw: every failure is `{ ok: false, status, error }`.

### `onboardPropose(input, deps) -> Promise<{ ok, ... }>`
`input` as above plus `confirm` (the fingerprint). `deps` as above plus `ask(messages)` (the model call), `proposeProfile` (from `propose.mjs`), `describeCommands`, `writeFile(path, text)`, `maxCost = 0.3`.
Compute `onboardPreview`. Refuse with `status: 400` when it is not ok or `canSend` is false; with `status: 409`, `stale: true` and a message saying what would be sent has changed or was not reviewed when `confirm` is not a string equal to the fingerprint; with `status: 400` when `usdExpected > maxCost`. Only then call `proposeProfile({ facts, skillText, ask, good, cand })`.
Force the profile's `name` to `input.name`. Return `{ ok: true, profile, problems, usage, usd, commands: describeCommands(profile), needsApproval: commands.length > 0 && the proposal is not just the built-in static server, proposed: <path written> }` where `usd` is `usage.pt * 1.25e-6 + usage.ct * 4.25e-6`. Write the proposal with `writeFile(join('out', 'onboard', name + '.proposed.json'), JSON.stringify(profile, null, 2) + '\n')` even when there are problems (so a person can edit it), but when `profile` is null write nothing and return `{ ok: false, status: 502, error, problems }`. `needsApproval` is true for any proposal that would run a command (`describeCommands` lines other than `serve: built-in static file server`).

### `onboardVerify(input, deps) -> Promise<{ ok, ... }>`
`input = { name, good, cand, approveCommands }`. `deps = { readFile, describeCommands, validateProfile, verifyProfile, saveProfile, ports = [8301, 8302], log }`.
Read `out/onboard/<name>.proposed.json` through `readFile` (a missing or invalid file gives `status: 404`/`400`); run `validateProfile` (any problem gives `status: 400` with the problems). If `describeCommands(profile)` contains anything other than the built-in static server, then `approveCommands` must be exactly `true`, otherwise refuse with `status: 400, needsApproval: true, commands` and the message `These commands run on this machine. Approve them first.`; the commands are listed in the refusal either way. Then `await verifyProfile(profile, { good, cand, ports, log })`.
Only when the result has `ok: true` call `saveProfile(profile)` and return `{ ok: true, checks, saved: true, path }`. When verification fails return `{ ok: false, status: 422, checks, saved: false }` and never call `saveProfile`. Never throw.

## Tests (offline)

All collaborators are fakes; record calls to prove what did NOT happen.
- `listCandidates`: skips non-git folders, worktrees (`w-...`), `work`, hidden and badly named entries; `hasProfile`; sorted.
- `resolveRepo`: accepts a plain name; rejects `..`, `a/b`, an absolute path, a name with a null byte or spaces, a non-string, and a folder that is not a repository; messages short.
- `onboardPreview`: calls no `ask`; the fingerprint is stable, and changes when `good` changes or when the skill text changes; refuses an existing profile name, a bad name, bad refs; `canSend: false` with the reason when `keyPresent` is false; `sent` is exactly the messages from `buildMessages`.
- `onboardPropose`: a wrong or missing `confirm` is 409 and `ask` was never called; a good one calls `ask` once and writes exactly one file; a projected cost above `maxCost` is refused with no call; a null profile writes nothing; the profile name is forced to the input name even if the model chose another; `needsApproval` false for the static server and true for a command; `usd` from the usage.
- `onboardVerify`: a proposal with a command and `approveCommands` not exactly `true` (try `'true'`, `1`, missing) is refused and `verifyProfile` was never called; static proposals need no approval; verification failing never calls `saveProfile`; success saves once; a missing file, bad JSON and an invalid profile are refused; a throwing collaborator becomes a clean `{ ok: false }` rather than an exception.
