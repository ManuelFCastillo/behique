---
part: seed
owns:
  - src/release/sandbox/seed.mjs
  - src/release/sandbox/seed.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/sandbox/services.mjs
  - src/release/sandbox/docker-args.mjs
test: node --test src/release/sandbox/seed.test.mjs
allow: []
---
# Part 28: seed data for sidecar services

A sandboxed app gets its databases as sidecar containers (`services.mjs`), but they start empty, so an app that needs rows to show anything shows nothing. An app profile may now carry a `seed` list: for a named service, a file from the repository (or a short inline script) to load into it after the service is healthy and before the app starts. This part validates the list, describes it for the person who approves the profile, and turns it into the exact docker commands (a `cp` of the file into the sidecar, then an `exec` of the database's own client), so the sandbox only has to run what it is given. Pure: it builds argument lists and never runs anything.

## The `seed` list of a profile

```json
"seed": [
  { "service": "db", "file": "db/seed.sql" },
  { "service": "cache", "script": "SET greeting hello" }
]
```
Each entry names a service declared in the profile's `services` (by its `name`) and has exactly one of `file` (a path inside the repository checkout: relative, no `..` segment, no leading `/`, no whitespace, at most 200 characters) or `script` (inline text, at most 20,000 characters, no NUL character). Which file kinds a service accepts: `postgres`, `mysql` and `mariadb` take `.sql`; `mongo` takes `.js`; `redis` takes `.redis` (a file of commands for `redis-cli`). An inline `script` is loaded the same way as a file of that kind.

## `seed.mjs` must export

### `SEED_FILE_EXT`
`{ postgres: '.sql', mysql: '.sql', mariadb: '.sql', mongo: '.js', redis: '.redis' }`.

### `validateSeeds(list, services) -> string[]`
Problems as sentences; `[]` when valid. `list` may be undefined (valid, nothing to seed). Rules: an array of plain objects with no keys other than `service`, `file`, `script`; `service` must match the `name` of an entry in `services` (the profile's list, each `{ kind, name, inject }`; a service without `name` is addressed by its `kind`), else `seed <n>: no service named "<x>" in services`; exactly one of `file` or `script`; the path and text rules above; `file` must end with the kind's extension (`seed <n>: a <kind> seed must be a <ext> file`); at most 10 seeds.

### `describeSeeds(list, services) -> string[]`
One line per seed for the approval list: `seed: <service> (<kind>) from <file>` or `seed: <service> (<kind>) from an inline script (<n> characters)`.

### `cpArgs({ runId, short, from, to }) -> { ok, args } | { ok, error }`
The docker arguments to copy a file into a container: `['cp', from, '<container>:<to>']` where the container name is `names(runId, short)` from `docker-args.mjs`. `from` must be an absolute path without whitespace; `to` must start with `/seed/`. Follow the `{ ok, args }` / `{ ok: false, error }` shape of `docker-args.mjs`.

### `seedPlan(list, resolved, { runId, checkoutDir }) -> { ok, steps } | { ok: false, error }`
`resolved` is what `resolveServices` returns (each with `kind`, `name`, `short`, `env`, `image`); `runId` as in `docker-args.mjs`; `checkoutDir` the absolute path of the repository checkout on the machine that runs docker. For each seed, in order, produce `{ service, kind, short, source: { file } | { script }, to, cp, exec }` where `to` is `/seed/<n><ext>` (`n` from 1), `cp` is `cpArgs({ runId, short, from: join(checkoutDir, file), to })` for a file seed (for a script seed, `cp.from` is `null` and the sandbox writes the text to a temporary file first: set `cp` to `{ ok: true, args: null, inline: true }`), and `exec` is `execArgs({ runId, short, cmd })` with the client command per kind, using the service's own `env` (the catalog's values):
- postgres: `['psql', '-v', 'ON_ERROR_STOP=1', '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-f', to]`
- mysql: `['mysql', '-uroot', '-p' + env.MYSQL_ROOT_PASSWORD, env.MYSQL_DATABASE, '-e', 'source ' + to]`
- mariadb: `['mariadb', '-uroot', '-p' + env.MARIADB_ROOT_PASSWORD, env.MARIADB_DATABASE, '-e', 'source ' + to]`
- mongo: `['mongosh', '--quiet', 'app', to]`
- redis: `['sh', '-c', 'redis-cli < ' + to]`
The service's `short` in `resolved` is what `startServices` uses for the container name (`svc-<name>`); use `resolved[i].short` when present, else `'svc-' + name`. When any `cpArgs` or `execArgs` call fails, return `{ ok: false, error }` with the seed number and the reason. Validation problems also give `{ ok: false, error: <problems joined with '; '> }`.

### `seedSummary(steps, outcomes) -> string`
`outcomes` is one `{ ok, error? }` per step as the sandbox reports them. Returns `seeded <k> of <n>: <service> ok, <service> FAILED (<first line of error>)`, or `nothing to seed` for no steps.

## Tests (offline)

Cover: `validateSeeds` accepts the example (with matching services), accepts undefined, and refuses each rule (unknown key, unknown service, both file and script, neither, `..` in the path, a leading `/`, the wrong extension for the kind, an overlong script, more than 10); `describeSeeds` both forms; `cpArgs` the argument list and its refusals (relative `from`, a `to` outside `/seed/`, a bad run id); `seedPlan` for a postgres file seed and an inline mongo script (the `to` numbering, the client command with the catalog's user and database, the container name `bq-<runId>-svc-db`), for every kind in the table, for a failing `execArgs`, and for an invalid list; `seedSummary` for all ok, one failure, and no steps. Use `resolveServices` from `services.mjs` to build `resolved`, with a run id that `isRunId` accepts (read `docker-args.mjs` for its form).
