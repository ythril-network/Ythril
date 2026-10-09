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

import { primitivePropertyError } from './property-values.js';
import { shapeError } from './write-shape.js';
import { parseRecurrence } from './chrono.js';
import { getConfig } from '../config/loader.js';
import { resolveMetaRefs, getAllowedChronoTypes } from '../spaces/schema-validation.js';
import type { SpaceMeta } from '../config/types.js';
import { isStrictLinkage } from '../spaces/proxy.js';
import { BatchRefs, resolveRef, refKeyDeclared, refKeyUsed, isRefUse, type ResolvedRef } from './batch-refs.js';
import { connectionInputError, connectionsOf, connectionSubject, mintedSubject, refuseEachEdge, edgeInputsFrom } from './write-connections.js';
import { CHRONO_STATUSES } from '../config/types.js';
import { parseRecordFlags, type RecordFlags } from './record-flag.js';
import type { ChronoType, ChronoStatus } from '../config/types.js';
import { SchemaViolationError, EdgeSchemaViolation, type UpdateValidation } from './write-validation.js';
import { writtenRecord, type WrittenRecord } from './connections-not-written.js';
import type { DesiredLinks } from './links.js';
import { ReadSet, mergeWants, tripletKey, type ReadWant, type Triplet } from './write-plan/read-set.js';
import { commitPlans } from './write-plan/commit.js';
import { planAndCommit } from './write-plan/plan-and-commit.js';
import type { CommitOutcome, WritePlan } from './write-plan/types.js';
import { linkTargets, refuseLinks } from './write-plan/plan-links.js';
import { planFact, factWant, type FactInput } from './write-plan/plan-fact.js';
import { planEntity, entityWant, type EntityInput } from './write-plan/plan-entity.js';
import { planChrono, chronoWant, type ChronoInput } from './write-plan/plan-chrono.js';
import { planEdge, edgeWant, edgeRefusal, type EdgeInput, type EdgeSubject } from './write-plan/plan-edge.js';

/** Max items processed per collection in a single bulk call. */
export const BULK_MAX_PER_TYPE = 500;

import { UUID_V4_RE, edgeEndpointKind, isWellFormedRef } from './entity-refs.js';
import { REF_KINDS, isRefKind } from '../config/types-knowledge.js';
import type { RefKind } from '../config/types-knowledge.js';
import { MAX_FACT_LENGTH } from '../util/request-bounds.js';
import { retiredWriteFieldError } from './retired-write-fields.js';
import { unknownBodyFields } from './query.js';
// DERIVED. These five were written out here, in `brain/bulk.ts`, and in the shared write-shape table —
// three copies of one product fact, and the third had two of them wrong.
const CHRONO_STATUS_SET = new Set<ChronoStatus>(CHRONO_STATUSES);

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

/**
 * One item's error row.
 *
 * `written` is on a row for an item whose RECORD was stored and whose inline edge was not (`Q-170`): it names the record
 * and the ids of the edges that did land, so the caller sends the rest as an update to that id rather than sending the
 * item again — the row alone reads "failed", and a failed item is the one a caller retries. Absent on every other row.
 */
export interface BulkError { type: string; index: number; reason: string; written?: WrittenRecord }

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
  errors: BulkError[];
  /**
   * The id each `$ref` key was given, keyed by the key: `{ "e1": { id, kind } }`. A refused item's key is
   * absent. It is how a caller learns the ids a batch minted without reading them back by text.
   */
  refs: Record<string, ResolvedRef>;
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
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/**
 * Why this body names something `bulkWrite` does not read, or `null` — the ONE check both doors run (`Q-41`,
 * `Q-195`).
 *
 * A key `BulkInput` does not declare was never read by anything downstream, so `{"memories":[…]}` answered
 * success with nothing written — the same answer a body that legitimately wrote nothing gives. The REST door
 * refused it; the MCP tool, which skips schema validation so it can report per-item errors, did not, and the
 * same payload was a clean success there. One function, so the two cannot drift again.
 *
 * The retired name is checked FIRST so `memories` is answered with `facts` rather than with the generic
 * "unknown field" sentence — the one a caller migrating from 4.x needs. ITEMS are checked too: an item
 * carrying `entityIds` was written without its connections, and a batch is where that costs most.
 *
 * @param allowed the top-level keys this door accepts — `BULK_BODY_KEYS` plus the door's own addressing
 *   (`space`, `targetSpace` on MCP).
 */
export function bulkBodyRefusal(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): { error: string; unrecognized_keys?: string[] } | null {
  const retired = retiredWriteFieldError(body);
  if (retired) return { error: retired };
  const unknown = unknownBodyFields(body, allowed);
  if (unknown) return unknown;
  for (const key of BULK_BODY_KEYS) {
    const items = body[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const itemRetired = retiredWriteFieldError(item);
      if (itemRetired) return { error: itemRetired };
    }
  }
  return null;
}

/**
 * Why this batch is refused for its size, or `null` (`Q-109`).
 *
 * Every array past `BULK_MAX_PER_TYPE` used to be SLICED here: the items past 500 were dropped and the answer was the
 * same 207 as a clean batch, listing no error for them — a caller writing 600 facts was told 500 were written and
 * nothing about the rest. A batch is refused whole instead, naming the array and its size, before anything is
 * written, so there is no half-applied batch to reconcile. Called by the REST door for a 400 and by `bulkWrite`
 * itself, which throws, so no caller can reach the old silent cut.
 */
export function bulkSizeRefusal(input: Record<string, unknown>): string | null {
  for (const key of BULK_BODY_KEYS) {
    const v = input[key];
    if (Array.isArray(v) && v.length > BULK_MAX_PER_TYPE) {
      return `\`${key}\` holds ${v.length} items; a bulk write takes at most ${BULK_MAX_PER_TYPE} per array — split it into batches`;
    }
  }
  return null;
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
 * Process a batch of facts/entities/edges/chrono for one space, in the order facts → entities → chrono →
 * EDGES LAST, so a `$ref` in the top-level `edges` array can name a record of any kind the payload creates.
 *
 * ## One read, one write per kind (`Q-99` part 3)
 *
 * Every item is checked for shape first, then the whole batch's reads happen at once (`ReadSet.load`: one `$in`
 * per kind, one `$or` of triplets, one read per functional label and per name), every item is PLANNED by the
 * same planner its single-record door uses, and the plans are written by one commit — a seq block and a
 * `bulkWrite` per kind. A batch of 500 is a handful of round trips, not a few per item, and it cannot mean
 * anything different from the same items written one at a time: the rules are the planners', and the read set
 * shows each item the batch's earlier items as written.
 *
 * The one place the batch cannot just look ahead is an item that addresses something an EARLIER item of the
 * same batch also writes — the same id twice, the same triplet twice. The plans so far are committed first
 * and that record read again, so the second write converges on what the first wrote, exactly as two calls
 * would. It costs a round trip only when a batch actually repeats itself.
 *
 * ## What it answers
 *
 * Per-item failures are collected, never fatal. `inserted` counts NEW records and `updated` the ones a write
 * converged on — including a fact or chrono entry addressed by its `id`, which used to count as inserted.
 * A key whose item was not written is absent from `refs`, and anything depending on it says why.
 *
 * An item's own inline `edges` are refused WITH the item (`edgeRefusal`, the one function the single-record doors ask
 * before they write): a refused entry — the schema, or under `strictLinkage` a far end of any kind that names nothing —
 * refuses the item before its record is planned, and the reason names the entry. A failure AFTER the record committed
 * is the one that leaves it stored, and its row carries `written` (`BulkError`), because a failed item is the one a
 * caller sends again.
 */
export async function bulkWrite(spaceId: string, input: BulkInput): Promise<BulkResult> {
  const tooLarge = bulkSizeRefusal(input as unknown as Record<string, unknown>);
  if (tooLarge) throw new Error(tooLarge);
  const metaRaw = getConfig().spaces.find(s => s.id === spaceId)?.meta;
  const meta = metaRaw ? resolveMetaRefs(metaRaw) : undefined;
  const strict = isStrictLinkage(spaceId);
  // One table for the whole batch, never stored — see `batch-refs.ts`.
  const refs = new BatchRefs();

  const inserted: Counts = { facts: 0, entities: 0, edges: 0, chrono: 0 };
  const updated: Counts = { facts: 0, entities: 0, edges: 0, chrono: 0 };
  const errors: BulkError[] = [];
  const connections = { links: 0, edges: 0 };

  /** A refused item: its error, and — if it declared a key — the reason a dependant will be told. */
  const reject = (type: string, index: number, item: unknown, reason: string): void => {
    errors.push({ type, index, reason });
    const key = refKeyDeclared(item);
    if (key) refs.fail(key, reason);
  };

  /*
   * A `warn` space reports what a `strict` one would refuse. The planner's classification says which
   * violations to surface (`warnings` is empty when validation is off), so the batch reads it rather than
   * running the validators a second time for its report.
   */
  const warn = (type: string, index: number) => (check: UpdateValidation): void => {
    if (check.blocked) return;
    for (const v of check.warnings) errors.push({ type, index, reason: `schema_warning: ${v.field} — ${v.reason}` });
  };

  const prepared = prepareItems(spaceId, input, meta, strict, reject, warn);
  const view = new ReadSet(spaceId);
  await view.load(mergeWants([...prepared.map(p => p.want), ...slice(input.edges).map(e => topLevelEdgeWant(spaceId, e))]));

  const run = batchRun(spaceId, view, refs, reject, warn, { inserted, updated, connections, errors });
  for (const p of prepared) await run.planRecord(p);
  for (const [i, item] of slice(input.edges).entries()) await run.planTopLevelEdge(i, item, strict);
  await run.flush();
  await run.replanStale();
  run.nameWhatLanded();

  return { inserted, updated, connections, errors, refs: refs.toJSON() };
}

/**
 * Total records actually written (used to decide whether to fire the bulk.write webhook).
 *
 * Converges count — a batch of retries that converged on their records wrote them — and so do the items' own
 * connections (`Q-44`): a link and an edge ARE records, and a webhook silent about fifty attachments would
 * report "nothing happened" to the workflow watching for exactly that.
 */
export function bulkWriteTotal(r: BulkResult): number {
  return r.inserted.facts + r.inserted.entities + r.inserted.edges + r.inserted.chrono
    + r.updated.facts + r.updated.entities + r.updated.edges + r.updated.chrono
    + r.connections.links + r.connections.edges;
}

/** The array name each record kind is reported under — the type a batch error carries. */
const REPORTED: Record<'fact' | 'entity' | 'chrono', { type: string; counted: keyof Counts }> = {
  fact: { type: 'fact', counted: 'facts' },
  entity: { type: 'entity', counted: 'entities' },
  chrono: { type: 'chrono', counted: 'chrono' },
};

/** One record item, checked for shape and ready for its planner. */
interface PreparedRecord {
  kind: 'fact' | 'entity' | 'chrono';
  index: number;
  item: Record<string, unknown>;
  /** What the item's own `link*` fields ask for, or null when it names none. */
  desired: DesiredLinks | null;
  plan: (view: ReadSet) => Promise<{ plan: WritePlan; warning?: string }>;
  /** The record this item addresses, when it names one by id — what a repeat is detected by. */
  addresses?: string;
  want: ReadWant;
}

type Reject = (type: string, index: number, item: unknown, reason: string) => void;
type Warn = (type: string, index: number) => (check: UpdateValidation) => void;

/**
 * Check every record item's shape, in order, and say what its planner will ask the read set. A refusal here is
 * reported and the item skipped — the same per-item value rules the single-record doors read (`W-14`..`W-22`).
 */
function prepareItems(
  spaceId: string, input: BulkInput, meta: SpaceMeta | undefined, strict: boolean, reject: Reject, warn: Warn,
): PreparedRecord[] {
  const out: PreparedRecord[] = [];
  const common = (kind: 'fact' | 'entity' | 'chrono', item: Record<string, unknown>, i: number): {
    ok: true; ttlDays: number | null | undefined; rawId: string | undefined; flags: RecordFlags; desired: DesiredLinks | null;
  } | { ok: false } => {
    const type = REPORTED[kind].type;
    const ttlDays = bulkTtlDays(item['ttlDays']);
    if (ttlDays === TTL_INVALID) { reject(type, i, item, TTL_INVALID_MSG); return { ok: false }; }
    // `W-22`: the caller-supplied id makes a retried write converge instead of duplicating.
    const rawId = typeof item['id'] === 'string' ? item['id'].trim() : undefined;
    if (rawId !== undefined && !UUID_V4_RE.test(rawId)) { reject(type, i, item, '`id` must be a valid UUID v4'); return { ok: false }; }
    const shapeErr = shapeError(kind, item);
    if (shapeErr) { reject(type, i, item, shapeErr); return { ok: false }; }
    const flags = parseRecordFlags(item);
    if (!flags.ok) { reject(type, i, item, flags.error); return { ok: false }; }
    // `Q-44`: the SHARED refusal for the item's own connections.
    const connErr = itemConnectionError(item, strict);
    if (connErr) { reject(type, i, item, connErr); return { ok: false }; }
    return { ok: true, ttlDays, rawId, flags: flags.flags, desired: connectionsOf(item, rawId ?? '', kind).desired };
  };

  for (const [i, item] of slice(input.facts).entries()) {
    const fact = typeof item['fact'] === 'string' ? item['fact'].trim() : '';
    if (!fact) { reject('fact', i, item, 'missing required field: fact'); continue; }
    if (fact.length > MAX_FACT_LENGTH) { reject('fact', i, item, '`fact` must not exceed 50 000 characters'); continue; }
    const c = common('fact', item, i);
    if (!c.ok) continue;
    const factInput: FactInput = {
      fact, linkEntities: [...(c.desired?.entity ?? [])], tags: strArray(item['tags']),
      description: typeof item['description'] === 'string' ? item['description'] : undefined,
      properties: optProps(item['properties']),
      type: typeof item['type'] === 'string' && item['type'].trim() ? item['type'] : undefined,
      opts: { ...c.flags, onValidation: warn('fact', i) }, ttlDays: c.ttlDays, id: c.rawId,
    };
    out.push({
      kind: 'fact', index: i, item, desired: c.desired, addresses: c.rawId,
      plan: view => planFact(spaceId, factInput, view), want: factWant(factInput),
    });
  }

  for (const [i, item] of slice(input.entities).entries()) {
    const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
    if (!name) { reject('entity', i, item, 'missing required field: name'); continue; }
    const type = typeof item['type'] === 'string' ? item['type'].trim() : '';
    if (!type) { reject('entity', i, item, 'missing required field: type'); continue; }
    const c = common('entity', item, i);
    if (!c.ok) continue;
    // Entity only, matching the single-record doors: the fact, edge and chrono paths do not reject
    // non-primitives at the API layer (`04-brain-api.md`).
    const propErr = primitivePropertyError(item['properties']);
    if (propErr) { reject('entity', i, item, propErr); continue; }
    const entityInput: EntityInput = {
      name, type, tags: strArray(item['tags']), properties: optProps(item['properties']) ?? {},
      description: typeof item['description'] === 'string' ? item['description'] : undefined,
      id: c.rawId, opts: c.flags, ttlDays: c.ttlDays, onValidation: warn('entity', i),
    };
    out.push({
      kind: 'entity', index: i, item, desired: c.desired, addresses: c.rawId,
      plan: view => planEntity(spaceId, entityInput, view), want: entityWant(entityInput),
    });
  }

  const allowedChronoTypes = getAllowedChronoTypes(meta);
  for (const [i, item] of slice(input.chrono).entries()) {
    const title = typeof item['title'] === 'string' ? item['title'].trim() : '';
    const type = typeof item['type'] === 'string' ? item['type'] : '';
    const startsAt = typeof item['startsAt'] === 'string' ? item['startsAt'] : '';
    if (!title) { reject('chrono', i, item, 'missing required field: title'); continue; }
    if (!allowedChronoTypes.has(type)) { reject('chrono', i, item, `\`type\` must be one of: ${[...allowedChronoTypes].join(', ')}`); continue; }
    if (!startsAt) { reject('chrono', i, item, 'missing required field: startsAt'); continue; }
    // `W-22`: the recurrence rule, through the validator both single-record doors use.
    const rec = parseRecurrence(item['recurrence']);
    if (!rec.ok) { reject('chrono', i, item, rec.error); continue; }
    const c = common('chrono', item, i);
    if (!c.ok) continue;
    // Normalise status to a known value (drop unknowns) — REST did this; MCP did not.
    const status = typeof item['status'] === 'string' && CHRONO_STATUS_SET.has(item['status'] as ChronoStatus)
      ? item['status'] as ChronoStatus : undefined;
    const chronoInput: ChronoInput = {
      fields: {
        title, type: type as ChronoType, startsAt,
        endsAt: typeof item['endsAt'] === 'string' ? item['endsAt'] : undefined,
        status, confidence: typeof item['confidence'] === 'number' ? item['confidence'] : undefined,
        description: typeof item['description'] === 'string' ? item['description'] : undefined,
        tags: optStrArray(item['tags']), properties: optProps(item['properties']),
        recurrence: rec.value, id: c.rawId,
        linkEntities: [...(c.desired?.entity ?? [])], linkFacts: [...(c.desired?.fact ?? [])],
      },
      ttlDays: c.ttlDays, opts: { ...c.flags, onValidation: warn('chrono', i) },
    };
    out.push({
      kind: 'chrono', index: i, item, desired: c.desired, addresses: c.rawId,
      plan: view => planChrono(spaceId, chronoInput, view), want: chronoWant(chronoInput),
    });
  }

  // What the items' OWN connections will ask: the link targets for the class check, and each inline edge's
  // far end and (for a record addressed by id) its triplet. An edge from a record this batch mints needs no
  // read — nothing stored can name it — so its subject says so (`minted`), and only the far end is read.
  for (const p of out) {
    const extra: ReadWant[] = [];
    if (p.desired) extra.push({ records: linkTargets(p.desired) });
    const subject: EdgeSubject | undefined = p.addresses ? undefined : mintedSubject('', null);
    for (const e of connectionsOf(p.item, p.addresses ?? '', p.kind).edges) extra.push(edgeWant(spaceId, e, subject));
    if (extra.length > 0) p.want = mergeWants([p.want, ...extra]);
  }
  return out;
}

/**
 * What a top-level edge will ask the read set, as far as can be known before the records are planned: its ends'
 * records (existence, an entity's type) and — when neither end is a `$ref` — its triplet and functional subject.
 * An end that is a `$ref` names a record this batch writes, which the read set learns as it is planned.
 */
function topLevelEdgeWant(spaceId: string, item: Record<string, unknown>): ReadWant {
  const end = (raw: unknown, rawKind: unknown): { id: string; kind: RefKind } | null => {
    if (typeof raw !== 'string' || !raw.trim() || refKeyUsed(raw) !== undefined) return null;
    if (rawKind !== undefined && !isRefKind(rawKind)) return null;
    return { id: raw.trim(), kind: edgeEndpointKind(rawKind as RefKind | undefined) };
  };
  const from = end(item['from'], item['fromKind']);
  const to = end(item['to'], item['toKind']);
  const label = typeof item['label'] === 'string' ? item['label'].trim() : '';
  const records: NonNullable<ReadWant['records']> = {};
  for (const e of [from, to]) if (e) records[e.kind] = [...(records[e.kind] ?? []), e.id];
  if (!from || !to || !label) return { records };
  return mergeWants([{ records }, edgeWant(spaceId, { from: from.id, to: to.id, label, opts: { fromKind: from.kind, toKind: to.kind } })]);
}


/** A plan waiting for the commit, with what the batch reports about it. */
interface Pending {
  plan: WritePlan;
  type: string;
  index: number;
  /** null: an item's own edge — reported under `connections`, not under the arrays. */
  counted: keyof Counts | null;
  /** The plan counts as an update (a converge, or a triplet that was already stored). */
  isUpdate: boolean;
  key?: string;
  warning?: string;
  /** The pending entry this one needs written first. */
  after?: Pending;
  /** Re-plan once against a fresh read when the commit reports the record moved. */
  replan?: (view: ReadSet) => Promise<{ plan: WritePlan }>;
  want: ReadWant;
  /** Set once committed: undefined while pending. */
  result?: { ok: true } | { ok: false; reason: string };
  /**
   * Shared by an item's record and each of its own inline edges (by reference, so it survives the re-plans that copy a
   * Pending): what the edges did, for the `written` a failed one reports.
   */
  inline?: InlineEdges;
}

/** What one item's own inline edges did, gathered while the batch runs and read once it is done (`nameWhatLanded`). */
interface InlineEdges {
  kind: RefKind;
  /** The record the edges hang off. */
  id: string;
  /** Whether the record's own commit landed, once it is known. */
  recordLanded?: boolean;
  /** The ids of the edges that landed. */
  landed: string[];
  /** The error rows of the edges that did not, already in the batch's errors. */
  failed: BulkError[];
}

/** The planning and committing state of one batch — closures, so the call graph can follow them. */
function batchRun(
  spaceId: string,
  view: ReadSet,
  refs: BatchRefs,
  reject: Reject,
  warn: Warn,
  out: { inserted: Counts; updated: Counts; connections: { links: number; edges: number }; errors: BulkResult['errors'] },
) {
  let pending: Pending[] = [];
  const inlines: InlineEdges[] = [];
  const targets = new Set<string>();
  const stale: Pending[] = [];

  async function planRecord(p: PreparedRecord): Promise<void> {
    const { type, counted } = REPORTED[p.kind];
    if (p.addresses) await beforeTarget(`${p.kind}:${p.addresses}`, { records: { [p.kind]: [p.addresses] } });
    // A key used twice is refused BEFORE anything is planned: the item would otherwise stand under a name that
    // means two things, and the read set would hold a record nobody will write.
    const key = refKeyDeclared(p.item);
    if (key && refs.get(key)) {
      out.errors.push({ type, index: p.index, reason: refs.declare(key, '', p.kind)! });
      return;
    }
    await view.load(p.want);
    let entry: Pending;
    try {
      // The item's whole link set, including classes its kind cannot hold — refused here in the shared words.
      if (p.desired) await refuseLinks(view, p.kind, p.desired);
      /*
       * The item's own inline edges are refused WITH the item, before anything of it is planned or its key declared
       * (`Q-170`): the record is written first and its edges after, so an edge refused only when it came to be
       * planned left the record stored in a batch that reported the item failed. The same `edgeRefusal` the
       * single-record doors ask before they write, against the batch's read set.
       */
      const subject = await connectionSubject(spaceId, p.kind, p.item, {
        stored: p.addresses ? view.stored(p.kind, p.addresses) as { _id: string; type?: string } | null : null,
        type: typeof p.item['type'] === 'string' ? p.item['type'].trim() : undefined,
      });
      if (subject) {
        refuseEachEdge(connectionsOf(p.item, subject.id, p.kind).edges, (edge, passed) => {
          edgeRefusal(spaceId, edge, view, subject, passed);
        });
      }
      const planned = await p.plan(view);
      entry = {
        plan: planned.plan, type, index: p.index, counted, isUpdate: planned.plan.op === 'converge',
        ...(key ? { key } : {}), want: p.want, replan: p.plan,
        ...(planned.warning ? { warning: planned.warning } : {}),
      };
    } catch (err) {
      reject(type, p.index, p.item, itemReason(err));
      return;
    }
    if (key) refs.declare(key, entry.plan.id, p.kind);
    push(entry, `${p.kind}:${entry.plan.id}`);
    // The item's own edges hang off the record just planned, and are written after it — the edge writes
    // `connectionsOf` derives, the same ones `applyConnections` makes after a single-record write.
    const inlineEdges = connectionsOf(p.item, entry.plan.id, p.kind).edges;
    if (inlineEdges.length > 0) {
      entry.inline = { kind: p.kind, id: entry.plan.id, landed: [], failed: [] };
      inlines.push(entry.inline);
    }
    for (const e of inlineEdges) {
      await planEdgeItem(e, type, p.index, p.item, null, entry);
    }
  }

  async function planTopLevelEdge(i: number, item: Record<string, unknown>, strict: boolean): Promise<void> {
    const refuse = (reason: string) => reject('edge', i, item, reason);
    const rawFrom = typeof item['from'] === 'string' ? item['from'].trim() : '';
    const rawTo = typeof item['to'] === 'string' ? item['to'].trim() : '';
    const label = typeof item['label'] === 'string' ? item['label'].trim() : '';
    // An unknown kind is an item error rather than a throw — bulk's contract is per-item.
    const rawFromKind = item['fromKind'];
    const rawToKind = item['toKind'];
    const badKind = ([['fromKind', rawFromKind], ['toKind', rawToKind]] as const)
      .find(([, v]) => v !== undefined && !isRefKind(v));
    if (badKind) return refuse(`\`${badKind[0]}\` must be one of: ${REF_KINDS.join(', ')}`);
    /*
     * `F-27` item 2: an end may name a record this call created, as `$ref:key`. Where a `$ref` resolves, the
     * kind comes from the array it was declared in: `fromKind` on an item whose `from` is a reference is a
     * claim to check, not an input to use.
     */
    const fromRef = resolveRef(rawFrom, refs, rawFromKind as RefKind | undefined);
    const toRef = resolveRef(rawTo, refs, rawToKind as RefKind | undefined);
    if (fromRef.error) return refuse(`from: ${fromRef.error}`);
    if (toRef.error) return refuse(`to: ${toRef.error}`);
    const from = fromRef.id ?? '';
    const to = toRef.id ?? '';
    const fromKind = fromRef.kind ?? edgeEndpointKind(rawFromKind as RefKind | undefined);
    const toKind = toRef.kind ?? edgeEndpointKind(rawToKind as RefKind | undefined);
    if (!from) return refuse('missing required field: from');
    if (strict && !isWellFormedRef(fromKind, from)) return refuse(`\`from\` must be a valid ${fromKind} reference, not a name`);
    if (!to) return refuse('missing required field: to');
    if (strict && !isWellFormedRef(toKind, to)) return refuse(`\`to\` must be a valid ${toKind} reference, not a name`);
    if (!label) return refuse('missing required field: label');
    const ttlDays = bulkTtlDays(item['ttlDays']);
    if (ttlDays === TTL_INVALID) return refuse(TTL_INVALID_MSG);
    const shapeErr = shapeError('edge', item);
    if (shapeErr) return refuse(shapeErr);
    const edgeFlags = parseRecordFlags(item);
    if (!edgeFlags.ok) return refuse(edgeFlags.error);

    const edgeInput: EdgeInput = {
      from, to, label,
      weight: typeof item['weight'] === 'number' ? item['weight'] : undefined,
      type: typeof item['type'] === 'string' ? item['type'] : undefined,
      description: typeof item['description'] === 'string' ? item['description'] : undefined,
      properties: optProps(item['properties']), tags: optStrArray(item['tags']), ttlDays,
      // The RESOLVED kinds, always (`Q-193`): a `$ref` to a fact is stored as a fact end even when the
      // caller stated no kind. Passing them only when typed stored such an end as an entity.
      opts: { ...edgeFlags.flags, fromKind, toKind, onValidation: warn('edge', i) },
    };
    /*
     * What the edge asks of the read set, read now if the batch's one read did not (a `$ref` to a record addressed by
     * id), and then REFUSED by the one function every door asks — the schema and, under `strictLinkage`, both ends
     * existing (`F-27` item 2; a `$ref` that resolved names a record this batch writes, which the read set holds as
     * written). Before the batch commits anything for it: planning an edge whose triplet is already planned would
     * commit what is pending first (`beforeTarget`), and an edge about to be refused must not cost that.
     */
    await view.load(edgeWant(spaceId, edgeInput));
    try {
      edgeRefusal(spaceId, edgeInput, view, undefined, []);
    } catch (err) {
      return refuse(itemReason(err));
    }
    const after = pendingFor(fromRef.id && rawFrom !== from ? `${fromKind}:${from}` : undefined)
      ?? pendingFor(toRef.id && rawTo !== to ? `${toKind}:${to}` : undefined);
    await planEdgeItem(edgeInput, 'edge', i, item, 'edges', after);
  }

  async function planEdgeItem(
    edgeInput: EdgeInput, type: string, index: number, item: unknown, counted: keyof Counts | null, after?: Pending,
  ): Promise<void> {
    const want = edgeWant(spaceId, edgeInput);
    const t = want.triplets![0]!;
    // Keyed by the edge's IDENTITY, so an end stated as `entity` and one left unstated are the same target.
    const target = `edge:${tripletKey(t)}`;
    await beforeTarget(target, { triplets: [t] });
    await view.load(want);
    try {
      const planned = await planEdge(spaceId, edgeInput, view);
      push({
        plan: planned.plan, type, index, counted, isUpdate: planned.existed, want,
        replan: view => planEdge(spaceId, edgeInput, view),
        ...(after ? { after } : {}),
        ...(counted === null && after?.inline ? { inline: after.inline } : {}),
      }, target);
    } catch (err) {
      if (counted !== null) { reject(type, index, item, itemReason(err)); return; }
      // An item's own edge refused after its record was planned: the record is still written, so the row is kept to
      // say so once the record's commit is known (`nameWhatLanded`).
      const row: BulkError = { type, index, reason: itemReason(err) };
      out.errors.push(row);
      after?.inline?.failed.push(row);
    }
  }

  /** Commit everything pending and report it. */
  async function flush(): Promise<void> {
    const batch = pending;
    pending = [];
    targets.clear();
    if (batch.length === 0) return;
    const position = new Map(batch.map((e, k) => [e, k]));
    const plans = batch.map(e => {
      if (e.after?.result && !e.after.result.ok) return null;
      const dep = e.after ? position.get(e.after) : undefined;
      return dep === undefined ? e.plan : { ...e.plan, dependsOn: [dep] };
    });
    // An entry whose dependency already failed in an earlier commit is not written at all.
    const toWrite = plans.map((p, k) => ({ p, k })).filter((x): x is { p: WritePlan; k: number } => x.p !== null);
    const outcomes = await commitPlans(spaceId, toWrite.map(x => x.p));
    const byEntry = new Map<number, CommitOutcome>(toWrite.map((x, j) => [x.k, outcomes[j]!]));
    batch.forEach((e, k) => {
      const o: CommitOutcome = byEntry.get(k)
        ?? { ok: false, reason: `it depends on an item of this request that was not written: ${(e.after!.result as { reason: string }).reason}` };
      report(e, o);
    });
    // What was written is read again before an item addresses it, so a later converge plans against the truth.
    view.forget(
      Object.fromEntries(['fact', 'entity', 'chrono'].map(kind => [kind, batch.filter(e => e.plan.kind === kind).map(e => e.plan.id)])),
      batch.filter(e => e.plan.kind === 'edge').map(e => e.plan.result as unknown as Triplet),
    );
  }

  /**
   * Re-plan each write whose record another write moved while this batch was being applied. The batch's own
   * commit was the first attempt, so this is the last: losing again is the conflict a single write answers.
   */
  async function replanStale(): Promise<void> {
    for (const e of stale.splice(0)) {
      try {
        const { planned, outcome } = await planAndCommit(spaceId, e.want, e.replan!, 1);
        report({ ...e, plan: planned.plan, replan: undefined }, outcome.ok ? outcome : { ok: false, reason: outcome.reason });
      } catch (err) {
        report({ ...e, replan: undefined }, { ok: false, reason: itemReason(err) });
      }
    }
  }

  /** Commit what is pending first when an item addresses something already planned — see `bulkWrite`. */
  async function beforeTarget(target: string, reread: ReadWant): Promise<void> {
    if (!targets.has(target)) return;
    await flush();
    await view.load(reread);
  }

  function pendingFor(target: string | undefined): Pending | undefined {
    if (!target) return undefined;
    return pending.find(e => `${e.plan.kind}:${e.plan.id}` === target);
  }

  function push(entry: Pending, target: string): void {
    pending.push(entry);
    targets.add(target);
  }

  function report(e: Pending, o: CommitOutcome): void {
    if (!o.ok && o.stale && e.replan) {
      stale.push(e);
      e.result = { ok: false, reason: o.reason };
      return;
    }
    if (e.inline && e.counted !== null) e.inline.recordLanded = o.ok;
    if (!o.ok) {
      e.result = { ok: false, reason: o.reason };
      const row: BulkError = { type: e.type, index: e.index, reason: o.reason };
      out.errors.push(row);
      if (e.counted === null) e.inline?.failed.push(row);
      if (e.key) refs.fail(e.key, o.reason);
      return;
    }
    e.result = { ok: true };
    if (e.counted === null) { out.connections.edges++; e.inline?.landed.push(e.plan.id); }
    else if (e.isUpdate) out.updated[e.counted]++;
    else out.inserted[e.counted]++;
    out.connections.links += o.linksAdded ?? 0;
    if (e.warning) out.errors.push({ type: e.type, index: e.index, reason: e.warning });
  }
  /**
   * Tell every failed inline edge of an item whose RECORD landed what did land (`Q-170`). Once the batch is done, because
   * which edges landed is known only when the last of them has been committed; an item whose record did not land has
   * nothing written to name and keeps its plain row.
   */
  function nameWhatLanded(): void {
    for (const item of inlines) {
      if (!item.recordLanded) continue;
      for (const row of item.failed) row.written = writtenRecord(item.kind, item.id, item.landed);
    }
  }
  return { planRecord, planTopLevelEdge, flush, replanStale, nameWhatLanded };
}

/** A planning refusal as a per-item reason. A schema refusal keeps the `schema_violation:` form the batch always used. */
function itemReason(err: unknown): string {
  if (err instanceof SchemaViolationError) {
    // An inline edge refused with its item says which edge (`edges[1]`) — the item has several and the reasons alone do not.
    const at = err instanceof EdgeSchemaViolation && err.at ? `${err.at}: ` : '';
    return `schema_violation: ${at}${err.check.all.map(v => v.reason).join('; ')}`;
  }
  return err instanceof Error ? err.message : String(err);
}
