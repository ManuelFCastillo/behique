# Onboarding baseline (2026-10-30)

What the set-up does on six real public web repos, and what is NOT known yet.

## What was and was not measured

- **Measured:** for each repo, what the model proposes from the facts Behique gives it (two rounds: before and after the richer facts of Phase 1). Cost about $0.15 in all.
- **NOT measured:** whether any proposal actually builds, starts and shows a page. The verification run (`node bench/onboard-bench.mjs verify ...`) was blocked: the safety check stopped it because it would install dependencies and start dev servers from freshly cloned third-party repos, unattended. Nothing from those repos was installed or executed. So every statement about "would this work" below is a prediction from reading the proposal, not a result.

## The six repos (partial clones in `~/dev/behique-apps`)

| Repo | Kind | Round 1 (old facts) | Round 2 (richer facts) |
|---|---|---|---|
| html5-boilerplate | static site, app is in `src/` and built to `dist/` | static serve of the repo root (no `index.html` there, so a blank page is likely) | `npm ci`, `npm run build`, static serve of `dist` |
| nextjs-blog (tailwind-nextjs-starter-blog) | Next.js, yarn 3 | `yarn dev -- --port {port}` (Next uses `-p`) | `yarn run dev -- -p {port}` |
| excalidraw | Vite + React, yarn workspaces | `yarn start` (port unknown) | `yarn workspace excalidraw-app start --port {port}` |
| vitepress | docs tool, pnpm workspaces | `pnpm run docs:dev` | `pnpm install`, `pnpm run build`, `pnpm --filter docs dev -- --port {port}` |
| umami | Next.js, needs PostgreSQL | `pnpm run dev` | `pnpm install`, `pnpm run build`, `pnpm run start -- -p {port}`; its notes say plainly it needs a database |
| todomvc | static landing page linking to examples | static serve of the root | the same (the model says the real surface is an example sub-page) |

## What the baseline shows

1. **The model guessed because it could not see.** Round 1 saw the top-level folder, the root `package.json` and 3,000 README characters. It could not see workspace scripts, the package manager a repo pins, the framework, the example env file, the compose file or which folders hold an `index.html`. Round 2 adds those (`inspect-more.mjs`), and four of six proposals became materially more specific. The model also said what it could not know: umami's notes name the database requirement.
2. **Three real gaps in the profile format**, all fixed in Phase 1: no environment variables (`serve.env`), no static sub-folder (`serve.root`), no build step for a static site (`serve.install` now allowed there).
3. **Toolchain.** `yarn` and `pnpm` are not installed on this machine. Behique now provides them through corepack shims placed last on PATH (nothing global changes, a real one wins), and install steps never run the repository's lifecycle scripts unless a person approves that.
4. **A bug found on the way:** a dev server started through `yarn` or `npm` leaves its own child behind when only the first process is killed, and that child keeps the port, so the next build would collide with it. Builds now stop the whole process group (tested).
5. **A validation rule was too broad:** `-p` was rejected everywhere as inline code (it is `node --print`, but also Next's port flag). The rule is now per program.
6. **What the 2 failed round-2 proposals were:** a harness bug (a stale error from the first attempt was carried over), not a model failure. Fixed.

## Predictions (unverified)

- Likely to work: html5-boilerplate, nextjs-blog, todomvc (as a landing page only).
- Might work: excalidraw, vitepress (port handling and build time unknown).
- Expected to fail: umami (needs a database; Behique cannot supply one).

## To measure for real

Run the verification in an isolated environment (a container, the Phase 4 work) or with each proposal's commands read and approved by a person first:

```
node bench/onboard-bench.mjs verify html5-boilerplate todomvc            # static, nothing installed
node bench/onboard-bench.mjs verify nextjs-blog excalidraw vitepress     # installs with scripts disabled
```


## Measured in the sandbox (2026-10-30, hardac2, proposals exactly as the model wrote them)

Nothing from these repos ran on the Mac: installs, builds, dev servers and the Postgres sidecar ran in Docker on hardac2 (see `docs/sandbox.md`). Command lists were read before running.

| Repo | As proposed | Why / what it took |
|---|---|---|
| todomvc | **PASS** (build, pictures, noise floor) | static, nothing to run |
| html5-boilerplate | builds and serves, "app is alive" check **FAILS** | `npm ci` + `npm run build` worked; the page is almost blank by design (emptiness 0.999), so the check is too strict for minimal pages |
| nextjs-blog | **FAIL** | server exits at once: `yarn run dev -- -p {port}` passes the `--` through under yarn Berry ("Invalid project directory: /work/-p"). Install itself works after the Berry fix |
| excalidraw | **FAIL** | server exits: `yarn workspace excalidraw-app start` does not fit v0.17.6 ("Cannot find the root of your workspace"); the proposal was written from newer-looking facts |
| vitepress | **FAIL** | no answer within 30 s; probably the same `pnpm ... -- --port {port}` problem (not diagnosed) |
| umami | not run by the bench (proposal had no database) | run by hand with a Postgres sidecar and the start command corrected: **up**, `/login` 200 |

So: **1 of 6 pass as proposed; 3 more work with one small correction each** (nextjs-blog, umami, html5-boilerplate's check), 2 not diagnosed to the end. Every failure here is exactly what the repair loop is for (it gets the app's last output); the loop is still untested on a real failure because it needs a person to approve each changed command. The earlier row "NOT measured" above is superseded by this table.
