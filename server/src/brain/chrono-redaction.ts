/**
 * The chrono content-redaction pass, and the lazy backfill that makes schema-tier retention apply to records
 * that already exist.
 *
 * ## The backfill covers all four typed collections; redaction is chrono-only
 *
 * Those are two different reasons, not one inconsistency. **Redaction** removes `description`, `matchedText` and
 * the embedding — chrono's field names, and the tier is declared chrono-only in `CONTENT_TIER_COLLECTIONS`.
 * **Backfill** just stamps `_expireAt` from a policy, which every typed collection has.
 *
 * It did not, until now. The schema tier is documented as reaching *"every record of that type, in any of the
 * four typed collections"*, and for entities, facts and edges nothing had ever stamped a record: the create
 * path never passed its collection to the resolver, so it silently fell through to the space default, and this
 * pass only ever walked chrono. `files` stays out on purpose — a file has no type, so it has no schema window.
 *
 * ## Why this is lazy rather than a boot migration
 *
 * `<space>_chrono` is **synced data**: it replicates to peers by whole-document upsert. A boot migration would
 * stamp local copies while a peer's older copies came back unstamped on the next pull, so the policy would
 * apply on some instances and not others depending on who booted when. Self-healing on a timer is the shape
 * synced data requires — see `_REFERENCE.md → migration-strategy`. It is also what makes a policy CHANGE take
 * effect: an operator who sets a type's retention today expects it to apply to the records they already have,
 * not only to ones written from now on.
 *
 * ## What the two passes do
 *
 * **Backfill** stamps `_expireAt` / `_contentExpireAt` from the record's own `createdAt`, not from now — so
 * turning a policy on does not grant every existing record a fresh full window. It only ever ADDS a stamp that
 * is missing; it never re-slides one, because that is how a record with a deliberate per-record `ttlDays` would
 * silently have it overwritten.
 *
 * **Redaction** drops the bulky, recallable half and sets `contentRedacted: true`. It writes through the
 * collection directly rather than the update path on purpose: this is not a user edit, it must not bump `seq`
 * or fire a `chrono.updated` webhook, and every instance performs it independently from the same policy and the
 * same `createdAt`, so the result converges without needing to replicate.
 *
 * Dropping `embedding` is the point, not a side effect: the reported failure was content-free deploy events
 * winning semantic searches over real knowledge, and a record with no vector cannot win one.
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { log, peerText } from '../util/log.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { warnOnce } from '../util/warn-once.js';
import {
  needsContentRedaction, REDACTED_CHRONO_FIELDS, declaredRetention,
  type RetentionSpace,
} from './chrono-retention.js';
import { COLLECTION_SUFFIX, TYPE_FIELD, retentionStamps } from './ttl.js';
import type { ChronoEntry, KnowledgeType } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';

/** Every collection the schema tier can reach. `files` is absent: a file has no type, so no schema window. */
const TYPED_COLLECTIONS: readonly KnowledgeType[] = KNOWLEDGE_TYPES;

/** Max records touched per space per pass, so one enormous space cannot monopolise a sweep cycle. */
const BATCH = 500;

export interface ChronoRetentionResult {
  /** Records given a missing `_expireAt` / `_contentExpireAt` from an existing policy. */
  stamped: number;
  /** Records whose content window lapsed and whose detail was dropped. */
  redacted: number;
}

/** The types in one collection whose schema declares a retention window — the check that skips the common case. */
export function policedTypes(space: RetentionSpace, collection: KnowledgeType): string[] {
  return declaredRetention(space).filter(r => r.collection === collection).map(r => r.type);
}

/** Kept as the chrono-specific name the redaction pass and its tests read. */
export function policedChronoTypes(space: RetentionSpace): string[] {
  return policedTypes(space, 'chrono');
}

/**
 * Windows already reported at info, so switching a policy on announces itself ONCE rather than per sweep.
 *
 * Process-lifetime, deliberately not persisted: a restart re-announcing the active delete policies is useful,
 * and a stamp count in a debug line was not enough. A `warnOnce` rather than a Set: the key carries a TYPE name an
 * operator chose, so the number of keys is not bounded by anything this code controls, and `warnOnce` forgets its
 * least recently reported key past its limit (a forgotten one is announced again, the safe direction for a notice).
 * `forget` is how a policy that was switched off and on again is announced again.
 */
export const retentionAnnounced = warnOnce<string>();

/** The key one announcement is remembered under: a space, a collection and a type. */
export function retentionAnnouncementKey(spaceId: string, collection: KnowledgeType, type: string | undefined): string {
  return `${spaceId}|${collection}|${type ?? ''}`;
}

/**
 * Stamp records that a schema policy covers but that carry no expiry yet.
 *
 * Only fetches records missing BOTH stamps, so a settled collection costs one indexed miss per cycle.
 *
 * **Schema tier only.** A record written before the SPACE default was set is deliberately left alone: widening
 * this to `recordTtlDays` would start deleting historic records on every space that has ever set one, which is a
 * far larger blast radius than the policy change the operator made.
 */
export async function backfillTypedExpiry(
  spaceId: string,
  space: RetentionSpace,
  collection: KnowledgeType,
): Promise<number> {
  const types = policedTypes(space, collection);
  if (types.length === 0) return 0;
  let stamped = 0;

  const name = `${spaceId}_${COLLECTION_SUFFIX[collection]}`;
  const typeField = TYPE_FIELD[collection];
  const rows = await col(name)
    .find(
      asFilter({
        [typeField]: { $in: types },
        _expireAt: { $exists: false },
        _contentExpireAt: { $exists: false },
      }),
      { projection: { _id: 1, [typeField]: 1, createdAt: 1 } },
    )
    .limit(BATCH)
    .toArray() as unknown as Array<Record<string, unknown> & { _id: string; createdAt?: string }>;

  for (const r of rows) {
    // From the record's OWN creation time — the same stamping step as the arrival writer's (`retentionStamps`).
    // Using `now` would hand every existing record a fresh full window, the opposite of what enabling a retention
    // policy means. The schema-only half of this pass's policy is WHICH records it reaches (`policedTypes`, above).
    const type = typeof r[typeField] === 'string' ? r[typeField] as string : undefined;
    const $set: Record<string, unknown> = retentionStamps(space, collection, r);
    const expireAt = $set['_expireAt'] as Date | undefined;
    const contentAt = $set['_contentExpireAt'] as Date | undefined;
    if (Object.keys($set).length === 0) continue;
    // A policy configured months ago and never applied begins deleting records the moment this pass reaches it.
    // That is the documented behaviour and it is still worth saying out loud, once, at info.
    retentionAnnounced(retentionAnnouncementKey(spaceId, collection, type), () => {
      log.info(`Retention: '${peerText(spaceId)}' ${collection}/${peerText(type)} is being stamped from its schema window`
        + `${expireAt ? ` — delete at ${expireAt.toISOString()} for the oldest in this batch` : ''}`
        + `${contentAt ? `, detail dropped at ${contentAt.toISOString()}` : ''}`);
    });
    await col(name).updateOne(asFilter({ _id: r._id }), asUpdate({ $set }));
    stamped++;
  }
  return stamped;
}

/** Chrono-only alias, kept because the redaction pass and its DB tests are chrono-specific by nature. */
export async function backfillChronoExpiry(spaceId: string, space: RetentionSpace): Promise<number> {
  return backfillTypedExpiry(spaceId, space, 'chrono');
}

/** Drop the content of records whose content window has lapsed, keeping the record. */
export async function redactLapsedChronoContent(spaceId: string, now: Date): Promise<number> {
  let redacted = 0;
  const rows = await col<ChronoEntry>(spaceCollection(spaceId, 'chrono'))
    .find(
      asFilter<ChronoEntry>({ _contentExpireAt: { $lte: now }, contentRedacted: { $ne: true } }),
      { projection: { _id: 1, description: 1, matchedText: 1, properties: 1, embedding: 1, embeddingModel: 1, contentRedacted: 1 } },
    )
    .limit(BATCH)
    .toArray() as unknown as Array<Record<string, unknown> & { _id: string }>;

  for (const r of rows) {
    // Already bare (a chrono with only a title) — mark it so the query stops returning it, but do not pretend
    // detail was removed.
    const $unset: Record<string, ''> = {};
    if (needsContentRedaction(r)) {
      for (const f of REDACTED_CHRONO_FIELDS) if (r[f] !== undefined) $unset[f] = '';
    }
    await col<ChronoEntry>(spaceCollection(spaceId, 'chrono')).updateOne(
      asFilter<ChronoEntry>({ _id: r._id }),
      asUpdate<ChronoEntry>({
        $set: { contentRedacted: true, contentRedactedAt: now.toISOString() },
        ...(Object.keys($unset).length > 0 ? { $unset } : {}),
      }),
    );
    redacted++;
  }
  return redacted;
}

/** The step the sweep's failures are said and counted under. */
const CHRONO_RETENTION_STEP = declareStep('Chrono retention');

/** The two halves of one space's pass, named as a failure line quotes them. */
const BACKFILL_UNIT = 'backfill';
const REDACTION_UNIT = 'redaction';

/**
 * Both passes across every real space, through the housekeeping walk (`util/housekeeping-walk.ts`): a space that fails is
 * reported once and the next is swept, and a read that hangs ends at the housekeeping figure, not at the driver's patience.
 *
 * The two halves are two UNITS of a space, so a backfill that fails does not stop the same space's redaction (they share no
 * data: one stamps what is missing, the other drops what has lapsed) and neither is lost to the other's failure. The backfill
 * is bounded by `housekeepingOpMs()` and not by the write figure on purpose: its `_expireAt: { $exists: false }` scan can be slow
 * and healthy, and the bound is for "hung", not "slow".
 */
export async function sweepChronoRetention(now: Date = new Date()): Promise<ChronoRetentionResult> {
  const result: ChronoRetentionResult = { stamped: 0, redacted: 0 };
  await eachSpace(CHRONO_RETENTION_STEP, concreteSpaces(), async (s) => {
    const space: RetentionSpace = { recordTtlDays: s.recordTtlDays, meta: s.meta };
    await eachUnit([BACKFILL_UNIT, REDACTION_UNIT], async (unit) => {
      if (unit === BACKFILL_UNIT) {
        // All four typed collections, not just chrono. The schema tier is documented as reaching every one of
        // them, and for three of them nothing had ever stamped a record.
        for (const collection of TYPED_COLLECTIONS) {
          result.stamped += await backfillTypedExpiry(s.id, space, collection);
        }
      } else {
        result.redacted += await redactLapsedChronoContent(s.id, now);
      }
    });
  });

  if (result.redacted > 0) {
    log.info(`Chrono retention: dropped the detail of ${result.redacted} record(s) past their content window `
      + '(the records themselves are kept)');
  }
  if (result.stamped > 0) {
    log.debug(`Chrono retention: stamped ${result.stamped} existing record(s) from the schema policy`);
  }
  return result;
}
