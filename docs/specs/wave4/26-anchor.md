---
part: anchor
owns:
  - src/release/anchor.mjs
  - src/release/anchor.test.mjs
context:
  - docs/specs/musicblocks/00-overview.md
  - src/release/evidence.mjs
  - src/release/evidence.test.mjs
test: node --test src/release/anchor.test.mjs
allow: []
---
# Part 26: anchor the evidence chain outside the case folder

Every evidence case is a folder with `events.ndjson`, where each line carries the sha256 of the previous line (`verify()` in `evidence.mjs`). That protects every line but the newest: the last line can be rewritten and the chain still verifies, and the whole folder can be replaced by another consistent one. This part adds a ledger that lives outside every case folder, is append-only and chained itself, and records the head hash of a case at chosen moments (when the run closes, when a person decides). A viewer can then say "all 42 events of this case are covered by a ledger entry written at 18:04" or "the last 2 events are not covered yet", and a case that was changed after it was anchored is caught. Pure file work with `node:fs` and `node:crypto`, no process, no network.

## `anchor.mjs` must export

### `ZERO`
The 64-character string of zeros used by `evidence.mjs` for "no previous line".

### `ledgerPath(root) -> string`
`join(root, 'anchors.ndjson')`. `root` is the evidence root (the folder that holds the case folders), so the ledger is outside every case.

### `headOf(c) -> { seq, head }`
`c` is what `openCase(dir)` returns. `seq` is the number of raw lines (`c.rawLines().length`), `head` is `sha(<last raw line>)` or `ZERO` when there are no lines. Use the exported `sha` of `evidence.mjs`.

### `anchor(root, caseId, c, { now = () => new Date(), mirror = null } = {}) -> entry`
Appends one line to the ledger: `{ ts, caseId, seq, head, prev }`, where `prev` is the sha256 of the previous ledger line (`ZERO` for the first), and returns the parsed entry. Rules: `caseId` must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/` (throw with a message naming the rule otherwise); a case with no events is never anchored (throw "nothing to anchor"); the ledger file and its folder are created when missing. When `mirror` is a path, the same line is appended to that file too (its own `prev` chain, computed from that file). The returned entry has no `prev` field removed: return exactly what was written.

### `readLedger(path) -> { entries, problems }`
Parses the ledger. `problems` lists, in order: a line that is not JSON (`line N: not a ledger entry`), an entry whose `prev` is not the sha256 of the previous line (`line N: the ledger chain is broken (an earlier entry was changed, removed or reordered)`). A missing file gives `{ entries: [], problems: [] }`.

### `verifyAnchors(root, caseId, c, { mirror = null } = {}) -> report`
Compares the case against every ledger entry for `caseId`. The report is `{ ok, anchored, total, since, entries, problems }`:
- `total` is the case's current number of raw lines; `anchored` is the highest `seq` among the case's entries that checked out (0 when none); `since = total - anchored` (events not covered by any entry).
- For each entry of this case, in order: when `entry.seq > total`, problem `anchor at <ts>: the record lost events (it had <seq>, now <total>)`; otherwise when `sha(rawLines[entry.seq - 1]) !== entry.head`, problem `anchor at <ts>: the record was changed after it was anchored at event <seq>`.
- Ledger `problems` from `readLedger` are included first.
- When `mirror` is given, read it too: every entry of this case in the main ledger must appear in the mirror with the same `seq` and `head` (and the reverse), else problem `the mirror disagrees with the ledger for event <seq>`.
- `ok` is true when there are no problems. A case that was never anchored is `ok: true, anchored: 0`.
Never throws for a missing ledger or a missing mirror file (the mirror missing is a problem: `the mirror file is missing`).

### `anchorText(report) -> string`
One sentence for a page: `Not anchored: the ledger outside the case holds no entry for it.` when `anchored === 0` and no problems; `Anchored: all <total> events are covered by the ledger outside the case.` when `since === 0`; `Anchored up to event <anchored> of <total>: the last <since> event(s) are not covered yet.` otherwise; when there are problems, `Anchor check FAILED: ` followed by the problems joined with `; `. Numbers use `toLocaleString('en-US')`. No long dash character.

## Tests (offline, temp directories)

Cover: `headOf` on an empty and a filled case; `anchor` writes a chained line, refuses a bad case id and an empty case, creates the folder, writes the mirror; `readLedger` on a missing file, a good file, a broken middle line, a non-JSON line; `verifyAnchors` after one anchor (ok, since 0), after one more event (since 1, still ok), after rewriting the last line of `events.ndjson` to a different but valid JSON event (a problem naming the event), after truncating the case (lost events), with a mirror that agrees and one that disagrees, with a missing mirror; `anchorText` for each of the four shapes.
