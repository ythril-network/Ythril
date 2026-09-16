import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { TOMBSTONE_COLLECTION } from '../config/types.js';
import { log } from '../util/log.js';
import type { TombstoneDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';

/** Context for authorising a remote tombstone's deletion of a local document. */
export interface TombstoneAuth {
  /** instanceId of the authenticated peer that delivered this tombstone
   *  (the peer we pulled from, or the caller of POST /tombstones). */
  peerInstanceId?: string;
  /** True when the caller is a trusted local/admin token (no peer identity). */
  trustedRelay?: boolean;
}

/** List tombstones with seq greater than the given watermark */
export async function listTombstones(
  spaceId: string,
  sinceSeq: number,
  limit = 200,
  type?: TombstoneDoc['type'],
): Promise<TombstoneDoc[]> {
  const filter: Record<string, unknown> = { seq: { $gt: sinceSeq } };
  if (type) filter['type'] = type;
  return col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'))
    .find(asFilter<TombstoneDoc>(filter))
    .sort({ seq: 1 })
    .limit(limit)
    .toArray() as Promise<TombstoneDoc[]>;
}

/** Write a tombstone received from a peer (only if local seq is lower or doc doesn't exist) */
export async function applyRemoteTombstone(tombstone: TombstoneDoc, auth: TombstoneAuth = {}): Promise<void> {
  const { spaceId, _id, type, seq } = tombstone;

  // Idempotent upsert — only insert if not present or remote seq is higher
  await col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones')).updateOne(
    asFilter<TombstoneDoc>({ _id }),
    asUpdate<TombstoneDoc>({ $setOnInsert: tombstone }),
    { upsert: true },
  );

  // If the doc already exists locally with a strictly higher seq, the remote tombstone is stale — skip
  // Note: equal seq means we just inserted it above (or it already existed at same seq), so still apply.
  const existing = await col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones')).findOne(asFilter<TombstoneDoc>({ _id }));
  if (existing && (existing as TombstoneDoc).seq > seq) return;

  // Delete the underlying document — but only if it was authored by the same
  // instance that issued the tombstone. This prevents a remote tombstone from
  // deleting locally-authored content (critical for pubsub subscribers who
  // may have their own data alongside publisher-pushed content).
  /*
   * DERIVED, and it was a `Record<string, string>` — a map with no keys.
   *
   * A tombstone type absent from it read as `undefined`, `targetColl` was falsy, and the tombstone was
   * stored while the underlying document stayed exactly where it was. Stored, reported, and nothing deleted:
   * the peer that issued the delete gets a 200 and every later cycle agrees there is nothing to do.
   *
   * That was live for `M-2`'s links the moment a link could be tombstoned. `A-10` removed two other copies
   * of this shape and `TOMBSTONE_COLLECTION` is now the one keyed vocabulary — so a new tombstone type is a
   * compiler error here rather than a delete that quietly does nothing.
   */
  const targetColl = `${spaceId}_${TOMBSTONE_COLLECTION[type]}`;
  {
    /*
     * The `if (targetColl)` this block used to be guarded by is GONE, and that is the change rather than a
     * tidy-up. It was the only thing standing between an unmapped tombstone type and a silent no-op — and it
     * could not report the case it was catching, because a falsy collection name and "nothing to delete here"
     * look identical from inside a condition. The map is total over `TombstoneType` now, so the case the
     * guard existed for is a compiler error instead.
     */
    const localDoc = await col(targetColl).findOne(asFilter({ _id })) as { author?: { instanceId?: string } } | null;
    if (localDoc?.author?.instanceId) {
      const issuer = tombstone.instanceId;
      // The tombstone may only delete a document authored by its own issuer.
      if (localDoc.author.instanceId !== issuer) return;

      // SECURITY: `issuer` is attacker-controllable, so matching it against the
      // doc's author is not enough — a malicious peer could forge a tombstone
      // with `instanceId` set to a victim instance to delete that victim's data.
      // Require proof that the delete is authorised: either the tombstone was
      // delivered directly by its issuer (the authenticated peer IS the author),
      // or it came from a trusted local/admin token. A tombstone relayed by a
      // third party on behalf of another author is refused; the authoring peer's
      // own tombstone reaches us first-hand on direct sync.
      const authorised =
        auth.trustedRelay === true ||
        (auth.peerInstanceId !== undefined && auth.peerInstanceId === issuer);
      if (!authorised) {
        log.warn(
          `Refusing tombstone for doc '${_id}' (${type}) in space '${spaceId}': issuer '${issuer}' ` +
          `is not the delivering peer '${auth.peerInstanceId ?? '-'}' — possible cross-instance delete forgery`,
        );
        return;
      }
    }
    // Documents without author metadata (legacy) carry nothing to protect — delete as before.
    await col(targetColl).deleteOne(asFilter({ _id }));
  }
}
