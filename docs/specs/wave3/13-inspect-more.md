---
part: inspect-more
owns:
  - src/release/onboard/inspect-more.mjs
  - src/release/onboard/inspect-more.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/onboard/inspect.mjs
test: node --test src/release/onboard/inspect-more.test.mjs
allow: [env_files]
---
# Part 13: more facts about a repository, read without running anything

When a model proposes how to run a repo it only sees the top-level folder, the root `package.json`, one lockfile name and the first 3,000 characters of the README (see `inspect.mjs`).
It therefore guesses: a root `start` script that delegates into a workspace, a framework's port flag, where the real app lives, which package manager the repo wants. This part reads
more, deterministically, with plain file reads. It never runs, installs or imports anything from the repository and never follows symbolic links. A person wires it into `inspectRepo` afterwards.

## `inspect-more.mjs` must export `inspectMore(repoPath) -> Promise<object>`

It never throws (any problem leaves that field empty). It reads at most 200 files in total and never a file larger than 200,000 bytes. Directories named `node_modules`, `.git`, `.next`, `.cache`, `vendor` and `target` are never entered.
The result has exactly these fields:

```
{
  packageManager: { name: 'npm'|'pnpm'|'yarn'|'bun'|null, version: string|null, source: 'packageManager field'|'lockfile'|null },
  engines: { node: string|null },
  nodeVersionFile: string|null,
  workspaces: [{ dir, name, scripts }],
  frameworks: [string],
  envExample: { file, lines } | null,
  compose: { file, services } | null,
  staticRoots: [{ dir, hasIndexHtml: true }]
}
```

- **packageManager.** First the root `package.json` field `packageManager` (for example `pnpm@9.1.0+sha512...`: name before the `@`, version after it up to a `+`; only names npm, pnpm, yarn, bun are accepted), `source: 'packageManager field'`. Otherwise by lockfile in this order: `pnpm-lock.yaml` (pnpm), `yarn.lock` (yarn), `package-lock.json` (npm), `bun.lockb` or `bun.lock` (bun), `source: 'lockfile'`, `version: null`. Otherwise all `null`.
- **engines.node** is `engines.node` of the root `package.json` or `null`. **nodeVersionFile** is the trimmed first line (at most 20 characters) of `.nvmrc` or `.node-version`, or `null`.
- **workspaces.** Directories of workspace packages, from the root `package.json` `workspaces` (an array, or an object with a `packages` array) or from the `packages:` list of `pnpm-workspace.yaml` (read simple lines of the form `  - 'packages/*'`). Support patterns that are a plain relative directory (`excalidraw-app`) or end in `/*` (`packages/*`, one level). Ignore patterns with `!`, `**` or `..`. For each existing directory with a `package.json` return `{ dir: <relative path>, name: <package name or null>, scripts: <up to 12 scripts as name -> command cut at 120 characters> }`. At most 8 workspaces, sorted by `dir`.
- **frameworks.** From files at the repository root or one level inside a workspace directory, in this order of names: `vite.config.*` gives `vite`; `next.config.*` gives `next`; `nuxt.config.*` gives `nuxt`; `astro.config.*` gives `astro`; `svelte.config.*` gives `svelte`; `angular.json` gives `angular`; `webpack.config.*` gives `webpack`; `gatsby-config.*` gives `gatsby`; `remix.config.*` gives `remix`; `docusaurus.config.*` gives `docusaurus`; `.eleventy.js` or `eleventy.config.*` gives `eleventy`; `_config.yml` gives `jekyll`; `hugo.toml` or `hugo.yaml` or `config.toml` gives `hugo`; `mkdocs.yml` gives `mkdocs`. Also `vitepress` when a `.vitepress` directory exists at the root or in a top-level `docs` directory. Unique names, in the order found, at most 8.
- **envExample.** The first existing file of: `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `example.env`, `env.example` in the root, then in each workspace directory. `{ file: <relative path>, lines: <the first 40 lines, each cut at 160 characters, trailing whitespace removed> }`. **Never read a file named `.env` or any other `.env.*` file that is not in that list** (for example `.env.local`, `.env.production`); a test must prove such files are never opened.
- **compose.** The first existing of `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml` in the root: `{ file, services }` where `services` are the names found as keys one level under a top-level `services:` line (two or four space indent followed by `name:`), at most 12.
- **staticRoots.** Directories with an `index.html` directly inside, found among: the root itself (`'.'`), and directories at depth 1 or 2 below the root (for example `src`, `public`, `docs`, `dist`, `examples/react`). At most 8, `.` first, then sorted by path. Report only directories that have the file, so `hasIndexHtml` is always `true`.

## Tests (offline, real temporary directories made with `mkdtempSync(join(tmpdir(), ...))`)

Build small fake repositories in temp directories and assert on the result. Cover: each way of finding the package manager (field with and without a `+hash`, each lockfile, none, a field naming something unknown falls back to the lockfile); `engines` and `.nvmrc`; workspaces from `package.json` arrays, from the object form, and from `pnpm-workspace.yaml`, with `!` and `**` patterns ignored and the scripts truncated and limited; frameworks; `.env.example` lines truncated and limited, and `.env`, `.env.local` and `.env.production` present in the same directory are never read (make them unreadable or put a marker string in them that must never appear in the result, and also check by wrapping nothing: the result must not contain the marker); compose services; static roots at depth 1 and 2 and the root, with `node_modules/x/index.html` ignored; a symlinked directory is not followed; a missing or empty directory returns every field empty and does not throw; a path that is a file does not throw.
