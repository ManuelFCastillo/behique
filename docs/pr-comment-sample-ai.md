# Sample: the AI section of a Behique pull request comment (VitePress rc.10 vs rc.12)

Produced 2026-11-03 on this machine from a real case, `20261103T061143Z_v1.0.0-rc.10-vs-v1.0.0-rc.12` (VitePress, sandbox on hardac2). This is exactly the Markdown `behique comment` would post, the text below the rule is unedited. How it was made, honestly:

1. The check itself (crawl, record, tests, bisect to 070fc0a in 4 steps, verified 3/3 and 3/3) ran earlier the same day (recorded options: bisect on, 3 runs).
2. Then, on that saved case, two commands. First `node bin/behique.mjs ai 20261103T061143Z_v1.0.0-rc.10-vs-v1.0.0-rc.12 --explain --ai --ai-budget 2 --full`: `--explain` made the one Muse Spark call about the culprit commit (about $0.0073, quote found in the diff; the case already held an older guess from the morning's run, so its newest guess is the one shown). I stopped that command when its tests stage began building VitePress on this machine without the sandbox; the command now refuses that (a profile that runs the repository's own code needs `BEHIQUE_SANDBOX`, the same rule as the dashboard). Second, the same command without `--explain` and with `BEHIQUE_SANDBOX=docker:ssh://hardac2`, which ran the four stages. It prints that the verdict (HOLD, exit code 1) is unchanged by them.
3. Why not one single `check --bisect --explain --ai` command: three such runs the same day did not give a culprit to explain. VitePress run 1 came back HOLD but its bisect skipped every step ("expect(locator).toBeAttached() failed") and ended inconclusive after 24 steps; VitePress run 2 came back SHIP with 21% of the facts masked as noise and no findings; Hoppscotch's bisect skipped steps again and was cancelled by me. I did not find out why (the recorder, findings and bisect files had uncommitted changes from other work in the tree). With no culprit there is nothing to explain. The `check` path with `--ai` ran for real in those runs (VitePress run 1: AI-written tests 5 items about $0.028, click paths 6 items about $0.020), and on Music Blocks (`docs/pr-comment-sample-canvas.md`); the saved-case command runs the same stages through the same code (`src/release/cli/ai-stages.mjs`).
4. Cost: the stages and the explanation together about $0.073 (the case's `model.call` events: one ask, five test calls, one flows call, two picture calls) (estimates at the project's unverified price; budget was $2.00). Wording of one detail line on picture descriptions ("unchecked") was clarified in the code after this run.

Things to notice: the AI section is separate from the table above it; every item names the model; the explanation says whether its quoted line is in the diff; AI-written tests are marked verified only because code ran them on fresh builds (3/3 pass on good, 3/3 fail on candidate); proposed click paths were only replayed on the good version; picture descriptions are marked verified only for "the place really changed in the pixels", not for being right; the picture descriptions include two ad-card changes (third-party content), a reminder that a described difference is not necessarily a regression.

---

## Behique recommends HOLD: vitepress-docs v1.0.0-rc.10 (good) vs v1.0.0-rc.12 (candidate)

5 reproduced behaviour changes (5 a person would notice, 0 markup churn), 25 commits bisected in 4 steps.

| # | Would a person notice? | What | Where | Good | Candidate | Verdict |
|---|---|---|---|---|---|---|
| R1 | a person would notice (a state a person sees (inert)) | inert | `div[1]/aside[1]` | `absent` | `` | confirmed |
| R2 | a person would notice (an image or embedded content changed) | src | `p[5]/img[1]` | `/assets/vitepress-init.dfe5638e.png` | `missing` | confirmed |
| R3 | a person would notice (name changed) | name | `div[1]/input[1]` | `group-vSt09` | `missing` | confirmed |
| R4 | a person would notice (for points somewhere else) | for | `div[1]/label[1]` | `tab-nINRZVE` | `missing` | confirmed |
| R5 | a person would notice (name changed) | name | `div[1]/input[2]` | `group-vSt09` | `missing` | confirmed |

"Confirmed" means the test passed every run on the good version and failed every run on the candidate, each run on a fresh build.

**First change that makes the test fail:** [070fc0a](https://github.com/vuejs/vitepress/commit/070fc0a56ddb941e26a098ba7207b5d1e91b7b51) feat(theme): use inert to avoid traverse menus and content with keyboard (#2932) (Joaquín Sánchez, 2023-09-10), 25 commits bisected in 4 steps, verified 3/3 and 3/3.

### AI guesses (a model wrote these; none of it changes the verdict or the exit code)
Total cost about $0.0733 (estimate at an unverified price; budget $2.0000). Each item says which model wrote it and what code was able to check about it. "Unverified" means only a person can judge it.

**AI guess, not proof** (muse-spark-1.3, medium confidence; asked about the change above only): The change adds inert bindings to layout sections, so VPContent and its aside become inert when sidebar or nav screen is open, and the code-group tab radios and labels inside that inert subtree are dumped without name and for attributes.

It rests on this line of the change, which is in the diff: `    <VPContent :inert="isSidebarOpen || isScreenOpen">`

To check it: Replay the test with isSidebarOpen and isScreenOpen both false and check if inert disappears and name/for return.

One model call, about $0.0073 (estimated).

**AI-written tests** (AI guess; muse-spark-1.3; 5 calls, about $0.0323 for the stage)
- Sidebar aside is marked inert so it cannot be used: On the new version the sidebar aside has an inert attribute, while on the old version it had no inert attribute and stayed interactive. (muse-spark-1.3; $0.0323 for the stage, shared by its 5 items; verified: passes 3/3 on the good version and fails 3/3 on the candidate, each run on a fresh build)
- Get Started guide image no longer shows its picture: On the new version the guide image has no picture source where the old version showed the vitepress-init illustration. (muse-spark-1.3; $0.0323 for the stage, shared by its 5 items; verified: passes 3/3 on the good version and fails 3/3 on the candidate, each run on a fresh build)
- Get Started tab input missing its group name: On the new version the first tab input under Get Started no longer has its expected name, so tab grouping breaks. (muse-spark-1.3; $0.0323 for the stage, shared by its 5 items; verified: passes 3/3 on the good version and fails 3/3 on the candidate, each run on a fresh build)
- First tab label on Get Started page is no longer linked to its tab: The first tab label has no connection to its tab control, so clicking the label does not select that tab. (muse-spark-1.3; $0.0323 for the stage, shared by its 5 items; verified: passes 3/3 on the good version and fails 3/3 on the candidate, each run on a fresh build)
- Tab option inputs lost their shared name grouping: On the new version the tab input no longer has name "group-vSt09" so the options are no longer grouped together. (muse-spark-1.3; $0.0323 for the stage, shared by its 5 items; verified: passes 3/3 on the good version and fails 3/3 on the candidate, each run on a fresh build)

**AI-proposed click paths** (AI guess; muse-spark-1.3; 1 call, about $0.0176 for the stage)
- Open search from homepage and verify search dialog appears (3 steps) (muse-spark-1.3; $0.0176 for the stage, shared by its 3 items; replayed: replayed 3 of 3 times on the good version with the same trace each time; it has not been run on the candidate)
- Navigate Guide then open Getting Started from sidebar (3 steps) (muse-spark-1.3; $0.0176 for the stage, shared by its 3 items; replayed: replayed 3 of 3 times on the good version with the same trace each time; it has not been run on the candidate)
- Navigate Get Started then open What is VitePress from sidebar (3 steps) (muse-spark-1.3; $0.0176 for the stage, shared by its 3 items; replayed: replayed 3 of 3 times on the good version with the same trace each time; it has not been run on the candidate)

**AI description of the pictures** (AI guess; muse-spark-1.3; 2 calls, about $0.0161 for the stage)
- The version label in the top navigation changed from 1.0.0-rc.10 to 1.0.0-rc.12. (muse-spark-1.3; $0.0161 for the stage, shared by its 5 items; verified: the described place changed above the noise floor in the pixels; check of "text": unchecked)
- The advertisement card on the lower right changed image and text from the Melia speech-to-text ad to the BigQuery data warehouse ad. (muse-spark-1.3; $0.0161 for the stage, shared by its 5 items; verified: the described place changed above the noise floor in the pixels; check of "other": unchecked)
- The version label in the top navigation changed from "1.0.0-rc.10" to "1.0.0-rc.12". (muse-spark-1.3; $0.0161 for the stage, shared by its 5 items; verified: the described place changed above the noise floor in the pixels; check of "text": unchecked)
- A new "bun" package-manager tab was added after the "yarn" tab in the install code block. (muse-spark-1.3; $0.0161 for the stage, shared by its 5 items; verified: the described place changed above the noise floor in the pixels; check of "added": agrees)
- The advertisement text under the cloud icon changed from "Focus on your application, and leave the database to us. Start free." to "Easily create and run online VMs on high-performance, reliable cloud infrastructure." (muse-spark-1.3; $0.0161 for the stage, shared by its 5 items; verified: the described place changed above the noise floor in the pixels; check of "text": unchecked)
  - Note: AI guess, not proof: the descriptions are a model's reading of the pictures. Code only checked that each described place really changed (and, for moved/added/removed/recolored, that the pixels agree). This does not change the verdict.

- AI ranking of unproven differences: nothing to do, no model call was made (this case has no unreproduced or unstable differences to rank; no differences to rank).

**Not seen by this check:** 22 of 10922 recorded facts (0.2%) were masked as noise, mostly under body/div[1]/div[1] (22). A change inside a masked fact cannot be seen by this check.

Case `20261103T061143Z_v1.0.0-rc.10-vs-v1.0.0-rc.12` in out/evidence.

The verdict and every finding above are tests that ran; everything under "AI guesses" is the only part a model wrote, and it proves nothing. A person decides.
