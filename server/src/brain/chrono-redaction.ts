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
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import {
  recordExpiry, recordContentExpiry, needsContentRedaction, REDACTED_CHRONO_FIELDS, declaredRetention,
  type RetentionSpace,
} from './chrono-retention.js';
import { COLLECTION_SUFFIX, TYPE_FIELD } from './ttl.js';
import type { ChronoEntry, KnowledgeType } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types.js';

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
 * and a stamp count in a debug line was not enough. Bounded by the number of policed types.
 */
const announced = new Set<string>();

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
    // From the record's OWN creation time. Using `now` would hand every existing record a fresh full window,
    // which is the opposite of what enabling a retention policy means.
    const createdMs = Date.parse(r.createdAt ?? '');
    if (!Number.isFinite(createdMs)) continue;   // cannot date it ⇒ cannot expire it
    const type = typeof r[typeField] === 'string' ? r[typeField] as string : undefined;
    const $set: Record<string, unknown> = {};
    const expireAt = recordExpiry(space, collection, type, createdMs);
    const contentAt = recordContentExpiry(space, collection, type, createdMs);
    if (expireAt) $set['_expireAt'] = expireAt;
    if (contentAt) $set['_contentExpireAt'] = contentAt;
    if (Object.keys($set).length === 0) continue;
    // A policy configured months ago and never applied begins deleting records the moment this pass reaches it.
    // That is the documented behaviour and it is still worth saying out loud, once, at info.
    const key = `${spaceId}|${collection}|${type ?? ''}`;
    if (!announced.has(key)) {
      announced.add(key);
      log.info(`Retention: '${spaceId}' ${collection}/${type} is being stamped from its schema window`
        + `${expireAt ? ` — delete at ${expireAt.toISOString()} for the oldest in this batch` : ''}`
        + `${contentAt ? `, detail dropped at ${contentAt.toISOString()}` : ''}`);
    }
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
  const rows = await col<ChronoEntry>(`${spaceId}_chrono`)
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
    await col<ChronoEntry>(`${spaceId}_chrono`).updateOne(
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

/** Both passes across every real space. Best-effort per space: one bad collection must not stop the rest. */
export async function sweepChronoRetention(now: Date = new Date()): Promise<ChronoRetentionResult> {
  const result: ChronoRetentionResult = { stamped: 0, redacted: 0 };
  let cfg;
  try { cfg = getConfig(); } catch { return result; }   // pre-setup

  for (const s of cfg.spaces) {
    if (s.proxyFor?.length) continue;
    const space: RetentionSpace = { recordTtlDays: s.recordTtlDays, meta: s.meta };
    try {
      // All four typed collections, not just chrono. The schema tier is documented as reaching every one of
      // them, and for three of them nothing had ever stamped a record.
      for (const collection of TYPED_COLLECTIONS) {
        result.stamped += await backfillTypedExpiry(s.id, space, collection);
      }
      result.redacted += await redactLapsedChronoContent(s.id, now);
    } catch (err) {
      log.warn(`Chrono retention (${s.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.redacted > 0) {
    log.info(`Chrono retention: dropped the detail of ${result.redacted} record(s) past their content window `
      + '(the records themselves are kept)');
  }
  if (result.stamped > 0) {
    log.debug(`Chrono retention: stamped ${result.stamped} existing record(s) from the schema policy`);
  }
  return result;
}
