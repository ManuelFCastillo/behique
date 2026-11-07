# Native mode: checking programs that are not web apps

Written 2026-11-07. Native mode runs Behique's method on a program that is built from source and run from a command line, such as a C++ model. It uses the same evidence store, the same proof rule, the same commit search and the same SHIP / HOLD / REVIEW words as web checks. No model is called anywhere in it.

```bash
node bin/behique.mjs check windninja <good> <cand> --profile casestudies/windninja/windninja.profile.json --repo <windninja checkout> [--bisect]
```

## What it does

1. **Build** each ref from git in its own worktree, by commit sha, with the profile's build steps. A commit already built with the same steps is reused.
2. **Record** every case twice per version, each run in an empty folder. A fact that differs between two identical runs is masked as noise and counted in the report. A fact that is steady on one version but varies on the other is reported as a difference to review, never hidden.
3. **Compare** facts: exit code, final message, each error or warning line, output file checksums, grid shape and statistics, and values at named map points (probes). Differences are ranked: messages and values first, output bytes last. A file whose bytes changed while every value stayed equal is churn.
4. **Prove** each difference with a test that reruns its case and checks its one fact. It is confirmed only if it passed 3 of 3 runs on the good version and failed 3 of 3 on the candidate.
5. **Search** (`--bisect`) for the first commit behind the first confirmed difference, using the web checks' binary search. A commit that does not build, or gives a third value, is skipped, not guessed. The answer is checked 3 of 3 on the commit and its parent, or reported as a range.

Exit codes: 0 SHIP, 1 HOLD, 2 REVIEW, 3 incomplete (a build failed, or a case could not start on the good version).

## The profile

A command profile is data with `"kind": "command"`. Example: [casestudies/windninja/windninja.profile.json](../casestudies/windninja/windninja.profile.json).

- `build.dir`, `build.steps`: steps are argument lists (never shell strings) and must start with a build tool (`cmake`, `make`, `ninja`, `meson`, `msbuild`, `devenv`, `ctest`).
- `env`: environment variables for builds and runs.
- `cases[]`: `id`, `command` (must start with `{build}/` or `{src}/`, or be `node` / `python3`), `files` (input files written into the run folder), `outputs` (patterns of files to record), `probes` (named map points read from an output grid), `timeoutMs`.
- `noise.lines`: patterns of printed lines to ignore (timings). `noise.names`: rules that normalize output file names (a date in a name).
- Placeholders: `{src}` the checkout, `{build}` the build folder, `{run}` the fresh run folder.

## Measured so far

| Check | Result |
| --- | --- |
| Native test suite (`node --test src/release/native/*.test.mjs`) | 39 tests pass, on a stand-in program, no compiler needed except `cmake -E` for a few |
| WindNinja `f5920f3` → `38fc7ca` (merge of #832), both built from source, 5 cases | SHIP: 47 facts recorded, 0 masked, no differences; 13 s of runs after the builds |

The WindNinja run recorded both open bugs as facts on both versions (#348: the 2-step no-data job ends with "Exception caught: std::exception"; #250: 132° and 6.71 at the KMSO station). Neither is fixed in either version, so SHIP is the right answer: the merge did not change them.

## Limits

- Linux only so far. Windows builds (Visual Studio) are allowed by the profile format but have not been run.
- Facts come from exit codes, printed lines and output files. A desktop GUI is not driven.
- Grids are ESRI ASCII (`.asc`). Other formats are recorded by checksum only.
- `--explain` and the AI stages are not available in native mode.
- Each commit in a search is a full build unless it was built before. WindNinja takes a few minutes per build on 4 cores; a compiler cache (`-DCMAKE_CXX_COMPILER_LAUNCHER=ccache` in the profile) would shorten that.
