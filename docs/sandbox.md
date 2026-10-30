# Sandbox: running untrusted repos in Docker (Phase 4)

Built 2026-10-30. Third-party code (a cloned repo's install steps, build and dev server, plus database sidecars) runs in Docker, on this machine's engine (OrbStack) or on hardac2 over ssh. Nothing from the repository runs on the Mac.

## Use it

```
BEHIQUE_SANDBOX=docker:ssh://hardac2 node bench/onboard-bench.mjs verify todomvc
BEHIQUE_SANDBOX=docker node src/release/check-app.mjs <app> <good> <cand>    # local engine
node src/release/sandbox/clean.mjs --target ssh://hardac2 --minutes 120       # remove what a crashed run left behind
```
Settings (all optional): `BEHIQUE_SANDBOX_IMAGE` (default `node:22-bookworm`, a pinned Docker Hub tag), `BEHIQUE_SANDBOX_MEMORY_MB` (default 4096; `next build` needs about 10240), `BEHIQUE_SANDBOX_CPUS` (default 4). A value it does not understand is an error, never a silent fallback to the host. Only apps set up from a profile run in the sandbox; the built-in FreshRSS adapter (PHP) still runs on the host. Profiles using `python3` or `php` are refused in the sandbox for now.

## Pieces (src/release/sandbox/)

| File | Job | Made by |
|---|---|---|
| `docker-args.mjs` | The policy: builds every docker argument array from validated parts, refuses anything unsafe (no privileged, no published ports, no host mounts, caps dropped, limits required, pinned Docker Hub images only) | Muse (spec 20), reviewed and fixed by hand |
| `services.mjs` | Catalog of sidecars (postgres, mysql, mariadb, redis, mongo), profile `services` check, resolution to env variables, proposer from repo facts | Muse (spec 22) |
| `sandbox.mjs` | One sandbox's life: networks, volume, seed, services, install, app, logs, destroy, `cleanStale` | Muse (spec 21), reviewed and fixed by hand |
| `docker-exec.mjs`, `tunnel.mjs`, `backend.mjs`, `launch.mjs`, `clean.mjs` | The docker runner (local or ssh), port forwarding, the `startBuild` backend, the in-container launcher, cleanup command | by hand |

## How a run goes

1. A private `open` network and an `internal` network (no outside access), and a volume. The repo (no `.git`, no `node_modules`) is copied in as a tar by a container running as uid 1000.
2. Sidecars start on the internal network under their name (`db`, `redis`...) with throwaway test credentials; Behique waits for their health check.
3. Install steps run on both networks (the package registry is reachable), as uid 1000, scripts disabled, read-only root, all capabilities dropped, memory/CPU/process limits.
4. The app runs on the internal network ONLY: it cannot reach the internet. It is started through `launch.mjs`, which also relays the container address to a server that listens only on localhost (vite, vitepress and most dev servers do). The relay is bound only after the app is seen to listen on localhost alone: bound earlier it makes an app that listens on every address (next dev, the static server) fail with EADDRINUSE. Behique reaches it by its address (a local forwarder, or `ssh -L` to hardac2), so the app is always `http://127.0.0.1:<port>` for everything else in Behique.
5. Everything is removed at the end (containers, networks, volume), labelled `behique=1` so `clean.mjs` can find leftovers.

## Measured (2026-10-30, hardac2)

- First-party smoke app + Postgres sidecar: up in 3.6 s, the app reached `db:5432` by name, ran as uid 1000, and an outbound connection to the internet failed (`ENETUNREACH`). No containers, networks or volumes left.
- todomvc (static): VERIFIED by `onboard-bench verify` (build, pictures, noise floor).
- html5-boilerplate (`npm ci` + `npm run build` inside the sandbox): built and served; the "app is alive" check failed because the page is nearly blank by design (emptiness 0.999). Not a sandbox problem.
- umami v3.3.1 with a Postgres sidecar: `pnpm install`, `pnpm run build` and `next start` ran in the sandbox, `/login` answered 200 ("Login | Umami"). Needed 10 GB (a 4 GB limit was OOM-killed), the full Node image (the slim one lacks openssl, which Prisma needs) and a corrected start command (the model's `run start -- -p {port}` passes a literal `--` with pnpm). A good repair-loop case.

- Baseline of the six proposals as written: 1 of 6 pass (and 6 of 6 verified after the repair loop, see `docs/onboarding-baseline.md`), see the table in `docs/onboarding-baseline.md` (nextjs-blog and vitepress hit the `-- -p` problem, excalidraw's command does not fit v0.17.6).

## Known limits

- Isolation is Docker (runc) on a machine where the account is in the `docker` group, which is root-equivalent there. Fine for the repos tried so far; before pointing it at arbitrary repos, move to Firecracker (hardac2 has KVM) or gVisor.
- The sidecar proposer now reads compose `image:` lines (umami's `db` is postgres:15-alpine). A stalled install has no inactivity watchdog, only the 15 minute step timeout.
- No data is seeded (Phase 3). Sidecars start empty; apps that create their own tables on build (umami) work, others may not.
- The seed copies the whole checkout over docker; large repos with big assets are slow over ssh.
