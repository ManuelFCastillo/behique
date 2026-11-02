# Blind bisect runs

The protocol is in `docs/blind-bisect.md`. Candidates were found on 2026-11-01 by three read-only searches of GitHub issues (editors and diagram tools, docs sites, self-hosted apps). The answer key for each is written here BEFORE its run; the result is added after, misses included.

## Shortlist, in the order to run

| # | Project (stars) | Issue | Symptom a visitor sees | vA good | vB bad | Fix | Culprit the project named | Commits | Why this order |
|---|---|---|---|---|---|---|---|---|---|
| 1 | vuejs/vitepress (15k) | [#2949](https://github.com/vuejs/vitepress/issues/2949) | Load a doc page directly: the sidebar carries an `inert` attribute and its links do nothing | v1.0.0-rc.10 | v1.0.0-rc.12 | v1.0.0-rc.13, revert [#2953](https://github.com/vuejs/vitepress/pull/2953) | PR #2932 = commit 070fc0a5 | 25 | Cheapest build, already cloned, attribute plus dead click are exactly recorded facts, fix is a plain revert |
| 2 | hoppscotch/hoppscotch (80k) | [#5693](https://github.com/hoppscotch/hoppscotch/issues/5693) | `/settings` cannot scroll: `<main>` lost its `overflow-auto` class | 2025.10.1 | 2025.11.2 | 2025.12.0, [#5695](https://github.com/hoppscotch/hoppscotch/pull/5695) | PR #5665 = commit d67a85b | 41 | Static build, no login, class plus scroll facts, big name. Needs onboarding from zero (the model's job) |
| 3 | meta/docusaurus (66k) | [#11213](https://github.com/meta/docusaurus/issues/11213) | Click a sidebar category that has its own page: it collapses instead of navigating | v3.7.0 | v3.8.0 | v3.8.1, [#11242](https://github.com/meta/docusaurus/pull/11242) | PR #10886 = commit 5331de29 | 154 | Best "real docs site" story and a real bisect; heavy Yarn 1 monorepo build, so run it with the cache warm, overnight |
| 4 | mermaid-js/mermaid (80k) | [#7503](https://github.com/mermaid-js/mermaid/issues/7503) | `demos/block.html` on load: block text overflows its box, diagram too narrow | mermaid@11.12.3 | mermaid@11.13.0 | mermaid@11.15.0, [#7589](https://github.com/mermaid-js/mermaid/pull/7589) | PR #6119 = commit ad9edf5f | 457 | Pictures mode, first load, long range; heavy pnpm monorepo with code generation |
| 5 | slidevjs/slidev (49k) | [#2635](https://github.com/slidevjs/slidev/issues/2635) | Deck built under a base path: Next goes to `/sub/sub/2`, a 404 page | v52.15.2 | v52.16.0 | v52.17.0, [#2630](https://github.com/slidevjs/slidev/pull/2630) | PR #2562 = commit a0c3857b | 15 | A navigation 404 after one click; needs a base-path build and serve; short range |

Also found, lower priority: mermaid [#8352](https://github.com/mermaid-js/mermaid/issues/8352) (circle nodes five times too wide, 11.17.2 to 12.0.0, 402 commits, a major release so much else changed too); hoppscotch 2025.11.1 to 2025.11.2 (5 commits, the same bug, a smoke test); it-tools [#402](https://github.com/CorentinTh/it-tools/issues/402) (the culprit is the bad tag's own commit, so the bisect is trivial); directus [#26670](https://github.com/directus/directus/issues/26670) and mealie [#5747](https://github.com/mealie-recipes/mealie/issues/5747) (both need a seeded database and a login).

Rejected with a reason, so nobody searches twice: excalidraw (tags a year apart, every regression came and went inside one tag), tldraw #8689 (reverted before any tag), swagger-ui (loads petstore from the network on first load), drawio (one commit per release), uptime-kuma #6935 (850 commits, maintainers could not reproduce), nocodb, umami, homepage, actual, element-web, memos, open-webui (no culprit named, or untagged), starlight #3934 and slidev #2519 (cause in a dependency, not in the repo's history), nextra v3 to v4 (thousands of commits).

## Run 1: VitePress #2949

Answer key (written 2026-11-01 before the run): culprit 070fc0a5 "feat(theme): use inert to avoid traverse menus and content with keyboard (#2932)", inside v1.0.0-rc.10..v1.0.0-rc.12 (25 commits). The fix in rc.13 is a revert of that commit. Symptom: on a production build, a doc page loaded directly has `inert` on `aside.VPSidebar`; clicking its links does nothing. Commenters say the dev server does not show it, so the profile `vitepress-docs` serves the production build with `vitepress preview`.

Risk noted before the run: the crawler starts at `/` and reaches doc pages by clicking, which is client-side navigation. If the record never loads a doc page directly, the check may not see the attribute. That is a limit of the crawl, and it is a fair result if so.

### Run 1a (2026-11-01 20:28 UTC, case `20261101T202836Z_v1.0.0-rc.10-vs-v1.0.0-rc.12`): a miss, and a useful one

- Verdict HOLD, 2 of 2 findings confirmed 3/3 and 3/3, 25 commits bisected in 5 steps, parent verified, chain verified. Total 617 s with a warm cache.
- **Found it: no.** The findings were R1, the version label in the nav bar (`1.0.0-rc.10` to `1.0.0-rc.12`, ranked "a person would notice", text a person reads) and R2, a scoped-style `data-v-` attribute that moved (markup churn). The word `inert` appears nowhere in the record.
- **Named the commit: no.** The bisect followed R1 and landed on d55ce0b "release: v1.0.0-rc.11", the commit that bumps the version in `package.json`. Correct for the question it asked, wrong for the regression.
- **Explained it:** not asked; there was no culprit to explain.

Why, read from the record rather than guessed: the crawl's 4 flows all start at `/` and reach the doc pages by clicking, which is client-side navigation; no step ever loaded a doc page by address, which is exactly where the issue says the bug shows. And had it loaded one, `inert` would have arrived as an *added* attribute, and added facts never became tests. Three changes to the pipeline followed, each with unit tests:

1. The crawl adds a direct load of every page its clicks reached (up to 8), as its own flow; a `goto` of another page is a flow boundary and the first replayed action of its test (`crawl/plan.mjs`, `findings.mjs`, `confirm.mjs`, `facts.mjs`).
2. A state attribute newly set on an element both versions have (`inert`, `disabled`, `hidden`, `readonly`, `aria-*`) becomes a finding whose test expects the attribute absent; new op `absent` in the assertion runtime and the exporter (`findings.mjs` `appearedStates`, `assert.mjs`, `export.mjs`).
3. A text that is the release's own version (the good value contains the good ref's version, the candidate value the candidate's, nothing else differs) is classed as churn, so it ranks last and never drives the bisect (`notice.mjs` `releaseLabel`, refs passed from `confirm.mjs`).

The record of run 1a stays as it is. Run 1b below is the same pair on the fixed pipeline, with a fresh crawl.

### Run 1b (2026-11-01 20:51 UTC, case `20261101T205128Z_v1.0.0-rc.10-vs-v1.0.0-rc.12`): still a miss, one gap closer

- Fresh crawl: 5 page states, 7 flows (4 by click, 3 direct loads of `/guide/what-is-vitepress`, `/reference/site-config`, `/guide/getting-started`), 10 steps. 6853 facts recorded, 0.8% masked. Total 362 s, every build cached.
- The version label is now classed "the release's own version label" and the recommendation turned to SHIP with the churn note, which is right for what was proven and wrong for the release: **found it: no.** `inert` is still absent from the record, even on the direct loads.
- Cause, read from the recorder this time: `facts.mjs` keeps a fixed list of attributes, and `inert` was not on it (nor `hidden`, `readonly`, `open`, `aria-disabled` and most other aria states). An attribute that is never recorded cannot be added, changed or missing. The list now includes those states.
- Also visible in this run: the bisect follows the first confirmed finding even when it is churn, so it bisected the version label to the release commit again. Harmless with a SHIP recommendation, but a wasted 164 s; when every finding is churn the search could be skipped.

### Run 1c (2026-11-01 20:58 UTC, case `20261101T205838Z_v1.0.0-rc.10-vs-v1.0.0-rc.12`): found it, bisect inconclusive

- 6857 facts, 0.5% masked. Three state attributes newly set on rc.12, all of them `inert` on `body/div[1]/div[1]/aside[1]` (the sidebar), at the three direct-load steps. **Found it: yes.** R1 is that attribute, ranked "a person would notice (a state a person sees (inert))", test passed 3/3 on rc.10 and failed 3/3 on rc.12. R2 is the version label (churn), R3 the scoped-style attribute (churn). HOLD.
- **Named the commit: no, inconclusive.** The bisect tested #12 good, #18 good, then every commit from #19 (070fc0a, the culprit) to #24 came back "skip (Error: expect(received).toBeNull())" and the search ended with "the first bad change is one of 7 (#19 to #25)". The search had the right answer in hand and could not read it: `bisect.mjs` `classify` only counted `toBe(`, `toContain(` and `toMatch(` failures as "bad" and treated anything else as a skip, so the new `toBeNull()` failure of the absent-attribute test was filed under "could not be tested". Fixed with a test: any failed value assertion (`toBe*`, `not.toBeNull`, `toContain`, `toMatch`) is bad; locator timeouts, build failures and crashes stay skips.
- Total 641 s, bisect 409 s of it (8 builds, 2 cached).

### Run 1d (2026-11-01 21:10 UTC, case `20261101T211047Z_v1.0.0-rc.10-vs-v1.0.0-rc.12`): found it and named the commit

- Same crawl (7 flows, 10 steps), 6876 facts, 0.8% masked, control 0 differences. Three findings, all confirmed 3/3 and 3/3: R1 `inert` newly set on the sidebar `aside` at a direct load (a person would notice), R2 the version label (churn), R3 a scoped-style attribute (churn). HOLD.
- **Found it: yes.** R1 is the symptom in the issue: the sidebar carries `inert` after a direct load of a doc page.
- **Named the commit: yes.** Bisect #12 good, #18 good, #21 bad, #19 bad: first bad change is #19 of 25, [070fc0a](https://github.com/vuejs/vitepress/commit/070fc0a56ddb941e26a098ba7207b5d1e91b7b51) "feat(theme): use inert to avoid traverse menus and content with keyboard (#2932)", 4 steps, parent c0ce7f7 verified good 3/3, 070fc0a verified bad 3/3. That is the commit the project reverted in rc.13. The run never saw the issue, the revert or any commit after rc.12.
- **Explained it:** not yet asked. The Ask-why call is the person's to send from the dashboard (one call, about a cent).
- Total 401 s with every build cached (compare 120 s, tests 92 s, pictures 36 s, bisect 152 s).

What this run cost to get right, in order: the crawl had to load pages directly (1a), the recorder had to record state attributes (1b), an attribute that appears had to become a test (1a), and the bisect had to read that test's failure (1c). None of these was specific to VitePress; each is a class of bug the pipeline could not see before today. The four cases stay in `out/evidence/` as the record of the sequence.

## Next

Run 2, Hoppscotch #5693, starts from zero: the repo is cloned at `~/dev/behique-apps/hoppscotch` with no profile, so the dashboard's set-up flow (inspect, propose, approve, verify, repair) is the first graded step. Docusaurus is cloned too (`~/dev/behique-apps/docusaurus`, 154 commits in range) for an overnight run.
