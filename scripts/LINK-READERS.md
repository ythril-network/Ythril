# Link readers — 3.x against 4.0, measured

`Q-7` gate 3. Owner, 2026-09-03: *"4.0 is a big change thanks to links and other stuff — it should not break
or have worse performance than 3.x."*

Every number here was measured. Nothing is estimated, interpolated or rounded up.

## How

`scripts/bench-link-readers.mjs`, three runs against **one corpus** in one MongoDB 8.2.1 database, so the
comparison is about the code and not about which records happened to exist.

| run | code | reads from |
|---|---|---|
| `3.x` | `6506fb84`, the last commit before `M-2` slice 1 | the six array fields' three readable classes |
| `4.0-arrays` | `main` | the arrays, in a space with no `completeLinkage` |
| `4.0-links` | `main` | the link records, `completeLinkage` on |

`6506fb84` and not `v3.4.0`: it is 139 commits later and contains everything else in the 4.0 line, so the
difference between it and `main` is `M-2` and nothing else. A tag would have measured a year of unrelated work.

**Corpus** — 200 entities, 2 000 memories, 500 chrono entries, 300 files, 400 edges, and **8 380 link
records**. Sized from the LINK count rather than the record count, because a corpus small enough that every
plan is a collection scan measures the same thing twice.

**Each query runs 25 times and the MINIMUM is reported.** Five was not enough: two runs of the same code
disagreed by 20%, which is larger than some of the differences being measured.

## The numbers

Milliseconds. Lower is better.

| query | 3.x | 4.0-arrays | 4.0-links |
|---|---|---|---|
| `traverse` depth 1 | 2.65 | 5.46 | 4.33 |
| `traverse` depth 2 | 5.50 | 6.92 | 8.51 |
| `traverse` depth 3 | 7.44 | 9.98 | 12.57 |
| `traverse` depth 2, links off | 1.05 | 0.91 | 1.02 |
| backlink scan (refuses a delete) | 1.98 | 3.19 | 5.07 |
| `er_model` | 9.40 | 8.80 | 8.92 |

**Every run returned the identical answer** — 37, 107 and 179 nodes at the three depths, 39 backlink rows, one
entity type. That is the correctness half of the same measurement: a faster wrong answer would show here.

## What the numbers say

**The `links off` row is the control, and it did not move.** That is the edge walk with every link class
switched off, so it isolates everything `M-2` did NOT touch. 1.05 → 0.91 → 1.02 across three versions is
noise, which is what says the rest of the table is about links rather than about the release.

**`er_model` did not get slower**, and it is the one reader whose work `M-2` reduced rather than added to.

**`traverse` and the backlink scan ARE slower, by 1.3× to 1.7× on the link path, and the reason is the
feature.** 3.x followed three link classes; 4.0 follows six. `includeChrono` used to reach the entities a
timeline entry names and now also reaches the memories it names; `includeFiles` went from one class to three.

On THIS corpus those three new classes reach records the walk had already reached by another route, so they
cost time and return no extra nodes — which is why the node counts match exactly. On a corpus where a file
names a memory nothing else points at, that time is what finds it. **The cost is real and it buys the three
classes that had no reader at all.**

## The 3.8× regression this measurement caught, before release

The first implementation asked the links collection **once per class** and then fetched the named records
**once per class**: six link queries plus up to six document reads per hop, where the array walk does three
collection reads. Measured:

| query | 4.0-links, per-class | 4.0-links, batched | 4.0-arrays |
|---|---|---|---|
| `traverse` depth 1 | 18.10 | 4.33 | 5.46 |
| `traverse` depth 2 | 37.28 | 8.51 | 6.92 |
| `traverse` depth 3 | 55.95 | 12.57 | 9.98 |
| backlink scan | 10.71 | 5.07 | 3.19 |

**The indexed lookup was never the cost. The round trips were** — and the whole argument for link records was
that one indexed lookup beats three scans over arrays, which made the per-class version the exact opposite of
the design.

One query on the `{to, toKind}` index returns the whole hop and the classes are separated in memory. One
document read per COLLECTION rather than per class also stops a file being fetched three times, once for each
class it holds. Twelve round trips became four.

**Nothing but the pair could have found this.** Every functional test passed — the answers were identical
throughout, which is exactly why the row says *"a number from one version alone answers nothing."*

## Reproducing

```bash
node -e "require('mongodb')" && mongod --version   # 8.2.1 here
git worktree add /tmp/bench3x 6506fb84
cp scripts/bench-link-readers.mjs /tmp/bench3x/scripts/
cd /tmp/bench3x/server && npm run build
```

Then, with `MONGO_URI` pointing at a scratch database:

```bash
node scripts/bench-link-readers.mjs 4.0-arrays   # seeds the corpus and builds the link records
node scripts/bench-link-readers.mjs 4.0-links
cd /tmp/bench3x && node scripts/bench-link-readers.mjs 3.x
```

The seeder is idempotent and skips a corpus that is already there, so all three runs read the same data. The
`4.0-links` run refuses to report if the links collection is empty — a run that claims the link path and
measures the arrays would be the one wrong number nobody could spot.
