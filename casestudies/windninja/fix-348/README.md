# WindNinja #348: keep the real error message in multi-run jobs

Local fix, not sent upstream. Base: WindNinja `38fc7ca` (Oct 29, 2026). Fix commit `0d90149` on a local branch; the patch is [0001-keep-the-real-error-message-in-multi-run-jobs.patch](0001-keep-the-real-error-message-in-multi-run-jobs.patch).

## The defect

In any job with more than one run (several forecast hours, a station time series), an error in a run reaches the user as "Exception caught: std::exception" instead of its cause. A single run is not affected: it takes a separate path in `ninjaArmy::startRuns()`.

Two faults combine:

1. `src/ninja/ninjaArmy.cpp`, in the OpenMP loop of `startRuns()`: `asMessages[...] + e.what();` builds a string and throws it away, so only the prefix is saved. The same slip appears in three handlers (cancel, bad forecast file, general error).
2. `src/ninja/ninja_threaded_exception.cpp`, `NinjaRethrowThreadedException()`: the general case is rethrown as a bare `std::exception()`, which carries no message.

## The change

5 lines in 2 files:

- `+` becomes `+=` in the cancel and bad-forecast handlers.
- The general handler saves the error's own text (the caller already prints "Exception caught: " before it).
- The general case is rethrown as `std::runtime_error` carrying that text. The unknown case, which has no text, is unchanged.

## The proof

Behique native mode, `38fc7ca` (reference) against the fix, both built from source, 7 cases, each run twice per version to learn noise, each difference rechecked on 3 fresh runs per version:

| Test | Case | What changed | Before the fix | After the fix | Proof |
| --- | --- | --- | --- | --- | --- |
| N1 | issue348-multirun-nodata | final message | `Exception caught: std::exception` | `Exception caught: The grid does not contain any values. Cannot fill with AsciiGrid<T>::fillNoDataValues().` | 3 of 3 runs each |
| N2 | issue348-multirun-nodata | generic line printed | 1× | not printed | 3 of 3 runs each |
| N3 | issue348-multirun-nodata | real-cause line printed | not printed | 1× | 3 of 3 runs each |

Nothing else changed: 65 facts were compared and none had to be masked as noise. The unchanged cases are the three baseline runs (domain average, point station, local weather model), #250, a successful 2-step job (the loop the fix touches, all four output grids equal) and a single run on the same no-data DEM (its message is the same before and after).

WindNinja's own unit tests (`ctest`, built with `-DBUILD_TESTING=ON`) give identical results test by test before and after the fix: 38 of 59 pass on each. The same 21 fail on each, all of them NOAA NOMADS download tests that this environment's network refuses ("CONNECT tunnel failed, response 403"). Logs: [unit-tests/](unit-tests/).

Full report: [behique-result.md](behique-result.md). Evidence record: [behique-evidence/](behique-evidence/) (hash-chained; `openCase(dir).verify()` checks it).

Reproduce:

```bash
node bin/behique.mjs check windninja 38fc7ca <fix branch> --profile casestudies/windninja/windninja.profile.json --repo <windninja checkout>
```

Behique reports HOLD (exit code 1) because a change a person would notice was proven. Here that change is the intended one; the person decides.
