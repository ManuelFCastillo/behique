# Sample: the canvas senses in a real `behique check` (Music Blocks)

Produced 2026-11-03 by a real run on this machine, not edited except for this header:

```
node bin/behique.mjs check musicblocks v3.8.0 master --ai-canvas --ai-budget 0.5 --no-dashboard
```

Case `20261103T203501Z_v3.8.0-vs-master`. One Meta Muse Spark 1.3 call (estimated $0.0142 at the project's unverified price); Music Blocks is a public repository (sugarlabs/musicblocks, confirmed through GitHub without a login before the screenshot was sent). Exit code 0.

Read this before quoting it:

- The model's list of controls varies call to call. The first run of the same command (case `20261103T200413Z_v3.8.0-vs-master`) got a reply with no clickable control; a rerun of the canvas stage alone on that case listed 51 controls, 8 steady, 0 different.
- The recommendation in this sample is SHIP with 99.9% of the recorded facts masked as noise. The first run of the same command was HOLD (two class changes, three canvas boxes that failed on both versions). Music Blocks animates continuously, so the noise learning is aggressive on it; the "Not seen by this check" line is the warning. The canvas section is the point of this sample, not the verdict.
- The canvas result is "no control reacted differently". That is a result, not proof that none does.

---

<!-- behique-check -->
## Behique recommends SHIP: musicblocks v3.8.0 (good) vs master (candidate)

No behaviour changes found in the recorded steps.

### AI guesses (a model wrote these; none of it changes the verdict or the exit code)
Total cost about $0.0142 (estimate at an unverified price; budget $0.5000). Each item says which model wrote it and what code was able to check about it. "Unverified" means only a person can judge it.

**AI-listed canvas controls, clicked by code** (AI guess; muse-spark-1.3; 1 call, about $0.0142 for the stage)
- From one screenshot of v3.8.0, the model listed 46 controls (36 were sliders or draggable objects, not clicked). Code clicked 10, twice on each version in fresh browsers: 9 gave a steady result on both versions, 1 were unsteady and are left out, 0 reacted differently on master. (muse-spark-1.3; $0.0142 for the stage, the only item of this stage; unverified: the list of controls is the model's; the click results are measured by code)
  - Note: no control reacted differently on master; this is not proof that none does, only that the 9 the model found did not
  - Note: Only a public app was sent to the model. The model never clicks and never judges; the verdict does not use any of this.

**Not seen by this check:** 66011 of 66089 recorded facts (99.9%) were masked as noise, mostly under body/div[1]/div[1] (42552), body/main[1]/div[5] (13509), body/div[4]/div[1] (1555). A change inside a masked fact cannot be seen by this check.

Case `20261103T203501Z_v3.8.0-vs-master` in out/evidence.

The verdict and every finding above are tests that ran; everything under "AI guesses" is the only part a model wrote, and it proves nothing. A person decides.
