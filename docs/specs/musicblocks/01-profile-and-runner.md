---
part: profile-and-runner
owns:
  - src/release/onboard/profile.mjs
  - src/release/onboard/profile.test.mjs
  - src/release/onboard/static-server.mjs
  - src/release/onboard/static-server.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/build.mjs
test: node --test src/release/onboard/profile.test.mjs src/release/onboard/static-server.test.mjs
allow: [child_process, env_files, deletes]
---
# Part 1: the app profile and the runner

An **app profile** is a small JSON description of how to run one app so Behique can check it. It is DATA, never code, so a model can
propose one and a person can read it before anything runs. `profile.mjs` validates a profile and turns it into the adapter object that
`startBuild` (see the overview) already understands. `static-server.mjs` serves a checkout as plain files for apps that need no build.

## The profile (JSON)

```json
{
  "name": "musicblocks",
  "repo": "~/dev/behique-apps/musicblocks",
  "workRoot": "~/dev/behique-apps",
  "defaults": { "good": "v3.8.0", "cand": "master" },
  "serve": { "kind": "static", "overrides": { "/env.js": "window.MB_ENV=\"development\";window.MB_IS_DEV=true;" } },
  "ready": { "path": "/", "timeoutMs": 30000 },
  "viewport": { "width": 1280, "height": 800, "deviceScaleFactor": 2 },
  "setup": [ { "type": "click_at", "x": 220, "y": 155 } ],
  "regions": { "edge-left": { "x": 0, "y": 0, "w": 8, "h": 800 }, "edge-right": { "x": 1272, "y": 0, "w": 8, "h": 800 } },
  "anchors": { "workspace": { "x": 520, "y": 80, "w": 400, "h": 600 } },
  "notes": "free text: what the proposer was unsure about"
}
```

`serve` is one of:
- `{ "kind": "static", "overrides": { "<url path>": "<response body>" } }`: serve the worktree as plain files. `overrides` is optional.
- `{ "kind": "command", "cmd": "npm", "args": ["run", "dev", "--", "--port", "{port}"], "install": [ { "cmd": "npm", "args": ["ci"] } ], "basePath": "" }`:
  run a command in the worktree. `{port}` inside `args` is replaced by the port. `install` is optional and runs, in order, before serving.

## `profile.mjs` must export

- `ALLOWED_COMMANDS`: `['node', 'npm', 'npx', 'pnpm', 'yarn', 'python3', 'php']`. No other executable is ever allowed.
- `validateProfile(profile) -> string[]`: the list of problems (empty means valid). Check at least: `name` matches `/^[a-z0-9-]+$/`; `repo` and `workRoot`
  are non-empty strings that start with `/` or `~/`; `defaults.good` and `defaults.cand` are non-empty strings if `defaults` exists; `serve.kind` is `static` or `command`;
  every `cmd` (in `serve` and in each `install` item) is in `ALLOWED_COMMANDS` and is a bare name (no `/`); every `args` entry is a string, and no argument contains
  a shell operator character (`; & | \` $ < >` or a newline), because commands are run without a shell; `overrides` keys start with `/` and values are strings;
  `viewport` numbers are positive integers and `deviceScaleFactor` is 1 or 2; every `setup` item has `type` in `click_at`, `wait`, `press` and the right fields
  (`x`,`y` numbers; `ms` a number up to 5000; `key` a string); every region and anchor is `{ x, y, w, h }` of non-negative numbers with `w` and `h` above 0.
  Also reject any argument that makes an allowed executable run code given in the argument itself: exactly `-e`, `--eval`, `-p`, `--print`, `-c`, `-r`, `--require`, `--import`, `--loader`, `--experimental-loader` (and `--eval=...` or `--print=...` forms), because an allowlisted interpreter with such an argument is arbitrary code.
  Unknown top-level fields are a problem. Return ALL problems, not only the first.
- `normalizeProfile(profile) -> profile`: a copy with defaults filled in: `viewport` `{ width: 1280, height: 800, deviceScaleFactor: 2 }`, `ready` `{ path: '/', timeoutMs: 30000 }`,
  `setup: []`, `regions: {}`, `anchors: {}`, `serve.overrides: {}` for static, `serve.install: []` and `serve.basePath: ''` for command. It throws if `validateProfile` finds problems.
- `describeCommands(profile) -> string[]`: one human-readable line for every command the profile would run (each install step, and the serve command, or the static server),
  so a person can approve them before anything runs. A line for `npx`, `npm exec` or `pnpm dlx` / `yarn dlx` must end with the warning ` (downloads and runs packages from the internet)`. Example line: `install: npm ci` and `serve: npm run dev -- --port {port}` and `serve: built-in static file server`.
- `profileToAdapter(profile, { home = homedir(), serverPath = <absolute path of static-server.mjs next to profile.mjs> }) -> adapter`: validates and normalises, expands a leading `~/`
  in `repo` and `workRoot` using `home`, and returns `{ name, repo, workRoot, cleanPaths: ['.behique-never-exists'], feed: null, basePath, prepare, serve }`.
  `cleanPaths` must be that one harmless path (see the overview: an empty list would clean the whole worktree). `prepare(dir)` runs each `install` command with
  `execFile(cmd, args, { cwd: dir, timeout: 600000 })` (never a shell) and resolves `{ entries: 0 }`. `serve(dir, port)` returns, for `static`,
  `{ cmd: 'node', args: [serverPath, dir, String(port), JSON.stringify(overrides)] }`, and for `command`, `{ cmd, args }` with `{port}` replaced in every argument.
  `basePath` is `serve.basePath ?? ''`.
- `PROFILE_DIR`: the absolute path of `src/release/onboard/profiles` (next to `profile.mjs`), `profilePath(name)`, `saveProfile(profile)` (validates, creates the directory,
  writes pretty JSON plus a newline, returns the path) and `loadProfile(name)` (reads and normalises; throws a clear error if the file is missing or the name is invalid).
  A name that does not match `/^[a-z0-9-]+$/` must never reach the filesystem.

## `static-server.mjs` must

- Export `createStaticServer(dir, overrides = {})` returning an `http.Server` that is NOT yet listening.
- When run as a script, `node static-server.mjs <dir> <port> [overridesJson]`, listen on `127.0.0.1:<port>` (use `pathToFileURL(process.argv[1]).href === import.meta.url` to detect that).
- Answer only `GET` and `HEAD` (others get 405). Ignore the query string. Decode the path with `decodeURIComponent` and answer 400 if it is malformed.
- If the path is a key in `overrides`, answer 200 with that string as the body (content type from the extension, `application/javascript` for `.js`).
- Otherwise map the path inside `dir`: refuse anything that would leave `dir` (answer 403), serve `index.html` for a directory, answer 404 if missing. Set `Cache-Control: no-store`.
- Know the content types of html, js, mjs, css, json, svg, png, jpg, gif, ico, wav, mp3, ogg, woff, woff2, ttf, webmanifest, wasm, and default to `application/octet-stream`.

## Tests (offline, no browser, no network beyond 127.0.0.1)

`profile.test.mjs`: a valid profile validates; each rule above is checked with a bad example (an executable outside the allowlist, a path in `cmd`, a shell operator in an `args` entry, a bad name,
a missing `repo`, an unknown field, a bad region) and ALL problems are reported together; `normalizeProfile` fills defaults and throws on invalid input; `describeCommands` lists every command;
each eval-style argument above is refused for `node`, `python3` and `php` (the old test that used `node -e` as an install command must instead run a real file: write a small `.mjs` script into the temp directory and use its path as the argument); the `npx` warning appears; `profileToAdapter` expands `~/` using a fake `home`, sets the harmless `cleanPaths`, builds the right `serve()` output for both kinds with the port substituted, and `prepare` runs install steps
(use `node` with `-e` arguments that write a file into a temp dir as the install command to prove they ran in `dir` without a shell); `saveProfile` and `loadProfile` round-trip (point `PROFILE_DIR`
through an optional argument or an environment variable read at call time, so tests write only to a temp directory) and a bad name is refused.
`static-server.test.mjs`: start `createStaticServer` on port 0 over a temp directory; check a file, a directory index, an override, 404, a path traversal attempt (`/..%2f..%2fetc%2fpasswd`, and a raw `/../x` sent with `node:http` `request({ path: '/../x' })` because the `fetch` API collapses dot segments before they reach the server), a malformed escape (`/%E0%A4%A`), `POST` giving 405, and `HEAD`.
