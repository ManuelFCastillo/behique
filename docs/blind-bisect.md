# Blind bisect on real history

Written 2026-11-01. The claim to test: pointed at two released versions of a notable project, Behique finds the commit that introduced a regression the project itself later diagnosed, without ever seeing the diagnosis or the fix.

## Why it is blind

Behique is given two tags, `vA` (the last release that was right) and `vB` (the first release with the bug). The project's fix landed after `vB`, so it is outside the range Behique searches. Nothing in the run reads issues, pull requests or commit messages after `vB`. The crawl finds the click paths on its own, the compare records what the two versions show, the test is written from the recorded difference, and the bisect walks `vA..vB` with that test. The one model call, Ask why, sees only the observed difference and the bisected commit's diff, never the issue or the fix. The grader (a person, afterwards) holds the project's own answer and compares.

## Protocol, per candidate

1. Record the answer key before the run, in `docs/blind-bisect-runs.md`: repo, issue URL, `vA`, `vB`, the fix PR, and the culprit the project named (a commit or PR inside `vA..vB`). If the project never named a culprit, the case can still show the regression but cannot be graded on the bisect; say so.
2. Set the app up from its repository in the dashboard (inspect, propose, approve, verify, repair). Record how many repair rounds it took and the cost of the proposal call. This is the model's first graded job: did it work out how to run a project it was not told about.
3. Run the check `vA` (good) against `vB` (candidate) with the search on, from the dashboard or `node bin/behique.mjs check <app> vA vB --bisect`. Note the timing line.
4. Read the report with the answer key closed. Write down, before looking at the key again: the verdict, the first finding (what changed, where), the bisected commit, and whether the parent was verified.
5. Ask why, once. Record the hypothesis, its confidence, whether its quote was grounded, and the cost.
6. Grade (see below). Record the whole thing, including misses, in `docs/blind-bisect-runs.md`, with the case id so the evidence chain can be opened.

## Grading

Three separate marks, because they are three separate claims:

- **Found it**: the report is HOLD or REVIEW and at least one finding describes the symptom in the issue (the same page, the same element or picture region). Partial if the symptom is reported only as "canvas changed" or a pixel region with no DOM fact.
- **Named the commit**: the bisected commit is the culprit the project named, or a commit inside the culprit's PR (squash merges make these the same thing; a merge commit of that PR also counts). Both ends verified 3 of 3. A miss is a miss even if the commit is adjacent.
- **Explained it**: the model's hypothesis names the same mechanism as the fix PR's description. This grade is for the model, and a miss here does not touch the two above; that separation is the point.

Report every candidate run, graded or not. A table of five wins with the misses left out would be worth nothing.

## What makes a good candidate

- A notable project (thousands of stars) so the result means something to a reader.
- The symptom is visible to an anonymous visitor on first load or after clicks: text, a link target, a control's state, a missing element, a navigation, or a canvas region. No upload, no typing, no external account. A seeded login is acceptable.
- `vA` and `vB` are tags, 20 to 600 commits apart. Fewer and the bisect is trivial; more and the build time dominates.
- The fix PR names the cause. Without that there is no answer key.
- The app builds with a standard toolchain and runs without outside network, since the sandbox has none. A docs site that fetches its search index from a third party on load will show that as a difference on every run.

## Not a candidate

- FreshRSS (already used for development; the Share case is the one the pipeline was built against, so it proves nothing new).
- Any regression that needs typed input to reach, until the crawler types.
- Any pair where the fix is inside `vA..vB` (the bug came and went within one release): the bisect would find the fix, not the cause.
