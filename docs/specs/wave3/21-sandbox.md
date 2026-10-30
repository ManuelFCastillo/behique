---
part: sandbox
owns:
  - src/release/sandbox/sandbox.mjs
  - src/release/sandbox/sandbox.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/sandbox/docker-args.mjs
  - src/release/sandbox/services.mjs
test: node --test src/release/sandbox/sandbox.test.mjs
allow: []
---
# Part 21: the life of one sandbox, from an empty network to nothing left behind

A sandbox runs ONE untrusted app at ONE commit inside Docker, with its sidecars (see `services.mjs`), and always cleans up. This part is the lifecycle logic. It never starts a process itself: the `docker` command is an injected function,
so every test is offline with a fake that records the argument arrays and answers from a script. Every docker command is built with `docker-args.mjs` (read it: its builders return `{ ok, args }`; if `ok` is false the step fails with that error and docker is not called).
Output from the app, the install and the services is untrusted text: it is kept (tail only), never interpreted. No long dash character anywhere.

## Injected collaborators

- `docker(args, { input, timeoutMs }) -> Promise<{ code, stdout, stderr }>`: runs `docker` with that argument array and no shell. `input` is a Buffer written to stdin when present. Rejects only for a spawn failure or a timeout (the rejection message contains `timed out` for a timeout).
- `pack(dir) -> Promise<Buffer>`: a tar archive of the directory (the caller excludes `.git` and `node_modules`).
- `sleep(ms)`, `now()`, `log(line)`: defaults `setTimeout`, `Date.now`, a no-op. Tests pass instant fakes.
- `newRunId() -> string`: default 10 random lowercase letters and digits; it must pass `isRunId`.

## `sandbox.mjs` must export

### `createSandbox({ docker, pack, sleep, now, log, newRunId, image, limits }) -> sandbox`
`image` is the base image for install and app steps (for example `node:22-bookworm-slim`; it must pass `isImage` or every step fails with that error). `limits` is `{ memoryMb, cpus, pids }` for the install and app containers (default `{ memoryMb: 4096, cpus: 4, pids: 1024 }`).
Names (short names): networks `open` and `int`, volume `work`, containers `install-<n>` (n counts from 1), `app`, and `svc-<service name>`. The working directory in every container is `/work`, `HOME` is `/work/.home`, the volume is mounted at `/work`.

`sandbox` has these methods. All are async, none throws; each returns `{ ok: true, ... }` or `{ ok: false, error, logs? }` where `error` is one plain sentence and `logs` is a cleaned tail (see below). After a failure the caller still calls `destroy`.

- `runId` (property): the id.
- `prepare({ dir })`: creates the networks (`open` normal, `int` internal), the volume, runs `initVolumeArgs` (so the volume belongs to uid 1000), then extracts `await pack(dir)` into the volume with a one-off `runArgs` plan (role `seed`, `interactive: true`, `rm: true`, `detach: false`, `cmd: ['tar','-xf','-','-C','/work']`, networks `['int']`, `readOnly: true`, user `1000:1000`) passing the archive as `input`. Order matters and is tested: network open, network int, volume, init volume, seed. A nonzero exit from any step fails with the stderr's first line.
- `startServices(resolved, { timeoutMs = 90000 })`: `resolved` is the output of `resolveServices`. For each service: a detached `runArgs` plan (role `service`, container short name `svc-<name>`, network `int`, `aliases: [alias]`, the service's `image`, `env`, `tmpfs`, `caps`, `readOnly: false`, `user: null` (the image's default), `cmd` is the service's `cmd`). A service entry without an array `cmd` fails the call with `Service <name> has no start command.`
  After starting a service, wait until its `health` command succeeds: loop `execArgs` with the service's health argv until exit code 0, sleeping 1,000 ms between tries, until `timeoutMs` has passed on `now()`; a service that never becomes healthy fails with `Service <name> did not become ready within <n> seconds.` and `logs` taken from `docker logs --tail 200 <container>` (build these args in this file with the literal array `['logs','--tail','200', <container name from names()>]`).
- `install(steps, { env = {}, timeoutMs = 900000 })`: `steps` is an array of `{ cmd, args }` (the profile's install items). For each step, in order: `createArgs` (role `install`, short name `install-<n>`, network `open`, the base image, user `1000:1000`, `cmd: [step.cmd, ...step.args]`, env = `env` plus `HOME=/work/.home` and `CI=1`, limits from the sandbox), then `networkConnectArgs` to join network `int`, then `startArgs` with `attach: true`, with `timeoutMs` for the whole step; then remove that container with `removeArgs`. Stop at the first nonzero exit: `{ ok: false, error: 'Step <n> (<cmd> <first arg>) exited with code <code>.', logs }`. On success `{ ok: true, steps: [{ n, cmd, code: 0, tail }] }`.
- `startApp({ cmd, args, env = {}, port })`: one detached `runArgs` plan (role `app`, short `app`, network `int` ONLY, the base image, user `1000:1000`, env plus `HOME` and `PORT=<port>`, limits). Then `inspectIpArgs` on network `int`: the output must look like an IPv4 address, otherwise `{ ok: false, error: 'Could not find the app address.' }`. Returns `{ ok: true, host: <ip>, port }`.
- `logs(lines = 200)`: `docker logs --tail <lines>` of the app container (lines is an integer 1 to 1000), returned as `{ ok: true, text }` with the text cleaned.
- `running()`: `{ ok: true, running: boolean }` from `docker inspect --format {{.State.Running}}` of the app container (the literal array, with the validated name).
- `destroy()`: idempotent and safe to call at any time, even before `prepare`. Lists containers, then networks, then volumes by `listArgs` for this run id, removes containers first, then networks, then the volume, ignoring individual failures, and returns `{ ok: true, removed: { containers, networks, volumes } }` with counts. Calling it twice is harmless.

### `cleanStale({ docker, olderThanMinutes = 120 })`
Lists everything labelled `behique=1` (with `listAllArgs`) for containers, networks and volumes, asks `docker inspect --format {{.Created}} <id>` for each container and removes those created more than `olderThanMinutes` ago (use the Date parse of the output; unparseable means skip it), plus any networks and volumes of the same run ids (learn the run id from the name `bq-<runId>-...`). Returns `{ ok: true, removed }`. Never throws.

### `cleanLog(text, max = 3000) -> string`
The last `max` characters, with ANSI escape sequences and control characters other than newline and tab removed and token-looking runs of 32 or more letters, digits, `-`, `_`, `+` or `/` replaced by `[redacted]`. Non-strings give `''`.

## Tests (offline, fake docker)

The fake records every call and answers `{ code: 0, stdout: '', stderr: '' }` by default; a script can override by matching the first args. Cover: `prepare` call order and that the seed call gets the archive as `input` and the five-step order; a failing network creation stops `prepare` without further calls; `startServices` waits for health (fails twice then succeeds; never healthy times out with a fake clock and returns the container logs; missing `cmd` refused); `install` runs steps in order, each as create then connect then start with attach, removes each container, stops at the first failure with the code and a cleaned tail, passes `CI=1` and `HOME`; the install container is on `open` and `int` while the app container is on `int` ONLY (assert on the recorded arrays: the app plan has `--network bq-<id>-int` and no connect to `open`); `startApp` returns the address from the fake inspect, rejects a non-IP answer; every recorded docker call starts with a known verb and none contains `--privileged`, `-p ` or a host path; `destroy` removes in order containers, networks, volume, tolerates failures, works before `prepare`, and twice; `cleanStale` removes only old ones and ignores unparseable dates; `cleanLog` rules; a throwing `docker` (rejection) turns into `{ ok: false, error }` and never propagates; an invalid `image` fails every step with the docker-args error and docker is never called.
