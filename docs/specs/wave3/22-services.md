---
part: services
owns:
  - src/release/sandbox/services.mjs
  - src/release/sandbox/services.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/onboard/inspect-more.mjs
  - src/release/onboard/toolchain.mjs
test: node --test src/release/sandbox/services.test.mjs
allow: [env_files]
---
# Part 22: database and cache sidecars for an app under test, as data

Many apps need a database to start (a web analytics app wants Postgres, others want MySQL, Redis or MongoDB). A profile can name sidecar services, and the sandbox starts them on a private network beside the app and gives the app
their connection strings through environment variables. This part is the catalog of services Behique knows, the check of a profile's `services` field, the resolution into everything the sandbox needs, and a deterministic proposer that
reads repository facts. It is pure: no process, no file, no network, no model. The code only mentions the file name `.env.example` as text in evidence sentences and never reads any file. The credentials are fixed test values (`behique`) for throwaway containers on a private network with no outside access; they are never real secrets.
No long dash character anywhere in the code, comments or messages.

## `services.mjs` must export

### `CATALOG`
An object keyed by `kind`, each with: `image` (a pinned tag), `port`, `env` (what the container needs), `tmpfs` (paths for its data), `caps` (a subset of `CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER`), `health` (an argv array run inside the container),
`cmd` (the image's own default command as an argv array, so a container can be created with an explicit command), `defaultVar` (the variable name injected when the profile names none), `url(host)` (the connection string) and `memoryMb`. Exactly these kinds:

- `postgres`: `postgres:16-alpine`, port 5432, env `POSTGRES_USER=behique, POSTGRES_PASSWORD=behique, POSTGRES_DB=app`, tmpfs `/var/lib/postgresql/data`, caps all five, cmd `['postgres']`, health `['pg_isready','-U','behique','-d','app']`, `defaultVar` `DATABASE_URL`, url `postgresql://behique:behique@<host>:5432/app`, memory 512.
- `mysql`: `mysql:8.4`, port 3306, env `MYSQL_ROOT_PASSWORD=behique, MYSQL_DATABASE=app`, tmpfs `/var/lib/mysql`, caps all five, cmd `['mysqld']`, health `['mysqladmin','ping','-h','127.0.0.1','-uroot','-pbehique']`, `DATABASE_URL`, url `mysql://root:behique@<host>:3306/app`, memory 768.
- `mariadb`: `mariadb:11.4`, port 3306, env `MARIADB_ROOT_PASSWORD=behique, MARIADB_DATABASE=app`, tmpfs `/var/lib/mysql`, caps all five, cmd `['mariadbd']`, health `['healthcheck.sh','--connect','--innodb_initialized']`, `DATABASE_URL`, url `mysql://root:behique@<host>:3306/app`, memory 768.
- `redis`: `redis:7-alpine`, port 6379, env `{}`, tmpfs `/data`, caps all five (the official image starts as root, fixes the data folder owner, then drops to its own user), cmd `['redis-server']`, health `['redis-cli','ping']`, `REDIS_URL`, url `redis://<host>:6379`, memory 256.
- `mongo`: `mongo:7`, port 27017, env `{}`, tmpfs `/data/db`, caps all five (same reason), cmd `['mongod','--bind_ip_all']`, health `['mongosh','--quiet','--eval','db.runCommand({ping:1}).ok']`, `MONGODB_URI`, url `mongodb://<host>:27017/app`, memory 768.

### `validateServices(list) -> string[]`
Problems as plain sentences (empty array when fine). A profile's `services` is optional; `list` is an array of `{ kind, name, inject }`. At most 4 entries; `kind` must be in `CATALOG`; `name` matches `^[a-z][a-z0-9-]{0,20}$` and is unique and is not `app`;
`inject` (optional) is an object whose keys pass `^[A-Z][A-Z0-9_]{0,63}$` (not starting `LD_` or `DOCKER_`) and whose values are one of `url`, `host`, `port`, `user`, `password`, `database`; at most 8 keys; no unknown properties on an entry. A non-array gives one problem.

### `resolveServices(list, { runId }) -> resolved[]`
For a list that passed validation (otherwise returns `[]`), one entry per service, in order: `{ name, kind, image, port, env, tmpfs, caps, cmd, health, memoryMb, alias, injected }`. `alias` is `name` (the host name other containers use). `injected` is the map of variable to value: if the entry has `inject`, each key gets the value
of its kind (`url` is `CATALOG[kind].url(alias)`, `host` the alias, `port` the port as a string, `user` `behique` (`root` for mysql and mariadb, empty string for redis and mongo), `password` `behique` (empty for redis and mongo), `database` `app`); otherwise `{ [defaultVar]: url }`. Same input always gives the same output (deep equal).
`runId` is only checked to be a non-empty string.

### `injectedEnv(resolved) -> object`
Merges every service's `injected` into one object; when two services set the same variable, the later one wins. Never mutates.

### `describeServices(list) -> string[]`
Lines for a person to read and approve, one per service: `service: <kind> (<image>) as <name>, injects <VAR, VAR>` (variable names sorted; the default var when `inject` is absent). Invalid entries are skipped.

### `proposeServices(facts) -> { services, evidence }`
`facts = { envExample, compose, packageJson }` where `envExample` is `{ file, lines } | null` (the lines are raw text lines like `DATABASE_URL=postgresql://user:pass@localhost:5432/db`), `compose` is `{ file, services } | null` (names only) and `packageJson` is `{ dependencies, devDependencies } | null`. Missing or malformed pieces are ignored; it never throws.
Rules, applied in this order, at most one service per kind, result sorted by kind:
1. Each `envExample` line `KEY=VALUE` (optionally `export `, optional quotes) whose value starts with `postgres://` or `postgresql://` proposes `postgres`; `mysql://` proposes `mysql`; `mongodb://` or `mongodb+srv://` proposes `mongo`; `redis://` or `rediss://` proposes `redis`. The key becomes `inject: { KEY: 'url' }` (several keys for one kind are all kept, at most 8). Confidence `high`.
2. Each compose service name matched case-insensitively: contains `postgres` or equals `pg` proposes `postgres`; contains `mysql` proposes `mysql`; contains `mariadb` proposes `mariadb`; contains `redis` or `valkey` proposes `redis`; contains `mongo` proposes `mongo`. No `inject` (the default variable is used) unless rule 1 already found keys for that kind. Confidence `high`. (A compose name of `db` or `database` on its own proposes nothing.)
3. Dependencies (in either dependencies list): `pg`, `postgres` or `pg-promise` propose `postgres`; `mysql2` or `mysql` propose `mysql`; `ioredis` or `redis` propose `redis`; `mongodb` or `mongoose` propose `mongo`. Confidence `low`, only when the kind was not found by rules 1 or 2.
`services` entries are `{ kind, name, inject? }` with `name` equal to `kind` (so `postgres`, `redis`), and they always pass `validateServices`. `evidence` is an array of plain sentences, one per proposed service, saying why (`.env.example sets DATABASE_URL to a postgres address`, `compose.yml has a service named redis`, `package.json depends on pg`), with the confidence.

## Tests (offline)

Cover: each catalog entry has every field and `health` is an array of strings; `validateServices` good and bad cases (unknown kind, five entries, duplicate name, name `app`, bad inject key `LD_PRELOAD`, bad inject value, unknown property, non-array); `resolveServices` for each kind (alias, default var, `inject` for each value kind, deterministic); `injectedEnv` merge and no mutation; `describeServices` lines; `proposeServices`: DATABASE_URL postgres in `.env.example`, a quoted value, `export` prefix, a redis URL, a mongodb+srv URL, two postgres keys kept, a compose `postgres` and `redis`, compose `db` alone proposing nothing, dependencies giving low confidence, a kind found by env not repeated by compose or deps, empty or malformed facts (null, strings, numbers) giving `{ services: [], evidence: [] }`, and that every proposed list passes `validateServices`.
