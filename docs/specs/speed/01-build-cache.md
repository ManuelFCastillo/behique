---
part: build-cache
owns:
  - src/release/sandbox/cache.mjs
  - src/release/sandbox/cache.test.mjs
context:
  - docs/speed-plan.md
  - src/release/sandbox/docker-args.mjs
  - src/release/sandbox/sandbox.mjs
  - src/release/sandbox/backend.mjs
test: node --test src/release/sandbox/cache.test.mjs
allow: []
---
# Part 1: a build cache per commit, as Docker images

Read `docs/speed-plan.md` section 2 first. Every test run of a check starts a brand-new build of the same commit, and in the sandbox a build means tar, volume, seed, `npm ci`, the app's build step. This part provides the pure pieces for keeping the result of the first build of a commit as a Docker image, so later builds of that commit start a fresh container from the image in seconds. The wiring into `sandbox.mjs` and `backend.mjs` is done by hand afterwards; this part writes only `cache.mjs` and its tests.

Everything here is pure: it builds argument arrays and makes decisions on plain data. It starts no process, reads no file, calls nothing in `sandbox.mjs`. It may import `names`, `isRunId`, `isImage`, `ALLOWED_CAPS` from `./docker-args.mjs` and `createHash` from `node:crypto`. No long dash character anywhere. Style: the style of `docker-args.mjs` (plain functions, `{ ok: true, args }` or `{ ok: false, error }`, never throw on bad input).

## How the cache works (so the pieces fit)

On a cache miss the sandbox does today's steps (volume `bq-<runId>-work` seeded with the checkout, install steps run on it). Then a **committer** container runs as root with the run's volume mounted read-only at `/vol` and copies it into its own writable layer at `/work` (`cp -a /vol /work`, which creates `/work` and keeps every file's owner, uid 1000). That container is then **committed** to an image named `bq-cache:<key>` with labels, user 1000:1000 and workdir `/work`, and removed. On a cache hit the app container is created straight from `bq-cache:<key>` with no volume: overlay2 gives it a private copy-on-write filesystem, so each run still starts from exactly the state a fresh install produces and nothing a test writes survives into the next run. Sidecars stay fresh per run.

The key is `<app>-<sha12>-<fp8>`: the app name, the first 12 hex characters of the commit, and the first 8 hex characters of a sha256 fingerprint over what shapes the build result: the base image, the install steps (command and arguments as written in the profile, with the literal `{port}` placeholder still in them, never a substituted port), whether lifecycle scripts were allowed, the static root if any, and the kinds of sidecar services (not their names or addresses, which change per run). Anything else (env values, ports, run ids) must not be in the fingerprint, or no run would ever hit.

## `cache.mjs` must export

### `CACHE_REPO`
The string `'bq-cache'`.

### `cacheKey(input) -> { ok: true, key, fingerprint } | { ok: false, error }`
`input = { app, sha, image, installs, allowScripts, root, services }`.
- `app`: `/^[a-z0-9-]{1,40}$/`. `sha`: a 40-character lowercase hex string (use its first 12 characters). `image`: must pass `isImage`. `installs`: an array (may be empty) of `{ cmd: string, args?: string[] }`. `allowScripts`: boolean (undefined counts as false). `root`: a string or undefined. `services`: an array (may be empty) of objects with a `kind` string, or of strings; only the kinds, sorted, go into the fingerprint.
- The fingerprint is sha256 of the JSON of `{ image, installs: [{ cmd, args }], allowScripts, root: root ?? null, services: sortedKinds }` with arrays in their given order (installs) and keys in exactly that order; `fingerprint` is its first 8 hex characters.
- `key = app + '-' + sha12 + '-' + fingerprint`. Any invalid field returns `{ ok: false, error }` in plain words.

### `cacheImage(key) -> string | null`
`'bq-cache:' + key` when the key is valid (see `isCacheKey`), else null.

### `isCacheKey(s)`, `isCacheImage(s)`, `parseCacheImage(s) -> { app, sha12, fingerprint } | null`
A key is `/^[a-z0-9-]{1,40}-[0-9a-f]{12}-[0-9a-f]{8}$/` (match from the end: the app part may itself contain dashes). A cache image is `'bq-cache:' + key`. `parseCacheImage` splits it back.

### `committerArgs({ runId, image, volumeShort }) -> { ok, args | error }`
The docker `run` that copies the run's volume into a container layer, to be committed. Validate `runId` with `isRunId`, `image` with `isImage`, `volumeShort` as a short name the same way `names` does (it returns null for a bad one). The container name is `names(runId, 'commit')`. Exactly:
`['run', '--name', <name>, '--label', 'behique=1', '--label', 'behique.run=<runId>', '--label', 'behique.role=commit', '--user', '0:0', '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--security-opt=no-new-privileges', '--network', 'none', '--volume', '<names(runId, volumeShort)>:/vol:ro', image, 'cp', '-a', '/vol', '/work']`.
It is not detached and not `--rm`: it runs to completion, then `commitArgs` commits it and `removeArgs` from docker-args removes it (the caller does that).

### `commitArgs({ runId, key, app, sha }) -> { ok, args | error }`
`['commit', '--change', 'USER 1000:1000', '--change', 'WORKDIR /work', '--change', 'LABEL behique=1', '--change', 'LABEL behique.cache=1', '--change', 'LABEL behique.app=<app>', '--change', 'LABEL behique.sha=<sha>', '--change', 'LABEL behique.created=<iso>', <names(runId, 'commit')>, 'bq-cache:<key>']`
where `<iso>` is `new Date(now).toISOString()` and `now` may be passed as a second argument `{ now }` (a number, default `Date.now()`), so tests can pin it. Validate `key` with `isCacheKey`, `app` and `sha` as in `cacheKey`.

### `cacheListArgs() -> { ok: true, args }`
`['image', 'ls', '--filter', 'label=behique.cache=1', '--format', '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}']`.

### `parseCacheList(stdout) -> [{ image, key, app, sha12, fingerprint, createdAt, size }]`
One entry per line of the `cacheListArgs` output; lines that are not a valid cache image are skipped. `createdAt` is the text Docker printed (for example `2026-10-31 10:02:11 -0500 CDT`) parsed to a millisecond timestamp with `Date.parse` after dropping the trailing zone name (the last space-separated token when it is letters); if it does not parse, `createdAt` is null. `size` is the text as printed. Never throws.

### `cacheInspectArgs(image) -> { ok, args | error }`
`['image', 'inspect', '--format', '{{.Id}}', image]` for a valid cache image only.

### `cacheRemoveArgs(images) -> { ok, args | error }`
`['image', 'rm', ...images]` where every entry passes `isCacheImage` and there is 1 to 50 of them. Anything else is refused: this must never be able to remove an image that is not a Behique cache image.

### `prunePlan(entries, { keepPerApp = 4, maxAgeDays = 14, now = Date.now() } = {}) -> { remove: string[], keep: string[] }`
`entries` is what `parseCacheList` returns. Per app, the newest `keepPerApp` entries (by `createdAt`, nulls count as oldest) are kept, the rest are removed; in addition any entry older than `maxAgeDays` is removed even if it is among the newest, unless it is the single newest entry of its app (the last good build of an app is always kept). Returns image names. Pure.

### `hitPlan({ runId, key, limits, env, cmd, port, networks }) -> { ok, plan | error }`
The container plan for an app started from a cache image, in the shape `createArgs`/`runArgs` in `docker-args.mjs` take: `{ runId, short: 'app', role: 'app', image: 'bq-cache:<key>', networks (default ['int']), volume: null, workdir: '/work', user: '1000:1000', cmd, env: { ...env, HOME: '/work/.home', PORT: String(port) }, tmpfs: [], caps: [], limits, interactive: false, detach: true, rm: false, readOnly: false }`. `readOnly` is false because the app writes into `/work` (its own copy-on-write layer); the policy change that allows this for an app started from a cache image is made by hand in `docker-args.mjs`. Validate `runId`, `key`, `cmd` (non-empty array of strings, first not starting with `-`), `port` (integer 1024 to 65535), `limits` (object). Do not validate further: `createArgs` does.

## Tests (`cache.test.mjs`, node:test, offline)
- `cacheKey` is stable for the same input and changes when the image, an install argument, `allowScripts`, `root` or a service kind changes; it does not change when service names or install order of keys differ, and `args` with `{port}` keep the placeholder (the test shows two inputs that differ only in a substituted port number give different keys, which is the reason callers must pass the unsubstituted ones).
- `cacheKey` refuses a bad app, a short sha, an image that is not pinned, a non-array `installs`.
- `isCacheKey` and `parseCacheImage` round-trip, including an app name with dashes (`nextjs-blog`); `isCacheImage` rejects `node:22-bookworm`, `bq-cache:latest`, a key with uppercase, and a key with a 7-character fingerprint.
- `committerArgs` gives exactly the argv above (deep equal), refuses a bad runId or image.
- `commitArgs` gives exactly the argv above with a pinned `now`.
- `parseCacheList` reads two good lines and skips a junk line and a non-cache image; `createdAt` parses the Docker format.
- `cacheRemoveArgs` refuses an empty list, a plain image (`node:22-bookworm`) and 51 images.
- `prunePlan`: keeps the newest 4 per app, removes older ones, removes an old entry inside the top 4 but keeps the single newest even when it is old, handles null `createdAt`.
- `hitPlan` returns the plan above and refuses a bad port or an empty cmd.
