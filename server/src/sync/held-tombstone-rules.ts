/**
 * The rules that say whether a held tombstone speaks against an arriving version — over values already read, with no store behind them.
 *
 * ## The question it answers
 *
 * "Does a tombstone this instance holds refuse a version that arrives now, and is a row a later version of what that tombstone deleted?"
 * Asked by the record planner (`planArrivals`, `sync/upsert-plan.ts`), by a file's metadata and bytes (`files/tombstone-shadow.ts`) and by the
 * deletion authority (`sync/deletion-authority.ts`, which shares `tombstoneGoverns`). The accept rule itself (`isNewerCopy`) is here because
 * the issuer's "later version" is that rule and no second spelling of it may exist.
 *
 * ## What it prevents
 *
 * The pure shadow rules importing the planner. They lived in `upsert-plan.ts`, whose imports reach the whole brain, so
 * `files/tombstone-shadow.ts` — which is pure by its own account — had the database, the configuration and the file system in its import
 * closure. `the-shadow-rules-import-no-io` holds the closure of every module marked below; a rule added here that needs a store belongs elsewhere.
 *
 * @pure-rules  Imports nothing.
 */

/**
 * Is a copy at seq `incoming` newer than one held at `held` — the ONE accept rule of every arrival door: the
 * page planner (`planArrivals`, push and pull alike), the writer's collapse of a repeated id within one page, and
 * its read-back of a guarded write. Strictly greater, so an equal seq is NOT newer: across peers that makes a
 * re-sync a no-op, and inside one page it means the EARLIER of two equal copies stands — the planner's sequential
 * reading, applied on restore too.
 *
 * Nothing held is beaten by anything; a copy that has no seq (file metadata from before 4.0) beats nothing held
 * at a seq — but a held copy with no seq is overwritten by anything that arrives.
 */
export function isNewerCopy(incoming: number | undefined, held: number | undefined): boolean {
  if (held === undefined) return true;
  if (incoming === undefined) return false;
  return incoming > held;
}

/**
 * Does a held tombstone speak against an arriving version written by `author` and delivered by `deliveredBy`, whatever
 * the two versions are? The WHO half of the arrival question (the rules above), asked by a record (`tombSeqFor`) and by
 * a file's metadata (`shadowDecision` in `files/tombstones.ts`); the version half is each kind's own.
 *
 * What it prevents: the file side once asked only the version, so a tombstone any pushing peer stored for a path nobody
 * held yet, at a high version, refused every later version of a file at that path from every author — and a path,
 * unlike a record id, is easy to guess.
 */
export function heldTombstoneRefuses(
  held: { issuer?: string; storedVia?: string }, author: string | undefined, deliveredBy: string | undefined,
): boolean {
  if (supersededVia(held, deliveredBy) !== undefined) return false;
  const provenOtherAuthor = !tombstoneGoverns(held.issuer, author) && deliveredBy !== undefined && author === deliveredBy;
  return !provenOtherAuthor;
}

/**
 * Is `row` a LATER version of the path a held tombstone deleted, written by the tombstone's own issuer? The ARRIVAL side of
 * the question of whether deleted content came back (bundle-71, Q-349): a deleted file's sidecars are shadowed by their
 * parent's tombstone until the parent is re-created, and a re-creation by the instance that deleted it is the one a version
 * number can speak for.
 *
 * **Never the version alone, across authors**: two instances' seq counters are not one clock, so another author's higher
 * number says nothing about whether the deleted content came back. A tombstone with no issuer or no version, or a row with no
 * author or no version, names nothing to compare, so the answer is no.
 */
export function isNewerVersionByTheIssuer(
  held: { issuer?: string; rowSeq?: number }, row: { author?: { instanceId?: string }; seq?: number },
): boolean {
  const author = row.author?.instanceId;
  return !!held.issuer && held.issuer === author
    && typeof row.seq === 'number' && typeof held.rowSeq === 'number' && isNewerCopy(row.seq, held.rowSeq);
}

/**
 * The upstream whose delivery supersedes `held`, or `undefined` when none does: the tombstone was stored for the very
 * peer now delivering a version of the record. It does not refuse that version (`tombSeqFor`) and it is DELETED once
 * the version lands (`tombstoneCleanups.via`) — otherwise this instance would go on serving a deletion of a record it
 * now holds in a newer version, and a child whose copy it delivered would apply it and lose that version too.
 */
export function supersededVia(held: { storedVia?: string }, deliveredBy: string | undefined): string | undefined {
  return held.storedVia !== undefined && held.storedVia === deliveredBy ? held.storedVia : undefined;
}

/**
 * May a tombstone `issuer` issued speak for a record `author` wrote? Only when they are the same instance — or when
 * either is unknown (a legacy tombstone, an author-less record), which governs as it always did. The one spelling of
 * the rule, for the two questions that ask it: whether a peer's tombstone may delete a record held here
 * (`applyPeerTombstones`) and whether a held tombstone refuses an arriving record (`planArrivals`).
 */
export function tombstoneGoverns(issuer: string | undefined, author: string | undefined): boolean {
  return !(issuer && author && issuer !== author);
}
