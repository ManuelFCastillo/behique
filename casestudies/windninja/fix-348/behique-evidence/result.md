## Behique: HOLD for windninja 38fc7ca → slvrleaf/fix-348

Good `38fc7ca2650f`, candidate `0d901491c85f`. Native mode: each case run in a fresh folder; a difference counts as proven only if its test passed every run on the good version and failed every run on the candidate.

| Test | Case | What | Good | Candidate | Proof |
| --- | --- | --- | --- | --- | --- |
| N1 | issue348-multirun-nodata | final message | `Exception caught: std::exception` | `Exception caught: The grid does not contain any values. Cannot fill with AsciiGrid<T>::fillNoDataValues().` | confirmed: good passed 3/3, candidate failed 3/3 |
| N2 | issue348-multirun-nodata | printed `Exception caught: std::exception` | printed 1× | not printed | confirmed: good passed 3/3, candidate failed 3/3 |
| N3 | issue348-multirun-nodata | printed `Exception caught: The grid does not contain any values. Cannot fill with AsciiGrid<T>::fillNoDataValues().` | not printed | printed 1× | confirmed: good passed 3/3, candidate failed 3/3 |

Not compared: 0 of 65 recorded facts changed between identical runs of the same version. A change hidden inside one of them is invisible to this check.

Evidence: `/home/user/behique/out/native/windninja/20261108T174023Z_38fc7ca-vs-slvrleaf_fix-348` (hash-chained record). A person decides.
