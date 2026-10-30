# Muse builder

Lets Muse Spark build a part of Behique from a written spec, with code, not trust, deciding whether it worked.

```
node tools/muse-build/build.mjs docs/specs/musicblocks/01-profile-and-runner.md --dry-run   # prompt size and cost, nothing sent
node tools/muse-build/build.mjs docs/specs/musicblocks/01-profile-and-runner.md             # build, test, repair (up to 3 rounds)
node tools/muse-build/build.mjs <spec> --run-only                                           # after reading the files: run the tests again
```

## How it works

1. The spec (`docs/specs/...md`) has a header: `owns` (the only files that may be written), `context` (existing files shown to the model), `test` (the acceptance command), `allow` (risky patterns the part is expected to use).
2. The model gets the spec and the context files. It answers with file blocks. Only `owns` files are written; anything else is rejected and logged. A tracked file with uncommitted changes is never overwritten without `--force`.
3. The written files are scanned for patterns the spec did not allow (environment files, deletes, child processes, external network, dynamic code). A flag stops the build before any test runs: read the files, then `--run-only`.
4. The acceptance command runs with a minimal environment (no API keys). On failure its output goes back to the model for another round, up to `--rounds`, and never past `--max-cost`.
5. A report is written to `out/muse-build/<part>-<time>.json` (rounds, tokens, files written and rejected, flags, test tails, estimated cost).

## Rules

- Standard Muse Spark through the Meta API (provider `meta`), never a contributor variant.
- `.env` is never read, shown or written. Paths are limited to `src/`, `docs/`, `bench/`, `tools/`.
- The scan is a tripwire, not a sandbox. A person reads what Muse wrote before it is trusted or committed.
- Costs use the estimated price in `src/llm.mjs` (unverified).

Tests: `node --test tools/muse-build/spec.test.mjs tools/muse-build/build.test.mjs` (offline, a fake model).
