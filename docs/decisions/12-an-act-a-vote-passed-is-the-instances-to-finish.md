# 12 — An act a vote passed is the instance's to finish, and a passed act is never stranded

**Status:** accepted, 2026-10-17 · **Scope:** a deletion, a wipe or a space addition that a vote round has passed (`DELETE /api/spaces/:id`, `POST /api/admin/spaces/:spaceId/wipe`, `POST /api/delete_space_data`, MCP `delete_space_data`, and the space-addition round), and the protocol answers a sync peer gets while one is being applied

## Context

A vote that passes a deletion or a wipe is a decision the whole network has made. Until it is applied here, the network and this instance disagree about the space, and the rest of the network has moved on. Three things made that worse:

- **The door answered before the change ran, and the change could fail after the answer.** A passed round whose local act failed was left undecided here until another member's relay happened to carry the vote back, or until it expired.
- **A failed act was not retried, and nothing held the space while it was half done.** A peer that still held the old data could send it back, and a wipe that had reached some members undid itself on the next file sync.
- **A protocol answer that meant "wait" looked like a failure.** A sender that could not exchange a space while it was being wiped reported a fault, and an operator read a fault that was not there.

## Decision

1. **A proposer's own yes that carries the round acts at once.** On a club or pub/sub network, and on a closed or democratic network where this instance is the only member, the round is decided by the proposer's yes, and the door answers after the change has run. The `confirm` flag is required on a networked delete or wipe, because the act is then immediate.
2. **A passed space act is owed until it completes.** It is registered when the round concludes, retried with a backoff, and never stranded: a restart resumes it, and the expiry job retries it. While it stands, writes to the space are refused with `409` from every writer, and the space's exchange with every member is held.
3. **The owed act is not given up after a set number of attempts.** A move gives up after its attempts, because its bytes and its records stay reachable at one of two paths (decision 09). A voted deletion or wipe that gave up would release data the network voted away, so it is retried for as long as it is owed.
4. **A held exchange is an answer, not a failure.** `423` with `code: "space_held"` says the space is being applied on the other side; `423` with `code: "space_declined"` says a pub/sub subscriber has left the space. A sender that meets either classifies it as held or declined and retries on its next cycle.
5. **A late joiner always applies a passed deletion or wipe it concludes,** and a subscriber's round never passes on a publisher.

## Consequences

- A wipe closes its space to writes until it completes, so a write during a wipe answers `409` and is retried by its caller. The space's `actPending` and the network's `owedSpaceActs` show what is owed.
- A member that applies a networked wipe re-reads that space from its members once afterwards.
- An operator who rolls back before the owed acts are finished can lose them: see the rollback notes in the [upgrade guide](../integration-guide/02b-upgrading.md).

## The reversal to prevent

Reversing this decision means giving up an owed act after a set number of attempts, or reading a held exchange as a failure. The first releases data the network voted away; the second reports a fault that is not there, and an operator stops reading the signal.

## Where the detail lives

- The owed act, its retry and the write closure: `docs/integration-guide/03-auth-and-limits.md` (the `409` and `423` codes) and `docs/integration-guide/08-networks-api.md`.
- The exchange hold and the peer answers: `docs/sync-protocol.md` (The exchange hold) and `docs/integration-guide/09-sync-api.md` (Held spaces).
- The rollback: `docs/integration-guide/02b-upgrading.md`.
