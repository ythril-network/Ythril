# 15 — Two copies at one version with different text are both kept, and the owner settles them in Review

**Status:** accepted, 2026-10 (D-23) · **Scope:** a fact that two instances wrote differently at one `seq` (the fork), Review's Forks list and resolve on REST (`GET /api/brain/spaces/:spaceId/forks`, `POST .../forks/:forkId/resolve`) and MCP (`list_forks`, `resolve_fork`), and the per-record fork cap

## Context

Two instances can edit one fact before either has seen the other's edit, and both stamp the same `seq`. A receiver cannot tell which is newer, and choosing silently loses an edit nobody agreed to lose. Sync already kept the second copy as a **fork**: a fact under a derived id (the parent's id, the shared `seq` and the text) whose `forkOf` names the parent. But nothing listed forks and nothing resolved one, so the pair stayed for ever, and a record at its fork cap dropped the next differing copy with only a log line.

## Decision

1. **Both edits are kept as a conflict, and the owner settles it.** Review lists every fork beside its parent (`{ forkId, parentId, fork, parent, edgeCount, linkCount, siblings }`, paged by `skip` and `limit`) on both doors with one set of parameters, caps and refusals, and rights of `knowledge: read` to list and `knowledge: write` to resolve.
2. **Resolving keeps one side and does three things.** The kept body is written as a local edit of the parent, stamped above both versions, so a peer holding either copy takes it; the fork is deleted behind a tombstone this instance issues; and every edge and link that named the fork names the parent (the same relink an entity merge runs). The parent is written first, so a failure part-way leaves the fork stored and the same call resolves it again.
3. **The cap is one constant the client reads.** A record may hold only so many forks, a number the server keeps once (in `server/src/sync/upsert-plan.ts`); the list answers it as `maxForksPerRecord` and the client holds no number of its own.
4. **A redacted chrono copy is the same copy.** Two chrono copies at one `seq` whose bodies differ only by the redaction a retention window applied (one side has the redaction marks, the other more of the fields redaction removes) neither fork nor write.
5. **Only facts fork.** For entities, edges, chrono entries and links an equal `seq` is skipped, as before; an edge or a link could not hold a second row for one identity (the identity index refuses it).

## Consequences

- A fork at the cap needs one resolved before another version of that record is kept; the Server Log names every dropped copy.
- A fork authored by a peer is deleted by a tombstone that peer, as the fork's author, may refuse; the peer then keeps its fork until it resolves it too.
- An edge a peer authored that pointed at the fork is moved with the rest (the one place a peer-authored edge is re-keyed here).

## The reversal to prevent

Picking a winner silently on an equal `seq` (by timestamp, by instance id, by length), which loses an edit with nothing to show for it; resolving by deleting the fork alone, which leaves its edges and links pointing at a deleted record; and giving the client its own copy of the cap.

## Where the detail lives

- `server/src/brain/forks.ts` — the list and the resolve, for both doors.
- `server/src/brain/relink-references.ts` — what points at a record that is deleted in favour of another.
- `server/src/sync/upsert-plan.ts` — the fork rule, the derived fork id and the caps.
- `docs/integration-guide/04-brain-api.md` — the routes; `docs/userguide/02-brain.md` — the Forks tab.
