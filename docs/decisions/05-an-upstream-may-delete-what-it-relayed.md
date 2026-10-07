# 05 — On a directional network, an upstream may delete what it delivered, and nothing else

**Status:** accepted, 2026-10-07 · **Scope:** the sync deletion rule for records and files on pub/sub networks and
trees (`braintree`); the rule on every other network type is unchanged

## Context

A deletion travels as a tombstone, and a tombstone names an issuer that anybody can write. Until 5.6, a receiver
therefore applied a tombstone only when the peer that delivered it **was** the issuer and the record's author was that
issuer too. That rule is what stops one member deleting another's content, and it is right on a mesh (club, closed,
democratic), where every member is a peer of every other.

On a pub/sub network or a tree it is wrong in one direction. Content flows **down**: a publisher relays records that
other instances wrote, and a node relays what its parent sent it. The only instance that can have deleted such a
record is the one it came from, and that instance is not its author, so the author rule declined every one of its
deletions. A record the publisher relayed from a third instance stayed on every subscriber after the publisher
deleted it, and so did every record the publisher's retention sweep removed after relaying it. The decline advanced
the subscriber's position, so nothing ever delivered the deletion again. Operators saw records they had deleted at
the top of a network still present below it, and had no signal that anything was wrong.

The same gap existed for files, with a second defect beside it: a file tombstone carried no issuer, was applied by any
peer that sent it, and was neither paged nor tied to the version it deleted, so a deleted file could come back from a
peer that had not heard, and one re-created after a deletion could be deleted again.

The owner's ruling of 2026-10-07 (three options were put: keep the rule, let any peer delete, or make the upstream
authoritative on a directional network): the upstream is authoritative on a directional network — *"a tombstone from
this instance's direct upstream deletes a record that arrived from that upstream, whoever wrote it; this instance's
own records and every other peer stay protected as today"* — with a one-time repair that re-delivers the deletions
already declined, and the accepted cost that a compromised or misconfigured publisher can delete what it relayed on
every subscriber.

## Decision

- **A deletion is applied on either of two grounds.** The issuer's own: the delivering peer is the issuer and the
  record's author is the issuer (or has no author). The upstream's: this instance's **direct upstream** delivers it,
  on a directional network that carries the space, and the record is one this instance stored **as delivered by
  that upstream**. One module answers the question for every door, records and files, push and pull and import.
- **A record this instance wrote is never the upstream's to delete**, and neither is a record that reached this
  instance by any other route. The upstream ground is exactly "what this upstream delivered here, not what I wrote".
- **Who delivered a record is stored, not inferred.** Every arrival is stamped by the one arrival writer with the
  delivering peer's id. The stamp is local to the instance: not hashed, never served, dropped from whatever arrives.
  Inferring it ("not authored here and the network is directional") was rejected because it fails whenever an
  instance is also a member of a second network, is re-parented, or adopts a subtree. Rows stored before the change
  are stamped **once**, by a stated rule, and from then on the stamp is the whole rule; a second, live fallback was
  rejected because it would be the rule nobody could state.
- **The delete write carries the verdict's own condition**, so a record that changed between the check and the delete
  is not removed by a stale verdict.
- **A file tombstone names its issuer and the version it deleted** (the seq of the file record, never a content
  hash, so a deletion reveals nothing about the content), is judged by the same module, and keeps a file re-created
  since. A held tombstone also stops the file it erased coming back from a peer that has not heard.
- **The one-time repair** re-reads each upstream's tombstones once per space, from the beginning, through the same rule
  plus a bound that fails toward keeping a re-created record. It recovers only what the upstream still holds.
- **Declines are visible**: counted by reason, said once per peer, space and reason, and reported in the push answer.

## Consequences

- **The accepted cost.** A publisher, or a tree node, that is compromised or misconfigured can delete, on every
  instance below it, everything it relayed to them. What it cannot reach is a record the instance wrote, or one
  that arrived through another peer. A subscriber's trust in its publisher was always this large for content; it is now
  this large for deletion.
- **Peer identity becomes load-bearing.** Tombstones are not signed; the rule is only as strong as the binding of a
  peer token to a peer. That was already true of the issuer ground and is a separate hardening item.
- **A retention sweep on an upstream applies to what it relayed.** It deletes through the normal path and issues a
  tombstone; on the upstream ground that tombstone applies below it, and the documentation says so where retention is
  explained.
- **The repair is bounded by what the source kept.** A tombstone pruned at the upstream is not recoverable by anything
  here; the residue stays until deleted by hand, and the upgrade notes say how to spot it. Upgrading root-first avoids
  a second residue, because a relayed tombstone keeps its issuer's seq.
- **Rolling back** returns to the older rule and leaves a stamp an older build does not know to treat as local.
- **This is the reversal to prevent:** widening the rule to "any peer's deletion applies" or to "an upstream may delete
  what this instance wrote" (each makes a delivered record, or the instance's own content, deletable by whoever
  can send a tombstone); dropping the stored delivery stamp for an inference from authorship and network type, which
  fails silently in exactly the topologies it was added for; and "fixing" a deletion that did not arrive by loosening
  the check instead of re-delivering it. A fourth, quieter form: adding a **third** place that compares a tombstone's
  issuer with a record's author. There is one module for it, and a gate holds that no other file does.

## Where the detail lives

- `server/src/sync/deletion-authority.ts` — the one question (`authorises`, `deleteBound`, the delivery) for both doors.
- `server/src/sync/tombstone-apply.ts` and `server/src/files/tombstones.ts` — the record and file applies.
- `server/src/sync/local-only-fields.ts` — the stamp's category: local, unhashed, kept by a restore.
- `docs/sync-protocol.md` — *Tombstone deletion authorisation*, the stamp, the back-fill and the one-time re-read.
- `docs/integration-guide/09-sync-api.md` and `docs/integration-guide/02b-upgrading.md` — the contract for integrators
  and what a mixed-version network does.
- `testing/standalone/a-tombstone-from-the-upstream-deletes-what-it-relayed-db.test.js` — the rule on both doors against
  seeded stores, and `testing/standalone/a-tombstone-authority-is-compared-in-one-module.test.js` — the gate.
