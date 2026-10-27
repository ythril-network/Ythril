# 18 — Every kind keeps both edits, and each instance decides its own copy

**Status:** accepted, 2026-10 (D-23 for every kind, confirmed for 6.0) · **Supersedes:** [15](15-two-copies-at-one-version-are-kept-and-settled-in-review.md) points 1, 2 and 5 ("only facts fork") · **Scope:** forks of facts, entities, chrono entries and edges; Review's list and resolve on REST and MCP; deletion, re-key and merge of a record that holds forks; a peer's tombstone for a fork

## Context

[15](15-two-copies-at-one-version-are-kept-and-settled-in-review.md) kept a fact that two instances wrote differently at one version as a fork and let the owner settle it in Review. Every other kind still chose one copy silently, and a resolve's tombstone for a fork another instance wrote was declined on mesh peers, so the fork stayed there with nothing to say why.

## Decision

1. **Every kind but links and files forks.** An equal-version copy with a different body (the whole body, not one field) is kept as a fork row of its own kind, under an id derived from its parent, the version it forked at and its body, so every instance derives one id. Links are out (a link's body is its identity); files keep their own conflict copies.
2. **A fork row is read-only** to every ordinary door: it changes only by resolve, delete, arrival, or a re-mint when its subject is re-keyed or merged. Deleting a record deletes its forks.
3. **Resolve is required to name the kind and both versions** (`kind`, `forkId`, `keep`, `ifMatchSeq`, `ifMatchParentSeq`), writes the kept body onto the parent above both versions, and removes THIS instance's copy of the fork. Orphans are listed and resolved too.
4. **My instance, my data.** A peer's tombstone for a fork that this instance's deletion authority declines does not delete it: the fork stays, marked `_resolvedElsewhere` (a local-only field, restored, never hashed), and this instance's user decides it with the same resolve. A declined tombstone is not relayed, so an instance reached only through a peer that declined it keeps the fork unmarked and decides it itself.

## Consequences

Until each instance decides, the instances hold different forks and the space hash says so. The edge identity index is rebuilt once per space so a fork edge can share its subject's identity, and the rollback to 5.6 refuses while entity, edge or chrono forks are stored.

## The reversal to prevent

Carrying a resolution on the parent so that every instance deletes its own copy of the fork (it widens who may delete a record another instance wrote, and a peer's choice becomes a silent override here), deleting a fork whose tombstone the deletion authority declined, or letting an ordinary edit change a fork row in place (a relabelled fork edge takes its subject's identity slot for ever).

## Where the detail lives

- `server/src/brain/forks.ts` — the read-only refusal, the removal with the subject, the re-mint, Review's list and resolve.
- `server/src/brain/fork-keep.ts` — the one keep-writer.
- `server/src/sync/resolved-elsewhere.ts` and `server/src/sync/tombstone-apply.ts` — the mark a declined fork tombstone leaves.
- `server/src/sync/upsert-plan.ts` — the list of forking families, the fork id and the arrival half of the mark.
- `docs/integration-guide/04-brain-api.md` — the routes; `docs/userguide/02-brain.md` — Review > Forks.
