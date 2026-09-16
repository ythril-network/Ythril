/**
 * Record TTL / auto-expiry (F10) — write-side helpers (leaf module, no delete-path imports).
 *
 * An entry gets an absolute-expiry BSON `Date` (`_expireAt`) from either a per-record `ttlDays` on the
 * write, or the space's `recordTtlDays` auto-TTL. The sweep (`ttl-sweep.ts`) later deletes lapsed
 * records through the normal delete functions, so each deletion tombstones and propagates over sync —
 * correct in synced spaces (a raw MongoDB TTL index deletes below the app and the record would be
 * re-pulled from a peer). The `_expireAt` index just keeps the sweep query cheap.
 */
import { col } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { recordExpiry, recordContentExpiry, type RetentionSpace } from './chrono-retention.js';
import type { KnowledgeType, TtlBucket } from '../config/types.js';
import { COLLECTION_SUFFIX, BRAIN_COLLECTIONS, RECORD_COLLECTION } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';
export { COLLECTION_SUFFIX, BRAIN_COLLECTIONS, RECORD_COLLECTION };
export type { BrainCollection } from '../config/types.js';

const DAY_MS = 86_400_000;

/** Collections that carry per-record TTL. (`files` = the file-level FileMeta records; the sweep's
 *  deleter runs the full file cascade, and only file-level records ever carry `_expireAt`.) */
/**
 * The collections the TTL sweep walks.
 *
 * ## NOT ALL BRAIN COLLECTIONS, as of `M-2` — and it used to be
 *
 * This was `BRAIN_COLLECTIONS` exactly, and that equality held only while every collection had an
 * `_expireAt` to expire by. A link record has none, deliberately: a link's lifetime is its ENDPOINTS' — it
 * is meaningless once either end is gone, and a window of its own could outlive or predecease both. So the
 * cascade belongs on the delete path, and a per-record window would be a second, disagreeing answer to when
 * a link stops existing.
 *
 * Excluded rather than given an empty deleter, because the sweep's `DELETERS` map is deliberately TOTAL
 * over this list — that totality is what turns "a new collection can expire" into a compiler error instead
 * of a collection nothing ever sweeps. A no-op entry would satisfy the compiler and answer the question
 * wrongly, and it would cost one pointless query per space per cycle for ever.
 *
 * Derived by exclusion rather than written out, so a sixth collection is swept by default and has to be
 * argued OUT here — which is the safer direction to be wrong in.
 */
export const TTL_COLLECTIONS = BRAIN_COLLECTIONS.filter(c => c !== 'links');

// `COLLECTION_SUFFIX` moved to the types LEAF and is re-exported below, because five callers that needed it
// could not import this module: it sits on the delete path and half of them are imported BY it.

/**
 * The document field that names a record's type, per collection.
 *
 * **Edges key on `label`, not `type`** — `EdgeDoc` has both, and `validateEdgeWrite` looks the schema up by
 * `label`. Reading `type` for an edge finds a schema that is never there and looks like it worked.
 */
export const TYPE_FIELD: Record<KnowledgeType, 'type' | 'label'> = {
  entity: 'type', fact: 'type', edge: 'label', chrono: 'type',
};

/**
 * Expiry to stamp on **create**: a per-record `ttlDays > 0` wins; `ttlDays` 0/null means "never expire"
 * (no stamp even if the space has a default); omitted falls back to the schema then the space window.
 *
 * `typed` is REQUIRED in practice — every caller has one, and every caller that lacked one silently lost both
 * lower tiers. It stays optional only for the pre-setup/unknown-space path, where there is no config to read.
 */
export function expiryForCreate(
  spaceId: string,
  ttlDays?: number | null,
  typed?: { collection: TtlBucket; type?: string },
): Date | undefined {
  if (ttlDays === 0 || ttlDays === null) return undefined;
  if (typeof ttlDays === 'number' && ttlDays > 0) return new Date(Date.now() + ttlDays * DAY_MS);
  // record > schema > space (owner decision, 2026-08-02). The type's own schema may carry a window, which
  // overrides the space bucket — a telemetry space wants deploy events pruned and health snapshots kept, and
  // one number cannot express both. See `chrono-retention.ts`.
  const space = typed ? retentionSpace(spaceId) : undefined;
  if (space && typed) return recordExpiry(space, typed.collection, typed.type, Date.now(), ttlDays);
  return undefined;
}

/** Set `_expireAt` (and, for a chrono type with a content window, `_contentExpireAt`) on a create doc. */
export function stampExpiryOnCreate(
  spaceId: string,
  doc: { _expireAt?: Date; _contentExpireAt?: Date },
  ttlDays?: number | null,
  typed?: { collection: TtlBucket; type?: string },
): void {
  const expireAt = expiryForCreate(spaceId, ttlDays, typed);
  if (expireAt) doc._expireAt = expireAt;
  const contentAt = contentExpiryForCreate(spaceId, typed);
  if (contentAt) doc._contentExpireAt = contentAt;
}

/**
 * When this record's CONTENT should be dropped while the record itself stays — chrono only.
 *
 * Deliberately not gated on a per-record `ttlDays`: that says when the record goes, and says nothing about
 * whether its detail is worth keeping for the whole of that. An operator who set `ttlDays` for one record and
 * a content window for its type meant both.
 */
export function contentExpiryForCreate(
  spaceId: string,
  typed?: { collection: TtlBucket; type?: string },
): Date | undefined {
  if (!typed) return undefined;
  const space = retentionSpace(spaceId);
  return space ? recordContentExpiry(space, typed.collection, typed.type, Date.now()) : undefined;
}

/** The retention-relevant fields of a space, or undefined pre-setup / for an unknown id. */
function retentionSpace(spaceId: string): RetentionSpace | undefined {
  try {
    const s = getConfig().spaces.find(x => x.id === spaceId);
    return s ? { recordTtlDays: s.recordTtlDays, meta: s.meta } : undefined;
  } catch { return undefined; }
}

/**
 * Apply the TTL to an **update**'s `$set`/`$unset` in place:
 *   - `ttlDays > 0` → set a new expiry;
 *   - `ttlDays` 0/null → clear the expiry (opt the record out of the space default);
 *   - omitted → apply the resolved default **only when the record has no expiry yet** (`hasExistingExpiry`
 *     false), never re-sliding an existing one.
 *
 * `typed` carries the same schema tier as the create path. Without it this resolved straight to the SPACE
 * default, so a record that gained an expiry on update got the space number even when its own type declared a
 * shorter one — the type's window applied to records written after the policy and not to records edited after it.
 *
 * It takes the **collection plus the existing document**, not a type string, and works the type out itself. Seven
 * call sites would otherwise each have to pick the right field and the right precedence, and the bug this fixes
 * is precisely a caller getting that wrong: `edge` keys on `label` while its sibling collections key on `type`.
 */
export function applyExpiryToUpdate(
  spaceId: string,
  ttlDays: number | null | undefined,
  hasExistingExpiry: boolean,
  $set: Record<string, unknown>,
  $unset: Record<string, unknown>,
  typed?: { collection: KnowledgeType; existing: Record<string, unknown> },
): void {
  if (ttlDays === 0 || ttlDays === null) { $unset['_expireAt'] = ''; return; }
  if (typeof ttlDays === 'number' && ttlDays > 0) { $set['_expireAt'] = new Date(Date.now() + ttlDays * DAY_MS); return; }
  if (!hasExistingExpiry) {
    const expireAt = expiryForCreate(spaceId, undefined, typed && {
      collection: typed.collection,
      // The type the record will HAVE, not the one it had: an update that changes the type must resolve against
      // the new one, or a record moved into a policed type keeps the old type's window.
      type: effectiveType(typed.collection, $set, typed.existing),
    });
    if (expireAt) $set['_expireAt'] = expireAt;
  }
}

/** The type a record will carry after this `$set` is applied — the update's value if it sets one, else current. */
export function effectiveType(
  collection: KnowledgeType,
  $set: Record<string, unknown>,
  existing: Record<string, unknown>,
): string | undefined {
  const field = TYPE_FIELD[collection];
  const next = $set[field];
  if (typeof next === 'string') return next;
  const current = existing[field];
  return typeof current === 'string' ? current : undefined;
}

/** Ensure the (plain, non-TTL) `_expireAt` index that keeps the sweep query cheap. */
export async function ensureTtlIndex(spaceId: string): Promise<void> {
  await Promise.all(TTL_COLLECTIONS.map(async (c) => {
    try {
      await col(`${spaceId}_${c}`).createIndex({ _expireAt: 1 }, { name: 'ttl_expireAt', sparse: true });
    } catch (err) {
      log.warn(`ensureTtlIndex ${spaceId}_${c}: ${err}`);
    }
  }));
  // Chrono only: the content-redaction pass has its own sweep query, and without an index it would scan the
  // whole collection every five minutes on a space that never uses the feature.
  try {
    await col(spaceCollection(spaceId, 'chrono')).createIndex({ _contentExpireAt: 1 }, { name: 'ttl_contentExpireAt', sparse: true });
  } catch (err) {
    log.warn(`ensureTtlIndex ${spaceCollection(spaceId, 'chrono')} content: ${err}`);
  }
}
