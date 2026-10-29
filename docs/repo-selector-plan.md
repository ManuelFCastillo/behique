# Repo selector (left sidebar): plan and state

Asked 2026-10-29: FreshRSS built in, plus the user's GitHub repos listed through the existing `gh` login, read-only. Ask before cloning anything.

## Done (new files only, no shared file touched)
- `src/release/github.mjs`: read-only reader. Runs exactly two fixed `gh` calls (`api user`, `repo list --json`), no argument ever comes from user input, nothing is cloned. GitHub data is untrusted (names validated, links only if plain `https://github.com/<owner>/<name>`, descriptions cut to 300 characters, errors scrubbed of token-like text). 60 s cache, successes only. A test checks every command it issues against a read-only allow-list.
- `src/release/appregistry.mjs`: built-in apps first (FreshRSS, `runnable: true`), then the account's repos as `github:<owner>/<name>` with `runnable: false`, `status: needs-setup`. `appOfOpened()` says which app a saved report belongs to.
- Tests: `github.test.mjs` (8), `appregistry.test.mjs` (4). Checked once against the real login: connected, 47 repos (27 private, 11 forks, no organisations), 4.2 s first call, 0 ms cached, no token-like text in the output.

## Wired after the Ship/Hold session finished (DONE 2026-10-29)
1. `demo/server.mjs`: `GET /api/ui/repos[?refresh=1]` returning `listApps()`; add `app` to each entry of `GET /api/ui/cases` (via `appOfOpened`). Keep `GET /api/ui/apps` as it is (the New run dialog uses it).
2. `~/dev/behique-ui/behique-live.html`: an Apps section in the left sidebar above the report picker. FreshRSS first (selected by default), then a "Your GitHub repos" group with a search box, each row showing name, private/public, language, fork, and a "needs setup" chip; a line "GitHub: connected as <login> . refresh" (or the reason it is not connected). Selecting FreshRSS shows what exists now. Selecting a repo shows a panel (description, last push, default branch, link to GitHub, why it cannot run yet) and disables New run with that explanation. The report picker follows the selection. Selection is kept in the URL (`?app=`) and in localStorage.

## Not in this piece
- Cloning, listing tags or branches of a repo, a setup config for a repo, container isolation, organisations. Each needs its own go-ahead; cloning needs an explicit yes per repo.
- A repo can only become runnable once it has a setup (how to install, start, which port, seed data, which clicks). That is the real work for the first non-FreshRSS app.

## Risks to keep in mind
- Running a repo's code executes its install scripts and server: run in a container with a cleaned environment before anything that is not the user's own code.
- "Ask the model" sends a code diff to Meta's API: private repos need a per-repo opt-in, off by default.
- `gh` login is the machine's login: fine for one person, not a sharing story.
