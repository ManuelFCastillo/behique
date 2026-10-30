---
part: docker-args
owns:
  - src/release/sandbox/docker-args.mjs
  - src/release/sandbox/docker-args.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/onboard/profile.mjs
test: node --test src/release/sandbox/docker-args.test.mjs
allow: []
---
# Part 20: the policy for every docker command Behique runs against untrusted code

Third-party repositories are run inside Docker (on a Mac with OrbStack, or on a Linux server over ssh). On the server the account is in the `docker` group, which is root-equivalent, so the arguments of every
`docker` command must be built by code from validated pieces, and nothing that came from a repository, a model or a web page may ever become a docker flag. This part is that code: pure functions that take plain
data and return an argument array (without the leading `docker`), or a refusal. No process is started, no file is read, nothing touches the network. Every function never throws: a bad input gives `{ ok: false, error }`.
Write errors as plain sentences. No long dash character anywhere.

## `docker-args.mjs` must export

### Constants and validators

- `LABEL = 'behique'`. Every container, network and volume made here carries the labels `behique=1` and `behique.run=<runId>`, so cleanup can find them.
- `isRunId(s)`: `^[a-z0-9]{6,16}$`. `isShortName(s)`: `^[a-z0-9][a-z0-9-]{0,30}$`. `isImage(s)`: a Docker Hub image with a pinned tag: `^[a-z0-9][a-z0-9._/-]{0,80}:[A-Za-z0-9._-]{1,64}$`, where the tag is not `latest`, and no registry host is allowed (the first path segment must not contain a `.` or a `:`), and no `@`.
- `isEnvKey(s)`: `^[A-Z][A-Z0-9_]{0,63}$`, and not starting with `LD_` or `DOCKER_`. `isEnvValue(s)`: a string of at most 2,000 characters with no newline, carriage return or NUL.
- `ALLOWED_CAPS = ['CHOWN','SETUID','SETGID','DAC_OVERRIDE','FOWNER']` (the only capabilities that can ever be added back).
- `names(runId, short)` returns `bq-<runId>-<short>` (both validated; invalid gives `null`). This is the name of containers, networks and volumes.

### Builders (each returns `{ ok: true, args }` or `{ ok: false, error }`)

- `networkCreateArgs({ runId, short, internal })`: `network create --driver bridge [--internal] --label behique=1 --label behique.run=<runId> <name>`.
- `volumeCreateArgs({ runId, short })`: `volume create --label behique=1 --label behique.run=<runId> <name>`.
- `networkConnectArgs({ runId, networkShort, containerShort, aliases = [] })`: `network connect [--alias <a> ...] <network name> <container name>`; aliases pass `isShortName`.
- `startArgs({ runId, short, attach = false })`: `start [-a] <container name>`.
- `createArgs(plan)` and `runArgs(plan)`: `create ...` and `run ...` with exactly the same flags (see below); `runArgs` adds `-d` when `plan.detach` and `--rm` when `plan.rm`; `createArgs` never has either.
- `execArgs({ runId, short, cmd, env = {}, workdir })`: `exec` with `--workdir`, `--env KEY=VALUE` per key, then the container name, then `cmd`.
- `inspectIpArgs({ runId, short, networkShort })`: `inspect --format {{(index .NetworkSettings.Networks "<network name>").IPAddress}} <container name>`.
- `listArgs({ runId, kind })` where `kind` is `container`, `network` or `volume`: `ps -aq --filter label=behique.run=<runId>`, `network ls -q --filter label=behique.run=<runId>`, `volume ls -q --filter label=behique.run=<runId>`.
- `listAllArgs({ kind })`: the same with `--filter label=behique=1` (used to clean up after a crash).
- `removeArgs({ kind, ids })`: `rm -f -v <ids>` for containers, `network rm <ids>`, `volume rm -f <ids>`. Every id must be 12 to 64 lowercase hex characters or a name starting `bq-`; at least one id.
- `initVolumeArgs({ runId, short, image, uid = 1000, gid = 1000 })`: a one-off `run --rm` as user `0:0` with `--cap-drop=ALL --cap-add=CHOWN --security-opt=no-new-privileges --network none`, the volume mounted at `/work`, running `chown <uid>:<gid> /work`.

### The plan and its rules (`createArgs` and `runArgs`)

`plan = { runId, short, role, image, networks, aliases = [], volume, workdir, user = '1000:1000', cmd, env = {}, tmpfs = [], caps = [], limits, interactive = false, detach = false, rm = false, readOnly = true }`.

- `role` is one of `install`, `app`, `service`, `seed`. `networks` is a non-empty array of short names; only the FIRST is put on the command (`--network <name>`), the caller connects the rest with `networkConnectArgs`. The first network alias flags (`--network-alias`) come from `aliases`.
- Every command starts with the verb, then `--name <name> --label behique=1 --label behique.run=<runId> --label behique.role=<role>`.
- ALWAYS present, whatever the plan says: `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--pids-limit <n>`, `--memory <n>m`, `--memory-swap <n>m` (equal to memory, so no swap), `--cpus <n>`, and `--init`.
- `readOnly` true adds `--read-only` (default). Only the roles `service` may set it to false. `tmpfs` entries are absolute paths matching `^/[A-Za-z0-9_./-]{1,100}$` and become `--tmpfs <path>:rw,nosuid,size=512m`; always add `--tmpfs /tmp:rw,nosuid,size=1g` unless `/tmp` is listed.
- `caps` may only contain `ALLOWED_CAPS` and only for the role `service` (each becomes `--cap-add=<CAP>`); any other role with caps is refused.
- `user` is `<uid>:<gid>` of digits and must not be `0:0` or `root`. The one exception: for the role `service` only, `user` may be `null`, meaning the image's own default user (the official database images start as root, fix the ownership of their data folder, then drop to their own user; this works with all capabilities dropped except the ones in `caps`). For every other role `null` is refused. The only explicit root command is `initVolumeArgs`.
- `volume` is `{ short, path }` or `null`: it becomes `--volume <name>:<path>` where the name comes from `names(runId, short)` (never a host path, never a bind mount, never a docker socket) and `path` is an absolute path matching `^/[A-Za-z0-9_./-]{1,100}$` (usually `/work`). `workdir` is an absolute path of the same form and becomes `--workdir`.
- `env` becomes `--env KEY=VALUE` pairs in sorted key order; invalid keys or values refuse the whole plan. At most 60 pairs.
- `limits = { memoryMb, cpus, pids }`: `memoryMb` an integer 64 to 16,384, `cpus` a number 0.25 to 16, `pids` an integer 16 to 4,096. Missing or out-of-range refuses the plan (no defaults, so a caller cannot forget).
- `interactive` adds `-i`. There is never a `-t`, never `--privileged`, never `--publish` or `-p` (apps are reached by the container's address on a private network, not a published port), never `--volumes-from`, `--device`, `--pid`, `--ipc`, `--userns`, `--cgroup-parent`, `--security-opt` other than the one above, `--add-host`, `--dns`, `--entrypoint`, `--mount` or `--env-file`.
- `image` must pass `isImage`. The image goes after all flags, then `cmd`: an array of 1 to 50 strings, each at most 4,000 characters with no NUL, and the first not starting with `-`.
- A plan with any property not listed above is refused (`Unknown option: <name>.`), so a new flag can only be added here, in code.

## Tests (offline, no docker)

Cover: each validator on good and bad values (a registry host, `:latest`, no tag, an `@sha256` digest, uppercase run id, bad env keys such as `LD_PRELOAD` and `DOCKER_HOST`, a value with a newline); the exact argument arrays for `networkCreateArgs` (internal and not), `volumeCreateArgs`, `networkConnectArgs`, `startArgs`, `execArgs`, `inspectIpArgs`, `listArgs`, `removeArgs` (bad ids refused), `initVolumeArgs`; for `createArgs`/`runArgs`: a full good plan for each role gives the exact array, the always-present flags are present for every role, `-d` and `--rm` only on `runArgs`, caps only for service and only from the allowed list, root user refused, `user: null` accepted for a service and refused for the other roles, a bind-mount-looking volume (`/etc:/work`, `..`) refused, an unknown property refused, env sorted, limits out of range refused, `cmd` starting with `-` refused, and a property-based check: for a few hundred generated plans (deterministic seeded generator, mixing good and hostile values such as strings with spaces, `--privileged`, `$(id)`, newlines) every `ok: true` result contains none of `--privileged`, `-p`, `--publish`, `--mount`, `--device`, `--entrypoint`, `docker.sock`, a path starting `/etc`, `/var/run`, `/root` or `/Users`, and every `ok: false` result has an `error` string.
