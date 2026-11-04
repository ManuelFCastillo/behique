# Demo storyboards: one per feature, to pick what joins the cut

Written 2026-11-03, updated the same day for wave 5 (scenes I and J, and the AI line in B, C and E). The three finished cuts (Hoppscotch, Slidev, and Docusaurus once its rerun lands) all follow storyboard A. Every other storyboard is a scene that could be added. "Exists" means the feature works in the dashboard today and can be recorded with `demo/tour.mjs` style scripting; "cost" is what recording it would take, not model spend unless said.

## How long the demo should be

The official video limit is still unverified (nothing on the public pages; the confirmation email is the place to check). Two facts decide the length anyway:

- Judges with many entries decide in the first minute. The existing 60-second cut is built for that and should stay the opening minute of any longer version, unchanged.
- Everything the judges will ask about that the cut does not show ("does it work on my repo?", "where is the AI?", "who decides?") fits in about 70 seconds more.

Recommendation: **one 2:10 to 2:30 cut** = 10-second cold open + the 60-second core + three or four of the scenes below + 8-second close. Keep the 60-second cut as the fallback if the limit turns out to be one minute, and as the social-media version. Do not go past 3:00: nothing below earns a third minute.

## A. The core check (the existing 60-second cut)

The v3 cut (2026-11-04), five videos, timings from `demo/tour.mjs`. Files: `~/Downloads/behique-demo-v3-{hoppscotch,docusaurus,slidev,vitepress,freshrss}.mp4`. Each is a new run recorded through the dashboard on hardac2, with `behique ai` run on the case before the take. FreshRSS builds on this machine, so its caption drops "in Docker".

| s | Shot | Caption |
|---|---|---|
| 0 to 2.7 | Title card | "Release verification with evidence" |
| 2.7 to 8.6 | The good version's test recording, full frame, tested element outlined | "This is {issue}, a bug people reported in {app}. Behique found it from two versions. No one wrote a test." |
| 8.6 to 16 | The candidate's recording; the verdict burned into the footage | "On {good} ... On {cand} ..." then "Both runs recorded ..." |
| 16.5 to 21.3 | New run dialog: app, good ref, candidate ref typed | "Two versions of an app it has never seen. That is the whole input." |
| 21.6 to 31 | Time-lapse of the real run, with a ticker read from the case's own events | "Two clean builds in Docker. The click paths came from a crawl, not from a person. Every failure rerun 3 times, then bisected." |
| 31 to 33.2 | Verdict word and reason | "{n} minutes later: HOLD, with the reason." |
| 33.2 to 36.6 | Bisect card, culprit commit punched | "{n} commits between the versions. {k} builds to the one that broke it: the commit the maintainers fixed." |
| 36.6 to 39.2 | Pixel diff | "Pixels compared. Moved content blue, new content red." |
| 39.2 to 42 | Before/after slider dragged | "Drag the handle: good on the left, candidate on the right." |
| 42 to 43.5 | AI stages tab, AI-written tests | "Meta's Muse Spark reads each proven difference and writes the test. A guess, until code runs it." |
| 43.5 to 46.7 | The test it wrote, full frame, coloured | "The test it wrote, the file Behique ran. Written for a person to read." |
| 46.7 to 48.2 | The "passes 3/3, fails 3/3" chip lights | "Kept only if it passes on the good version and fails on the candidate, every run, on fresh builds." |
| 48.2 to 50.8 | AI-proposed click paths | "It proposes click paths and reads the pictures. Code replays each path and checks each claim against the pixels. None of it can change the verdict." |
| 50.8 to 55.3 | Evidence chain tab, Verify chain runs | "Verify chain recomputes every hash. Nothing here can be edited quietly." |
| 55.3 to 61.5 | Numbers card (0 model calls in the verdict), close | "Proven, bisected, recorded." |

Recipe per app: `node demo/tour-run.mjs <app> <good> <cand> out/demo/<name>-run-raw.webm`, `sh demo/timelapse.sh <raw> 8 out/demo/<name>-run-timelapse.webm`, `node bin/behique.mjs ai <case> --explain --ai --ai-budget 1`, then `BEHIQUE_HERO=R1 BEHIQUE_ISSUE=<owner/repo#n> BEHIQUE_FIXED=1 BEHIQUE_MUSIC=<track> BEHIQUE_RUN_TIMELAPSE=<timelapse> node demo/tour.mjs <case> out/demo/<name>.mp4`. The factor in the corner is read from `<name>-run-raw.json` beside the time-lapse, so keep the two names together. Set `BEHIQUE_FIXED=1` only when the culprit equals the answer key in `docs/blind-bisect-runs.md` or `docs/regression-demo-plan.md`. Take a video only when no run is active: a live run makes the dashboard load the running case.

Covers features 1 to 7 of the feature list and the AI stages. Not shown: onboarding, the decision, CI, the sandbox.

## B. Set up an app from a GitHub repo (feature 8) - RECOMMENDED

The answer to "does it work on my repo?". Exists end to end in the dashboard (`Set up an app`, the GitHub repo list from the `gh` login, the proposal preview, command approval, verification build).

| s | Shot | Caption |
|---|---|---|
| 0 to 4 | Left sidebar: "Your GitHub repos (n)", pick one, click "Set up this app" | "Any repo. Pick one you have never set up." |
| 4 to 9 | Set up dialog: the exact text that will be sent to the model, the model's name (muse-spark-1.3) and its projected cost (about $0.008), shown before sending; hold on the price for two seconds | "The model sees exactly this, and you see the price first. A model proposes." |
| 9 to 14 | The proposal comes back: install, start, ready path, as a form | "It proposes how to install, start and check the app." |
| 14 to 18 | Approve the commands; Behique builds and probes the ready path (time-lapse) | "Code verifies the proposal by building the app and loading it. A person approves each command." |
| 18 to 22 | The app appears in the list; New run opens with it chosen | "Saved. Now the check above runs on it." |

Length about 22 s. Cost: a repo not yet set up (a small static site builds fastest), one model call (cents), 5 to 15 minutes of real time to record, then time-lapse the build. Risk: the proposal needs a second round on some repos; record the whole thing and cut. Needs `gh` logged in on the recording machine.

## C. Ask the model why (feature 9) - RECOMMENDED

The answer to "where is the AI?", and the honest version of it: the model gets the bisected diff and the observed difference, nothing else, and its answer is labelled a lead, never a verified claim.

| s | Shot | Caption |
|---|---|---|
| 0 to 3 | Bisect card with the culprit commit | "The commit is found by building, not by guessing." |
| 3 to 7 | Card "Ask the model why (about $0.007)": the exact text to be sent, the model name and the projected cost, visible; or from a terminal `behique check ... --bisect --explain` (the same call, the same guard) | "The only paid step. The diff goes in as untrusted data. The price is shown first." |
| 7 to 12 | Send; the answer appears under "only a lead", apart from the verified claims, with the quote check ("found in the diff") and the cost on the card | "A hypothesis, filed as a hypothesis. The proof above does not depend on it." |

Length about 12 s. Cost: one send (under a cent) on the Docusaurus or Slidev case; the card already exists; 2 minutes to record. No risk.

## D. Ship or Hold: the person decides (feature 7 and the decision log) - RECOMMENDED

Short, and it says what Behique is for: a recommendation, and a decision kept apart from it.

| s | Shot | Caption |
|---|---|---|
| 0 to 3 | Hero: Behique recommends HOLD | "Behique recommends." |
| 3 to 7 | Click SHIP; the modal "A reproduced failure exists. Ship anyway?" | "A person decides, and is told what they are overriding." |
| 7 to 10 | Confirm; the decision lands in the evidence chain as its own record with who and when | "The decision is a record too." |

Length about 10 s. Cost: none; record on a finished case (use a copy of the case if you do not want a SHIP decision on the real Docusaurus record). 2 minutes.

## E. The command and the GitHub Action (feature 10)

The answer to "how does this fit a team?". The command exists and streams the real log; the `comment` subcommand posts the verdict on a PR and updates it on later runs. The Action has never run on GitHub's own runners, so show the comment, not the Action.

| s | Shot | Caption |
|---|---|---|
| 0 to 5 | Terminal: `behique check docusaurus cacb973 v3.8.0 --bisect`, the log streaming (time-lapse) | "The same check from a terminal, or from CI." |
| 5 to 8 | Exit code 1 and the Markdown result | "Exit 1 is HOLD. CI stops here." |
| 8 to 14 | A pull request on your repo with the Behique comment: verdict, the finding in plain words, the culprit (for the AI section see scene I) | "On a pull request it posts the verdict as a comment, and updates it on the next push." |

Length about 14 s. Cost: a PR on one of your repos to comment on (or `--dry-run` output, less convincing), 10 minutes. Risk: the Action itself is unproven on GitHub runners; the caption above says CI without claiming the Action ran there.

## F. The evidence can be checked, and tampering is caught (feature 7, deeper)

A stronger version of the last scene of the cut. Verify chain exists; the tamper is a one-byte edit of a record file in a copy of the case.

| s | Shot | Caption |
|---|---|---|
| 0 to 4 | Terminal: change one character in a record of a copied case | "Edit one byte of one record." |
| 4 to 9 | Dashboard, Verify chain on the copy: the broken link named | "Verify chain finds the record and the hash that no longer matches." |

Length about 9 s. Cost: 5 minutes. Only if the cut has room; it repeats a point the 60 seconds already make.

## G. Sandbox: untrusted repos in Docker, locally or on another machine (feature 11)

| s | Shot | Caption |
|---|---|---|
| 0 to 4 | Settings: sandbox mode local / ssh host, memory, CPUs, pool, cache | "Every build runs in a container, on this machine or another." |
| 4 to 9 | `docker ps` during a run: the install, app and sidecar containers on their own network | "The app under test cannot reach the network, or the machine." |

Length about 9 s. Cost: none, record during any run. Lower value: judges assume it; a caption in scene A ("Two clean builds in Docker") already says it.

## H. What the check could not see (feature 6)

| s | Shot | Caption |
|---|---|---|
| 0 to 6 | Report: the masked-facts line and the class of each finding (would be noticed / markup churn) | "It says what it masked as noise and why a finding ranks where it does." |

Length about 6 s. Cost: none. Fits as one extra beat inside scene A's "Measured" shot rather than its own scene.

## I. The AI section of the pull request comment (feature 10, wave 5) - RECOMMENDED

The answer to "where is the AI, and can I trust it?". It is the verdict table from scene E with one extra section, titled "AI guesses (a model wrote these; none of it changes the verdict or the exit code)". Use `docs/pr-comment-sample-ai.md` (a real result, see its header for how it was produced) or a live `--ai` comment.

| s | Shot | Caption |
|---|---|---|
| 0 to 4 | Terminal: `behique check <app> <good> <cand> --bisect --explain --ai --ai-budget 2`; the log shows the stages starting and the line `ai: total about $0.0xxx of a $2.00 budget; the verdict is unaffected` | "One flag turns the AI stages on. One budget caps them." |
| 4 to 9 | The comment: the verdict table and the culprit, then the AI section header | "Above this line, every claim is a test that ran. Below it, a model wrote every word." |
| 9 to 15 | Highlight the model name and cost on the explanation, "quote found in the diff", and on the AI-written tests "passes 3/3 on the good version and fails 3/3 on the candidate, each run on a fresh build" | "Each guess says which model, what it cost, and what code checked." |
| 15 to 19 | Highlight a line that says "unverified" or "not verified: ..." and the closing sentence | "What code could not check is labelled that way. A person decides." |

Length about 19 s. Cost: one real run (a few cents; 4 to 25 minutes with a warm cache on hardac2), or none with the saved sample. Risk: the bisect step must find a culprit for the explanation to appear; record a case that already did. The Action has not run on a GitHub runner, so show the comment text, not a runner log.

## J. Canvas senses in the check (checklist item 12, wave 5)

The answer to "what about apps with no DOM?". `behique check musicblocks v3.8.0 master --ai-canvas` on an app drawn on a canvas.

| s | Shot | Caption |
|---|---|---|
| 0 to 4 | Log: `canvas senses: sending ONE screenshot (2560x1600, the viewport only) of musicblocks v3.8.0 to Meta muse-spark-1.3 ... projected about $0.016` | "One screenshot of a public app. The price is shown first." |
| 4 to 9 | The screenshot the model saw (saved as case evidence) with the model's list of controls; then the browser clicking them on both versions (time-lapse) | "The model points. Code clicks, on both versions, twice, in fresh browsers." |
| 9 to 14 | The AI section: how many controls steady, how many unsteady and left out, and what reacted differently | "The pixels decide what each click did. A difference is a lead, not a bug." |

Length about 14 s. Cost: one call about $0.015 to $0.02, 8 to 25 minutes real time (the check runs in full first), time-lapse it. Honest limits to say or caption: one app, two versions; the model's list changes from call to call (one run listed no clickable control, the next 51 controls); a run can find no difference at all, and that is a result. Music Blocks only: the welcome-tour close button is set up for it by hand (`PREP` in `canvas-senses.mjs`).


## Not for the demo

- **Login and seed data.** Real, but the only app it was proven on is FreshRSS, which is not demoed. Skip.
- **Canvas senses as a separate page.** Superseded: they are now in the main check as `--ai-canvas` (scene J). Do not show the `/senses` and `/watch` pages as if they were the product.
- **The explorer.** Retired from the pitch. Skip.

## A suggested 2:15 running order

| s | Scene |
|---|---|
| 0 to 10 | Cold open: the dashboard, one line of what Behique is (new, 10 s) |
| 10 to 70 | A, the existing 60-second cut, unchanged |
| 70 to 92 | B, set up an app from a GitHub repo |
| 92 to 104 | C, ask the model why |
| 104 to 114 | D, Ship or Hold |
| 114 to 128 | E, the command and the PR comment |
| 128 to 136 | Close: repo link, one line |

With the wave 5 scenes the running order is 0:00 to 0:10 cold open; A (60 s); B (22 s, the proposal text and the price on screen); C (12 s); D (10 s); E (14 s); I (19 s); J (14 s, time-lapsed); close (8 s), about 2:50. That is past the 2:30 recommended above: if the limit allows 3:00, keep everything and trim A's second half; if not, drop D and J first, then E (scene I already shows the comment).

If only one scene can be added, add B. If two, B and C. D and E are cheap and can be recorded tonight; B needs the most real time and should be recorded first.
