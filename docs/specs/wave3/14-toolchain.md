---
part: toolchain
owns:
  - src/release/onboard/toolchain.mjs
  - src/release/onboard/toolchain.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/onboard/profile.mjs
test: node --test src/release/onboard/toolchain.test.mjs
allow: [env_files]
---
# Part 14: package managers and environment templates, as pure functions

Running a third-party web app needs the right package manager, an install that does not run the repository's lifecycle scripts, and environment variables that are safe. This part is the pure
logic for that: no process is started, no file is read, nothing touches the network. Everything takes plain data and returns plain data. A person wires it into the app profile afterwards.
The commands it produces must stay within `ALLOWED_COMMANDS` of `profile.mjs` (`node, npm, npx, pnpm, yarn, python3, php`): never `bun`, never a shell.

## `toolchain.mjs` must export

### Package manager

- `detectPackageManager({ packageManager, lockfile } = {}) -> { name, version, source }`. `packageManager` is the raw string from `package.json` (for example `pnpm@9.1.0+sha512.abc`), `lockfile` is a file name.
  A recognised field wins (`source: 'packageManager field'`, version without any `+hash`); otherwise the lockfile (`pnpm-lock.yaml` pnpm, `yarn.lock` yarn, `package-lock.json` npm, `bun.lockb` or `bun.lock` bun; `source: 'lockfile'`, `version: null`); otherwise `{ name: 'npm', version: null, source: 'default' }`. Names other than npm, pnpm, yarn, bun in the field are ignored.
- `installItem(pm, { hasLockfile = true, ignoreScripts = true } = {}) -> { cmd, args } | null`. `pm` is the result of `detectPackageManager`.
  npm: `ci` when `hasLockfile` else `install`, plus `--ignore-scripts`. pnpm: `install --frozen-lockfile --ignore-scripts` (without `--frozen-lockfile` when `hasLockfile` is false). yarn with a major version of 2 or more: `install --immutable --mode=skip-build` (with `ignoreScripts` false just `install --immutable`); yarn 1 or an unknown version: `install --frozen-lockfile --ignore-scripts`. bun: `null` (not an allowed command). The scripts flags are left out only when `ignoreScripts` is false.
- `withIgnoreScripts(item) -> item`. A copy of `{ cmd, args }`. When `cmd` is npm, pnpm or yarn and `args[0]` is one of `install`, `i`, `ci`, `add` and no scripts flag is present, add `--ignore-scripts` (for yarn 2 or more there is no way to tell from the item alone, so add `--ignore-scripts` for yarn too). Any other item, and any item that already has `--ignore-scripts` or `--mode=skip-build`, is returned unchanged (still a copy). Never mutates its argument.
- `shimFile(name) -> { name, content } | null`. For `yarn` and `pnpm` only: `content` is exactly `#!/bin/sh\nexec corepack <name> "$@"\n`. Anything else gives `null`. (Corepack ships with Node and fetches the version a repository pins, so nothing is installed globally.)
- `shimEnv(dir, baseEnv = {}) -> env`. A copy of `baseEnv` where `PATH` is `dir` followed by `:` and the old `PATH` (or just `dir` when there was none) and `COREPACK_ENABLE_DOWNLOAD_PROMPT` is `'0'`. Never mutates `baseEnv`.

### Environment templates

- `parseEnvExample(text) -> [{ key, example }]`. `text` is the content (or an array of lines) of an example env file. Ignore blank lines and lines starting with `#`. Accept `KEY=value`, `export KEY=value`, and `KEY=` (empty example). Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. Remove matching surrounding single or double quotes from the value and cut a trailing ` # comment` that follows a space when the value is not quoted. Keep the order and drop duplicate keys (first wins).
- `classifyEnvKey(key, example) -> kind`, checked in this order, case-insensitive on the key:
  `'database'` when the key contains `DATABASE`, `POSTGRES`, `MYSQL`, `MARIADB`, `MONGO` or `REDIS`, or starts with `DB_` (SQLite is a file, so a key containing `SQLITE` is NOT a database blocker and falls through to the later rules); `'secret'` when it ends in or contains `SECRET`, `PASSWORD`, `PASSWD`, `TOKEN`, `PRIVATE_KEY`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `CLIENT_ID`, `CLIENT_SECRET`, `WEBHOOK`, `DSN`; `'port'` when the key is `PORT` or ends in `_PORT`; `'url'` when it ends in `_URL`, `_URI`, `_HOST`, `_ORIGIN`, `_ENDPOINT` or is `BASE_URL`; `'flag'` when the example is `true`, `false`, `0`, `1`, `yes`, `no`, `on` or `off` (case-insensitive); otherwise `'plain'`.
- `safeEnv(entries, { port } = {}) -> { env, blockers }`. For each entry: kind `port` goes into `env` with the value `String(port)` only when the key is exactly `PORT`, other port keys are left out; kind `flag` and `plain` go into `env` with their example value when it is non-empty and shorter than 100 characters; kind `url` goes into `env` only when its example points at `localhost` or `127.0.0.1` (replace the port number in it by `port` when `port` is given), otherwise it is a blocker of kind `service`; kind `database` is a blocker with `needs: 'a database or other service'`; kind `secret` is a blocker with `needs: 'a secret or credential'`. A secret or database value is NEVER copied into `env`, not even the example. `blockers` is `[{ key, kind, needs }]` in the order of the entries. Values never contain a newline.

### Using the two together

- `describeEnv(env) -> string[]`: one line `env: KEY=value` per key in sorted order (this is what a person reads before approving), values cut at 80 characters.

## Tests (offline)

Cover: `detectPackageManager` for each lockfile, the field with and without `+hash`, a bad field, bun, and the default. `installItem` for every manager and yarn version (1.22.22, 3.6.0, 4.1.0, unknown), with and without a lockfile and with `ignoreScripts` false, and bun giving `null`; every returned command is in the allowed list. `withIgnoreScripts` for each case including no mutation. `shimFile`, `shimEnv` (no mutation, PATH with and without an old PATH). `parseEnvExample` with comments, `export`, quotes, trailing comments, duplicate keys, bad keys and an array of lines. `classifyEnvKey` for a table of at least 20 keys (DATABASE_URL, POSTGRES_PASSWORD, REDIS_URL, STRIPE_SECRET_KEY, NEXTAUTH_SECRET, SENTRY_DSN, PORT, ADMIN_PORT, NEXT_PUBLIC_BASE_URL, APP_ORIGIN, DEBUG=true, NODE_ENV=development, LOG_LEVEL=info and so on). `safeEnv`: a database URL, a secret and a remote URL are blockers and their values appear nowhere in `env`; `PORT` gets the port; a localhost URL has its port replaced; flags and plain values pass. `describeEnv` order and cut.
