/**
 * Shared bulk-write batch processor.
 *
 * The REST `POST /api/brain/spaces/:id/bulk` endpoint and the MCP `save_bulk` tool were two
 * ~185-line parallel copies of the same validate-and-dispatch loop, and they had drifted (the
 * MCP copy skipped the 50k-fact cap and did not normalise chrono `status`). This is the one
 * source of truth: each surface coerces its input, calls `bulkWrite`, then shapes its own
 * response and emits the single `bulk.write` summary webhook (with its own actor).
 *
 * Per-item webhooks are intentionally NOT emitted here — the shared writers are called without a
 * WebhookActor, so a 10k-item import doesn't fire 10k events. The caller emits one summary.
 */

import { col, asFilter } from '../db/mongo.js';
import { primitivePropertyError } from './property-values.js';
import { shapeError } from './write-shape.js';
import { parseRecurrence } from './chrono.js';
import { assertRefsResolve } from './entity-refs.js';
import { getConfig } from '../config/loader.js';
import {
  resolveMetaRefs, getAllowedChronoTypes, validateFact, validateEntity, validateEdge, validateChrono,
} from '../spaces/schema-validation.js';
import { isStrictLinkage } from '../spaces/proxy.js';
import { saveFact } from './fact.js';
import { upsertEntity } from './entities.js';
import { upsertEdge, findEdgeByTriplet } from './edges.js';
import { BatchRefs, resolveRef, refKeyDeclared, isRefUse } from './batch-refs.js';
import { resolveEdgeEndsForWrite } from './edge-endpoint-names.js';
import { mergeTagsAndProperties, mergePropertiesOrKeep } from './merge-fields.js';
import { connectionInputError, assertConnections, applyConnections, edgeInputsFrom } from './write-connections.js';
import { createChrono } from './chrono.js';
import { CHRONO_STATUSES } from '../config/types.js';
import type { EntityDoc, ChronoType, ChronoStatus } from '../config/types.js';

/** Max items processed per collection in a single bulk call. */
export const BULK_MAX_PER_TYPE = 500;

import { UUID_V4_RE, edgeEndpointKind, isWellFormedRef } from './entity-refs.js';
import { storedEdgeKind } from './entity-refs.js';
import { REF_KINDS } from '../config/types-knowledge.js';
import type { RefKind } from '../config/types-knowledge.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import { spaceCollection } from '../db/space-collection.js';
// DERIVED. These five were written out here, in `brain/bulk.ts`, and in the shared write-shape table —
// three copies of one product fact, and the third had two of them wrong.
const CHRONO_STATUS_SET = new Set<ChronoStatus>(CHRONO_STATUSES);
const MAX_FACT_LENGTH = 50_000;

interface Counts { facts: number; entities: number; edges: number; chrono: number }

/**
 * The keys a batch body may carry, as a runtime tuple (`Q-41`).
 *
 * `BulkInput` is derived from it rather than written beside it, because the route has to REFUSE a key this
 * type does not declare and a TypeScript interface does not exist at runtime. Two hand-kept lists would
 * drift the moment a fifth collection is added — and the drift would be silent in the safe direction for
 * the compiler and the wrong one for a caller, who would be told a legitimate key is unknown.
 */
// NOT ALL BRAIN COLLECTIONS, deliberately: a batch writes the four knowledge kinds and nothing else.
// `files` are bytes and arrive through the file store, and `links` are written by the connection fields on
// an item rather than as a collection of their own — so this is a subset by capability, not by omission,
// and adding either here would be declaring a batch can do something it cannot.
export const BULK_BODY_KEYS = ['facts', 'entities', 'edges', 'chrono'] as const;

export type BulkInput = Partial<Record<typeof BULK_BODY_KEYS[number], unknown>>;

export interface BulkResult {
  inserted: Counts;
  updated: Counts;
  /**
   * What the ITEMS' own `link*` and `edges` fields attached (`Q-44`).
   *
   * Separate from `inserted.edges`, which counts the top-level `edges` ARRAY, because they answer different
   * questions: that array is a collection the caller wrote, these are relationships hung off records the
   * caller wrote. Folding them together would make `inserted.edges` a number nobody could reconcile against
   * the payload they sent.
   *
   * Links are the rows `reconcileLinks` ADDED, edges are the upserts — an edge that already existed is
   * updated rather than created, and this door does not tell the two apart for an item's own edges.
   */
  connections: { links: number; edges: number };
  errors: { type: string; index: number; reason: string }[];
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}
function optStrArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : undefined;
}
function optProps(v: unknown): Record<string, string | number | boolean> | undefined {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, string | number | boolean>) : undefined;
}
/** Sentinel: a per-item `ttlDays` was present but not a valid integer 0..36500 or null. */
const TTL_INVALID = Symbol('ttl-invalid');
/** Per-item TTL (F10): a non-negative integer ≤ 36500 sets an expiry, `null` clears it, absent →
 *  undefined (space default); anything else is TTL_INVALID so the item is reported and skipped. */
function bulkTtlDays(v: unknown): number | null | undefined | typeof TTL_INVALID {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 36500) return v;
  return TTL_INVALID;
}
const TTL_INVALID_MSG = '`ttlDays` must be an integer number of days between 0 and 36500, or null to clear the expiry';
function slice(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.slice(0, BULK_MAX_PER_TYPE) as Record<string, unknown>[]) : [];
}

/**
 * Why this ITEM's own `link*` and `edges` fields cannot be honoured, or `null` (`Q-44`).
 *
 * Everything but the first line is `connectionInputError`, the one module every single-record door already
 * calls — this door used to carry its own copy, a UUID pattern per link field, which checked less than the
 * shared one and drifted from it in the direction nothing reports: a `linkFiles` on a fact was accepted and
 * never read, and a non-array `linkEntities` was quietly treated as empty.
 *
 * ## The one thing this door has to say that the module does not
 *
 * A correlation key belongs to the TOP-LEVEL `edges` array. That array runs after every record array, so a
 * `$ref` there can name a record of any kind in the payload. An item's own `edges` are applied with the
 * item, so a reference forwards cannot resolve — and resolving only backwards would make whether a payload
 * works depend on the order somebody happened to write it in. Refused, naming the array that does resolve
 * one, rather than stored as an edge pointing at the literal string.
 */
function itemConnectionError(item: unknown, strict: boolean): string | null {
  const at = (edgeInputsFrom(item) ?? []).findIndex(e => isRefUse(e?.to));
  if (at >= 0) {
    return `edges[${at}].to is a \`$ref\`, and an item's own \`edges\` do not resolve one — they name records `
      + 'that already exist. Use the top-level `edges` array for a relationship to a record this same call '
      + 'creates: it runs after every record array, so a reference there can point at any of them.';
  }
  return connectionInputError(item, { strict });
}

/**
 * Process a batch of facts/entities/edges/chrono for one space. Deterministic order
 * (facts → entities → chrono → EDGES LAST), which matters only for records the batch UPDATES: an entity
 * addressed by an existing id is written before an edge below reads it. Per-item failures are collected,
 * never fatal. Returns counts + errors.
 *
 * **The order does not buy a forward reference, and four surfaces said it did until 2026-09-01.** `upsertEntity`
 * mints the identity on insert — a supplied id addresses an existing record and never becomes a new one's — so
 * an id a caller invents for an entity in this payload is not the id that entity gets, and an edge naming it
 * points at nothing. Combined with shape-not-existence below, that edge is stored dangling and counted as
 * inserted. Callers build a graph in two passes, taking ids from the first response.
 */
export async function bulkWrite(spaceId: string, input: BulkInput): Promise<BulkResult> {
  const metaRaw = getConfig().spaces.find(s => s.id === spaceId)?.meta;
  const meta = metaRaw ? resolveMetaRefs(metaRaw) : undefined;
  const mode = meta?.validationMode ?? 'off';
  const strict = isStrictLinkage(spaceId);
  /*
   * `F-27` item 2, owner's ruling 2026-09-07: on this door a REFERENCE is existence-checked too, under
   * the same `strictLinkage` setting the single-record doors read.
   *
   * This door was deliberately laxer than the single-record ones — references were checked for shape and
   * never for existence, which is a defensible trade for a bulk import where records legitimately arrive
   * in an order nobody controls.
   *
   * It stopped being defensible once the correlation key made this the normal way to write a linked
   * record. The operator said so plainly: their correspondence, deploy log and ticket updates would all
   * move onto the door with the weaker guarantee, *"and a dangling `answers` edge is exactly the failure
   * we would never notice — it reads as an unanswered post forever."*
   *
   * It was scoped to CONVERTED spaces while a space could still be unconverted and keep the import trade.
   * 5.0 leaves one shape — an unconverted space is refused rather than read — so the condition had one
   * value left and is gone with the flag it read.
   */

  /*
   * `F-27` item 2: what this call has minted, by the key its author gave it.
   *
   * One table for the whole batch, and it never reaches a document — the key exists for the length of this
   * request. See `batch-refs.ts` for why a duplicate key is refused rather than resolved.
   */
  const refs = new BatchRefs();

  const inserted: Counts = { facts: 0, entities: 0, edges: 0, chrono: 0 };
  const updated: Counts = { facts: 0, entities: 0, edges: 0, chrono: 0 };
  const errors: { type: string; index: number; reason: string }[] = [];
  /** What the ITEMS' own connection fields attached, added up across all three record loops (`Q-44`). */
  const connections = { links: 0, edges: 0 };
  const addConnections = (applied: { links: number; edges: number }): void => {
    connections.links += applied.links;
    connections.edges += applied.edges;
  };

  const schemaFails = (type: string, index: number, violations: { field: string; reason: string }[]): boolean => {
    if (mode === 'off' || !meta || violations.length === 0) return false;
    if (mode === 'strict') { errors.push({ type, index, reason: `schema_violation: ${violations.map(v => v.reason).join('; ')}` }); return true; }
    for (const v of violations) errors.push({ type, index, reason: `schema_warning: ${v.field} — ${v.reason}` });
    return false;
  };

  // ── facts ───────────────────────────────────────────────────────────────
  const facts = slice(input.facts);
  for (let i = 0; i < facts.length; i++) {
    const item = facts[i]!;
    const fact = typeof item['fact'] === 'string' ? item['fact'].trim() : '';
    if (!fact) { errors.push({ type: 'fact', index: i, reason: 'missing required field: fact' }); continue; }
    if (fact.length > MAX_FACT_LENGTH) { errors.push({ type: 'fact', index: i, reason: '`fact` must not exceed 50 000 characters' }); continue; }
    const type = typeof item['type'] === 'string' && item['type'].trim() ? item['type'] : undefined;
    const properties = optProps(item['properties']);
    const ttlDays = bulkTtlDays(item['ttlDays']);
    if (ttlDays === TTL_INVALID) { errors.push({ type: 'fact', index: i, reason: TTL_INVALID_MSG }); continue; }
    /*
     * `W-22`: THE CALLER-SUPPLIED `id`, which bulk ENTITIES read and these two ignored.
     *
     * A supplied id makes a create idempotent — a retried write converges on the same record instead of
     * producing a second one. Every single-record door reads it. These two dropped it, so a batch resent
     * after a timeout DUPLICATED every fact and chrono entry in it, silently, while the same batch of
     * entities was correctly idempotent.
     */
    const rawId = typeof item['id'] === 'string' ? item['id'].trim() : undefined;
    if (rawId !== undefined && !UUID_V4_RE.test(rawId)) { errors.push({ type: 'fact', index: i, reason: '`id` must be a valid UUID v4' }); continue; }
    // `W-14`..`W-22`: the same value rules the single-record doors read. Bulk had its own, weaker set —
    // `strArray` DROPPED a non-string element silently and `optProps` cast the bag without looking inside,
    // so a batch stored what the single create refuses and reported nothing.
    const shapeErr = shapeError('fact', item);
    if (shapeErr) { errors.push({ type: 'fact', index: i, reason: shapeErr }); continue; }
    // `Q-44`: the SHARED refusal, which this loop used to restate as a UUID pattern per link field.
    const connErr = itemConnectionError(item, strict);
    if (connErr) { errors.push({ type: 'fact', index: i, reason: connErr }); continue; }
    try {
      if (schemaFails('fact', i, validateFact(meta ?? {}, { type, properties }))) continue;
      /*
       * `Q-44`: BEFORE the write, so a connection naming nothing leaves no record behind.
       *
       * `applyConnections` runs after the insert — it has to, because a link needs both ends and the `from`
       * is what was just minted. Asserting there alone would report the refusal with the fact already
       * stored, which on a batch means a caller reconciling hundreds of rows they did not ask for.
       */
      await assertConnections(spaceId, 'fact', item);
      // No link set here: the connections come from the item's own fields, through `applyConnections`
      // below, which is the one path every other create door takes.
      const memDoc = await saveFact(spaceId, fact, [], strArray(item['tags']),
        typeof item['description'] === 'string' ? item['description'] : undefined, properties, type,
        undefined, undefined, ttlDays, rawId);
      addConnections(await applyConnections(spaceId, memDoc._id, 'fact', item, memDoc.author));
      /*
       * `F-27` item 2: record what this item's key names, if it declared one.
       *
       * After the write, because the id is minted by it. A duplicate key is reported as an item error and
       * the record still stands — the write already happened, and refusing to record the key is the honest
       * consequence rather than pretending the row is not there.
       */
      const keyMem = refKeyDeclared(item);
      if (keyMem) {
        const dupe = refs.declare(keyMem, memDoc._id, 'fact');
        if (dupe) errors.push({ type: 'fact', index: i, reason: dupe });
      }

      inserted.facts++;
    } catch (err) { errors.push({ type: 'fact', index: i, reason: err instanceof Error ? err.message : String(err) }); }
  }

  // ── entities ───────────────────────────────────────────────────────────────
  const entities = slice(input.entities);
  for (let i = 0; i < entities.length; i++) {
    const item = entities[i]!;
    const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
    if (!name) { errors.push({ type: 'entity', index: i, reason: 'missing required field: name' }); continue; }
    const type = typeof item['type'] === 'string' ? item['type'].trim() : '';
    if (!type) { errors.push({ type: 'entity', index: i, reason: 'missing required field: type' }); continue; }
    const rawId = typeof item['id'] === 'string' ? item['id'].trim() : undefined;
    if (rawId !== undefined && !UUID_V4_RE.test(rawId)) { errors.push({ type: 'entity', index: i, reason: '`id` must be a valid UUID v4' }); continue; }
    const properties = optProps(item['properties']) ?? {};
    const ttlDays = bulkTtlDays(item['ttlDays']);
    if (ttlDays === TTL_INVALID) { errors.push({ type: 'entity', index: i, reason: TTL_INVALID_MSG }); continue; }
    // `W-14`..`W-22`: the same value rules the single-record doors read. Bulk had its own, weaker set —
    // `strArray` DROPPED a non-string element silently and `optProps` cast the bag without looking inside,
    // so a batch stored what the single create refuses and reported nothing.
    const shapeErr = shapeError('entity', item);
    if (shapeErr) { errors.push({ type: 'entity', index: i, reason: shapeErr }); continue; }
    /*
     * `Q-44`: an entity holds NO link classes — it is only ever the far end of one — and it can still be
     * the start of a labelled edge. Asking the shared module here is what makes that distinction the link
     * vocabulary's rather than this loop's: `linkEntities` on an entity item is refused by the class table,
     * not by a condition somebody wrote out again.
     */
    const connErr = itemConnectionError(item, strict);
    if (connErr) { errors.push({ type: 'entity', index: i, reason: connErr }); continue; }
    try {
      // The MERGED record, not the payload — an id that matches an existing entity makes this an
      // update, and the importer had the merge target in hand two lines later for its own counter.
      const existing = rawId
        ? await col<EntityDoc>(spaceCollection(spaceId, 'entities')).findOne(asFilter<EntityDoc>({ _id: rawId, spaceId }),
          { projection: NEVER_RETURNED_PROJECTION })
        : null;
      /*
       * THE THIRD DOOR, and nobody reported it — `optProps` above casts the bag and checks no value.
       *
       * Reported for the create/patch pair only, so this is the sweep going wider than the report. It fails
       * the ITEM rather than the request, which is this endpoint's whole contract: one bad row is reported
       * and skipped, never a reason to abandon the rest of a batch.
       *
       * Entity only, matching the single-record doors — `04-brain-api.md` states that the fact, edge and
       * chrono paths deliberately do not reject non-primitives at the API layer, and changing that would
       * refuse writes that work today.
       */
      const propErr = primitivePropertyError(item['properties']);
      if (propErr) { errors.push({ type: 'entity', index: i, reason: propErr }); continue; }
      const mergedEnt = mergeTagsAndProperties(existing as EntityDoc | null, { tags: strArray(item['tags']), properties });
      if (schemaFails('entity', i, validateEntity(meta ?? {}, { name, type, properties: mergedEnt.properties }))) continue;
      await assertConnections(spaceId, 'entity', item);
      const result = await upsertEntity(spaceId, name, type, strArray(item['tags']), properties,
        typeof item['description'] === 'string' ? item['description'] : undefined, rawId, undefined, undefined, ttlDays);
      addConnections(await applyConnections(spaceId, result.entity._id, 'entity', item, result.entity.author));
      /*
       * `F-27` item 2: record what this item's key names, if it declared one.
       *
       * After the write, because the id is minted by it. A duplicate key is reported as an item error and
       * the record still stands — the write already happened, and refusing to record the key is the honest
       * consequence rather than pretending the row is not there.
       */
      const keyEnt = refKeyDeclared(item);
      if (keyEnt) {
        const dupe = refs.declare(keyEnt, result.entity._id, 'entity');
        if (dupe) errors.push({ type: 'entity', index: i, reason: dupe });
      }
      if (existing) updated.entities++; else inserted.entities++;
      if (result.warning) errors.push({ type: 'entity', index: i, reason: result.warning });
    } catch (err) { errors.push({ type: 'entity', index: i, reason: err instanceof Error ? err.message : String(err) }); }
  }

  // ── chrono ─────────────────────────────────────────────────────────────────
  const allowedChronoTypes = getAllowedChronoTypes(meta);
  const chrono = slice(input.chrono);
  for (let i = 0; i < chrono.length; i++) {
    const item = chrono[i]!;
    const title = typeof item['title'] === 'string' ? item['title'].trim() : '';
    const type = typeof item['type'] === 'string' ? item['type'] : '';
    const startsAt = typeof item['startsAt'] === 'string' ? item['startsAt'] : '';
    if (!title) { errors.push({ type: 'chrono', index: i, reason: 'missing required field: title' }); continue; }
    if (!allowedChronoTypes.has(type)) { errors.push({ type: 'chrono', index: i, reason: `\`type\` must be one of: ${[...allowedChronoTypes].join(', ')}` }); continue; }
    if (!startsAt) { errors.push({ type: 'chrono', index: i, reason: 'missing required field: startsAt' }); continue; }
    /*
     * `W-22`: THE CALLER-SUPPLIED `id`, which bulk ENTITIES read and these two ignored.
     *
     * A supplied id makes a create idempotent — a retried write converges on the same record instead of
     * producing a second one. Every single-record door reads it. These two dropped it, so a batch resent
     * after a timeout DUPLICATED every fact and chrono entry in it, silently, while the same batch of
     * entities was correctly idempotent.
     */
    const rawId = typeof item['id'] === 'string' ? item['id'].trim() : undefined;
    if (rawId !== undefined && !UUID_V4_RE.test(rawId)) { errors.push({ type: 'chrono', index: i, reason: '`id` must be a valid UUID v4' }); continue; }
    /*
     * `W-22`: THE RECURRENCE RULE, which this loop never read at all.
     *
     * `mcp/tools/bulk.ts` says a bulk chrono item takes the *"same fields as the `save_chrono` tool"*,
     * twice. It did not: the token `recurrence` appeared nowhere in this file, so a recurring event
     * created in a batch was accepted, counted as inserted, and had no recurrence — with nothing said.
     *
     * Through `parseRecurrence`, the same validator both single-record doors use, so a malformed rule is
     * reported here rather than stored.
     */
    const rec = parseRecurrence(item['recurrence']);
    if (!rec.ok) { errors.push({ type: 'chrono', index: i, reason: rec.error }); continue; }
    // `W-14`..`W-22`: the same value rules the single-record doors read. Bulk had its own, weaker set —
    // `strArray` DROPPED a non-string element silently and `optProps` cast the bag without looking inside,
    // so a batch stored what the single create refuses and reported nothing.
    const shapeErr = shapeError('chrono', item);
    if (shapeErr) { errors.push({ type: 'chrono', index: i, reason: shapeErr }); continue; }
    // `Q-44`: the SHARED refusal, which this loop used to restate as a UUID pattern per link field.
    const connErr = itemConnectionError(item, strict);
    if (connErr) { errors.push({ type: 'chrono', index: i, reason: connErr }); continue; }
    const properties = optProps(item['properties']);
    // Normalise status to a known value (drop unknowns) — REST did this; MCP did not.
    const status = typeof item['status'] === 'string' && CHRONO_STATUS_SET.has(item['status'] as ChronoStatus)
      ? item['status'] as ChronoStatus : undefined;
    const ttlDays = bulkTtlDays(item['ttlDays']);
    if (ttlDays === TTL_INVALID) { errors.push({ type: 'chrono', index: i, reason: TTL_INVALID_MSG }); continue; }
    try {
      if (schemaFails('chrono', i, validateChrono(meta ?? {}, { type, properties }))) continue;
      await assertConnections(spaceId, 'chrono', item);
      // No link set here: the connections come from the item's own fields, through `applyConnections`.
      const chronoDoc = await createChrono(spaceId, {
        title, type: type as ChronoType, startsAt,
        endsAt: typeof item['endsAt'] === 'string' ? item['endsAt'] : undefined,
        status, confidence: typeof item['confidence'] === 'number' ? item['confidence'] : undefined,
        description: typeof item['description'] === 'string' ? item['description'] : undefined,
        tags: optStrArray(item['tags']), properties,
        recurrence: rec.value, id: rawId,
      }, undefined, ttlDays);
      addConnections(await applyConnections(spaceId, chronoDoc._id, 'chrono', item, chronoDoc.author));
      /*
       * `F-27` item 2: record what this item's key names, if it declared one. After the write, because the
       * id is minted by it.
       */
      const keyChrono = refKeyDeclared(item);
      if (keyChrono) {
        const dupe = refs.declare(keyChrono, chronoDoc._id, 'chrono');
        if (dupe) errors.push({ type: 'chrono', index: i, reason: dupe });
      }
      inserted.chrono++;
    } catch (err) { errors.push({ type: 'chrono', index: i, reason: err instanceof Error ? err.message : String(err) }); }
  }

  /*
   * EDGES RUN LAST, since `F-27` item 2.
   *
   * They used to run before chrono, and the order was documented as mattering only for records the batch
   * UPDATES. A correlation key changes that: an edge may name a record this call created, and a reference
   * cannot point forwards — so an edge to a chrono entry in the same payload could never have resolved.
   *
   * Every record array is written before any edge is, which makes 'declare it earlier in the call' true for
   * every kind rather than for the two that happened to come first.
   */
  // ── edges ──────────────────────────────────────────────────────────────────
  const edges = slice(input.edges);
  for (let i = 0; i < edges.length; i++) {
    const item = edges[i]!;
    const rawFrom = typeof item['from'] === 'string' ? item['from'].trim() : '';
    const rawTo = typeof item['to'] === 'string' ? item['to'].trim() : '';
    const label = typeof item['label'] === 'string' ? item['label'].trim() : '';
    /*
     * The endpoint kinds, and they have to be read HERE rather than left to `upsertEdge`, because the shape
     * check two lines down is this door's own copy: a `file` endpoint is a path, so a bulk import of
     * file-ended edges would be refused item by item against a UUID pattern while the same edges go through
     * one at a time on the other two doors.
     *
     * An unknown kind is an item error rather than a throw — bulk's contract is per-item, so it says which
     * index is wrong and carries on with the rest.
     */
    const rawFromKind = item['fromKind'];
    const rawToKind = item['toKind'];
    const badKind = ([['fromKind', rawFromKind], ['toKind', rawToKind]] as const)
      .find(([, v]) => v !== undefined && (typeof v !== 'string' || !(REF_KINDS as readonly string[]).includes(v)));
    if (badKind) { errors.push({ type: 'edge', index: i, reason: `\`${badKind[0]}\` must be one of: ${REF_KINDS.join(', ')}` }); continue; }
    /*
     * `F-27` item 2: an end may name a record this call created, as `$ref:key`.
     *
     * Resolved BEFORE the well-formedness checks below, because a reference is not a UUID and would be
     * refused by them — and resolved with the STATED kind so a disagreement is caught here rather than
     * stored. Where a `$ref` resolves, the kind comes from the array it was declared in: `fromKind` on an
     * item whose `from` is a reference is a claim to check, not an input to use.
     */
    const fromRef = resolveRef(rawFrom, refs, rawFromKind as RefKind | undefined);
    const toRef = resolveRef(rawTo, refs, rawToKind as RefKind | undefined);
    if (fromRef.error) { errors.push({ type: 'edge', index: i, reason: `from: ${fromRef.error}` }); continue; }
    if (toRef.error) { errors.push({ type: 'edge', index: i, reason: `to: ${toRef.error}` }); continue; }
    const from = fromRef.id ?? '';
    const to = toRef.id ?? '';

    const fromKind = fromRef.kind ?? edgeEndpointKind(rawFromKind as RefKind | undefined);
    const toKind = toRef.kind ?? edgeEndpointKind(rawToKind as RefKind | undefined);
    if (!from) { errors.push({ type: 'edge', index: i, reason: 'missing required field: from' }); continue; }
    if (strict && !isWellFormedRef(fromKind, from)) { errors.push({ type: 'edge', index: i, reason: `\`from\` must be a valid ${fromKind} reference, not a name` }); continue; }
    if (!to) { errors.push({ type: 'edge', index: i, reason: 'missing required field: to' }); continue; }
    if (strict && !isWellFormedRef(toKind, to)) { errors.push({ type: 'edge', index: i, reason: `\`to\` must be a valid ${toKind} reference, not a name` }); continue; }
    /*
     * `F-27` item 2: both ends must EXIST.
     *
     * A `$ref` that resolved is existent by construction — it names a record this call just wrote — so this
     * costs nothing for the case the feature is for. What it catches is the literal id: a well-formed UUID
     * pointing at nothing, which this door has always stored and which becomes unacceptable once the batch
     * is how linked records are written.
     */
    /*
     * UNDER `strictLinkage`, which is the same condition the single-record doors use.
     *
     * It was scoped to a CONVERTED space while an unconverted one could keep the looser import trade, and
     * 5.0 left that condition one value. Making it unconditional would have been the other half of the
     * same defect: `strictLinkage: false` exists for staged imports where targets resolve in a later pass,
     * and this door is where those imports arrive.
     */
    if (strict) {
      const missing = await firstMissingEnd(spaceId, [[from, fromKind, 'from'], [to, toKind, 'to']]);
      if (missing) { errors.push({ type: 'edge', index: i, reason: missing }); continue; }
    }
    if (!label) { errors.push({ type: 'edge', index: i, reason: 'missing required field: label' }); continue; }
    const properties = optProps(item['properties']);
    const ttlDays = bulkTtlDays(item['ttlDays']);
    if (ttlDays === TTL_INVALID) { errors.push({ type: 'edge', index: i, reason: TTL_INVALID_MSG }); continue; }
    // `W-14`..`W-22`: the same value rules the single-record doors read. Bulk had its own, weaker set —
    // `strArray` DROPPED a non-string element silently and `optProps` cast the bag without looking inside,
    // so a batch stored what the single create refuses and reported nothing.
    const shapeErr = shapeError('edge', item);
    if (shapeErr) { errors.push({ type: 'edge', index: i, reason: shapeErr }); continue; }
    try {
      /*
       * `upsertEdge` validates too, since 2026-08-29 — this check is kept for REPORTING, not for enforcement.
       *
       * Bulk's contract is per-item: it must say which index failed and carry on with the rest. Letting the
       * throw from `upsertEdge` do the work would report the same refusal with less structure, and the catch
       * below would flatten it to a message. So this stays as the reporting path while the write function is
       * the guarantee — the distinction matters, because the enforcement is no longer THIS line's job.
       */
      const existing = await findEdgeByTriplet(spaceId, from, to, label, fromKind, toKind);
      /*
       * The endpoint facts, resolved for the REPORT as well as the write.
       *
       * `upsertEdge` resolves and enforces on its own; if this line handed the validator nothing, an endpoint
       * refusal would still happen — as a throw, flattened by the catch below into a message naming the field.
       * The item's reason would stop saying which types are allowed, which on a per-item contract is the whole
       * value of the report. One rule, and this is the copy that would have carried less.
       *
       * An endpoint that does not resolve is left ABSENT rather than reported, which is what keeps bulk's own
       * contract intact: references here are checked for shape and never for existence, so a well-formed id
       * pointing at nothing is stored on purpose. An unresolved end cannot break an endpoint rule.
       */
      const resolvedEnds = await resolveEdgeEndsForWrite(spaceId, from, to, label, { fromKind, toKind });
      if (schemaFails('edge', i, validateEdge(meta ?? {},
        { label, properties: mergePropertiesOrKeep(existing?.properties, properties) ?? {} }, resolvedEnds))) continue;
      await upsertEdge(spaceId, from, to, label,
        typeof item['weight'] === 'number' ? item['weight'] : undefined,
        typeof item['type'] === 'string' ? item['type'] : undefined,
        typeof item['description'] === 'string' ? item['description'] : undefined,
        properties, optStrArray(item['tags']), undefined, ttlDays,
        {
          ...(rawFromKind !== undefined ? { fromKind } : {}),
          ...(rawToKind !== undefined ? { toKind } : {}),
        });
      if (existing) updated.edges++; else inserted.edges++;
    } catch (err) { errors.push({ type: 'edge', index: i, reason: err instanceof Error ? err.message : String(err) }); }
  }

  return { inserted, updated, connections, errors };
}

/**
 * Total records actually written (used to decide whether to fire the bulk.write webhook).
 *
 * The items' own connections count (`Q-44`). A link and an edge ARE records — a batch that attached fifty
 * relationships to records it updated wrote fifty rows, and a webhook that stayed silent about it would be
 * reporting "nothing happened" to the workflow watching for exactly that.
 */
export function bulkWriteTotal(r: BulkResult): number {
  return r.inserted.facts + r.inserted.entities + r.inserted.edges + r.inserted.chrono
    + r.updated.entities + r.updated.edges
    + r.connections.links + r.connections.edges;
}

/**
 * The first edge end that does not resolve, phrased for the caller, or `null`.
 *
 * `assertRefsResolve` is the one implementation of "does this reference exist", and this wraps it rather
 * than re-querying: bulk's contract is per-item, so a throw has to become a reason string naming which end
 * was wrong. Re-implementing the lookup here would be the second copy of a rule whose whole point is that
 * every door answers it the same way.
 */
async function firstMissingEnd(
  spaceId: string,
  ends: ReadonlyArray<readonly [string, RefKind, string]>,
): Promise<string | null> {
  for (const [value, kind, field] of ends) {
    try {
      await assertRefsResolve(spaceId, field, kind, [value]);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return null;
}
