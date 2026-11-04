---
part: jellyfin-seed-bootstrap
owns:
  - tools/jellyfin-seed/bootstrap.mjs
  - tools/jellyfin-seed/bootstrap.test.mjs
test: node --test tools/jellyfin-seed/bootstrap.test.mjs
---
# Part 03: take a fresh Jellyfin server to a finished install, with no typing

Behique's crawler never types, and a fresh Jellyfin opens on a first-run wizard. This part finishes the wizard through the server's API, adds the libraries, waits for the scan and proves the result. A script bakes the finished server into an image afterward.

## Facts measured on jellyfin/jellyfin:12.4 (use exactly these)

JSON property names are PascalCase, except that `/System/Info/Public` answers in camelCase (`startupWizardCompleted`). Read that one field under either casing. Every request sends `Content-Type: application/json` and `Authorization: MediaBrowser Client="seed", Device="seed", DeviceId="seed", Version="1"`, with `, Token="<token>"` appended once logged in.

1. `GET /Startup/Configuration` answers 503 while the server starts, then 200. Ready means 200.
2. `POST /Startup/Configuration` with `{ UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' }` answers 204.
3. `GET /Startup/User` answers 200 and must be called before the next step. `POST /Startup/User` with `{ Name, Password }` answers 204.
4. `POST /Startup/RemoteAccess` with `{ EnableRemoteAccess: false, EnableAutomaticPortMapping: false }` answers 204. `POST /Startup/Complete` answers 204.
5. `POST /Users/AuthenticateByName` with `{ Username, Pw }` answers 200 with `{ User: { Id, Policy }, AccessToken }`.
6. `POST /Library/VirtualFolders?name=<name>&collectionType=<movies|tvshows>&refreshLibrary=false` with `{ LibraryOptions }` answers 204. `LibraryOptions` is `{ PathInfos: [{ Path }], EnableRealtimeMonitor: false, EnablePhotos: false, EnableChapterImageExtraction: false, ExtractChapterImagesDuringLibraryScan: false, EnableTrickplayImageExtraction: false, EnableLUFSScan: false, MetadataSavers: [], LocalMetadataReaderOrder: ['Nfo'], TypeOptions: [...] }`, with one `{ Type, MetadataFetchers: [], ImageFetchers: [] }` per type: `Movie` for a movies library; `Series`, `Season` and `Episode` for a tvshows library.
7. `POST /Library/Refresh` starts a scan. `GET /Items/Counts` answers `{ MovieCount, SeriesCount, EpisodeCount, ... }`.
8. `GET /ScheduledTasks` answers a list of tasks with `Id` and `Name`, and `POST /ScheduledTasks/<Id>/Triggers` with `[]` removes a task's schedule (204). The `Triggers` field in the list may be null; do not read it.
9. `POST /Users/<Id>/Policy` with the whole policy object from step 5 and `IsHidden: true` answers 204. `GET /Users/Public` then answers `[]`, so the login page shows the plain username and password form.

## Interface

`tools/jellyfin-seed/bootstrap.mjs`, ESM. No imports beyond built-ins; `fetch` and `sleep` are injected, so no real network in tests.

- `client({ baseUrl, fetch, token })` returns `{ get(path), post(path, body) }`, each resolving to `{ status, json }`. `json` is null when the body is empty or not JSON. `post` with no body sends an empty body.
- `libraryOptions(kind, path)` with kind `movies` or `tvshows` returns the object in step 6.
- `waitReady({ baseUrl, fetch, sleep, timeoutMs = 180000, everyMs = 1000 })` polls step 1. A failed fetch counts as not ready. Throws in plain words on timeout.
- `finishWizard(api, { user, password })` runs steps 2 to 4. Any unexpected status throws an error naming the step and the status.
- `login(api, { user, password })` returns `{ token, userId, policy }`.
- `addLibraries(api, libraries)` takes `[{ name, kind, path }]` and runs step 6 for each.
- `scanUntil(api, expected, { sleep, timeoutMs = 300000, everyMs = 2000, steadyPolls = 3 })` runs `POST /Library/Refresh` once, then polls counts until `MovieCount`, `SeriesCount` and `EpisodeCount` all equal `expected` for `steadyPolls` polls in a row. Returns the counts. On timeout, throws with the last counts and the expected ones. A count larger than expected also keeps polling and finally throws.
- `silenceTasks(api)` removes every schedule (step 8) and returns how many tasks it changed.
- `hideUser(api, { userId, policy })` runs step 9 and throws if `/Users/Public` still lists anyone.
- `bootstrap({ baseUrl, fetch, sleep, user, password, libraries, expected, log = () => {} })` runs all of it in that order: `waitReady`, `finishWizard`, a new client after `login` with the token, `addLibraries`, `scanUntil`, `silenceTasks`, `hideUser`. It logs one line per stage and returns `{ counts, tasks }`. If `/System/Info/Public` says the wizard is already complete before the wizard starts, throw a clear error, since this must start from a fresh server.

The command line part, run only when the file is run directly: `node bootstrap.mjs <baseUrl> <configJsonFile>`, where the file holds `{ user, password, libraries, expected }`. It uses the global `fetch`, prints the log lines and the result as JSON, and exits 1 with the message on any failure.

## Tests

`node:test` with a fake `fetch` modelling the server as a small state machine: 503 twice then ready; `GET /Startup/User` required before POST; auth needed after login, checking the `Token="..."` header; counts that grow over polls. Cover: the full happy path and the exact order of calls; both casings of `startupWizardCompleted`; an already-finished server throws; each wrong status names its step; `scanUntil` waits for steady counts and fails when a count overshoots, showing expected and last; a timeout with an injected fake clock through `sleep`, with no real waiting; `libraryOptions` for both kinds; `silenceTasks` calls every task even when `Triggers` is null; `hideUser` fails if a user is still public; a fetch rejection during `waitReady` counts as not ready.
