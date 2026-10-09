# 07 — A functional label is held by a local marker plus a unique partial index

**Status:** accepted, 2026-10-09 · **Scope:** how an instance's own writers are kept from storing two edges under a
`functional` label from one subject in a `strict` space

## Context

A `functional` label allows a subject one edge. The rule was enforced by counting: a write read the subject's other edges,
saw none and wrote. Two writers that both counted zero both wrote, and nothing in the store could refuse the second. The
race was real on every door that creates an edge and on a relabel, which never sees the planner at all.

A unique index is the only thing that can refuse the second writer, and the obvious one is not available. An index over
`(from, label)` for every edge would forbid a second edge under every label, functional or not; one limited to functional
labels cannot be declared, because which labels are functional is per-space schema, changes at runtime, and does not apply
at all in a `warn` or `off` space; and a space that already holds two edges under a label would fail the build.

## Decision

- **A marker plus a partial unique index.** An edge a `strict` space inserts under a functional label carries
  `_functionalGuard`, a pure function of `(from, label)`. A unique index over it that only indexes string values refuses a
  second insert. The loser's failure is the ordinary lost-race path: it is decided again against the winner and refused with
  the same `functional` violation a sequential second write gets, on every door. Edges that carry no marker are not indexed,
  so every other edge, every `warn` or `off` space and every restored edge is unaffected.
- **The marker is local and is neither restored nor derived.** It is local-only (never hashed, sent or taken from an
  arrival), but it is a lock in this instance's own index and not a fact about the record, so an export and a restore do not
  carry it and an embed never clears it. That makes it a third class beside the restored and the derived fields.
- **Its invariant is the whole design.** The marker is the key of the edge's current `from` and `label`, so every writer that
  changes either drops it, restamps it, or carries it only while both are unchanged. A marker that outlives its subject holds
  a slot for ever, so the one place that finds such a phantom (a write refused on a marker whose holder is not under it) clears
  it by compare-and-swap and lets the write retry once.
- **The scope is stated.** Among this instance's own writers, in a `strict` space. A sync arrival, a merge and an import
  store and report, as they always did. An absent index is deliberately not fatal: the floor is the planner's count, the
  absence is reported through the housekeeping reporter, and a space whose index cannot be built still starts.
- **"Another edge" is a different identity**: `to` and both end kinds. One definition counts it for the planner, the merge and
  the stored-edge dry run.

## Rejected

- **A guard collection written in a transaction with the edge.** A duplicate key aborts the whole transaction, so the
  commit path would need a restructure that separates a lost race from a failed batch, and a guard stuck behind a held
  transaction pins the space's sequence horizon, which holds back replication of the space for up to the hold deadline.
- **Replicating the marker like any other field.** A peer's marker names a subject under another instance's index; two
  instances' markers would collide on arrival, and a restored backup could bring a second marker for one subject.
- **Treating it as derived.** An embed's content change clears every derived field, which would silently unguard the edge.

## Consequences

- One unique index per edges collection, built when a space is set up, and rebuilt by an online restore (which drops every
  collection). A build that cannot finish is said, not fatal.
- A rollback leaves the index behind and an older build hashes the marker; a re-upgrade heals a drifted marker the first time
  a write meets it, and `validate-schema` lists them as `staleGuards`, apart from violations.
- A second edge to the same `to` of another kind is now refused, where the planner counted `to` alone.
- **The reversal to prevent:** treating the marker as an ordinary record field ("so it survives a restore"), or writing an
  edge-changing path that copies a row whole without saying what it does with it. Either leaves a lock that names a subject
  its edge is not under, and every later write there is refused with an error nobody can explain.

## Where the detail lives

- `server/src/brain/functional-subject.ts` — the subject key and the one definition of "another edge".
- `server/src/spaces/edge-guard-index.ts` — the index declaration, its one builder and what a failed build says.
- `server/src/brain/write-plan/heal-stale-marker.ts` and `server/src/brain/write-plan/guarded-relabel.ts` — the phantom
  heal and a relabel's refusals.
- `server/src/sync/local-only-fields.ts` — the write-guard class beside the restored and derived ones.
- `CLAUDE.md` (the receiver section) — the invariant; `docs/integration-guide/06a-schema-api.md` — the guarantee;
  `docs/integration-guide/02b-upgrading.md` — upgrade and rollback.
- `testing/standalone/a-functional-label-holds-under-concurrent-writers-db.test.js` and
  `testing/standalone/every-edge-writer-says-what-it-does-with-the-functional-guard.test.js` — the race, and every writer held
  to the invariant.
