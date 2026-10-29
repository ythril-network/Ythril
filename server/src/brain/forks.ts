/**
 * Forks, every kind (Q-624, design rev 4 sections 7 to 10): what an unchosen version is allowed to do, how it goes with its subject, how it follows
 * a re-key, and Review's list and resolve of it, for both doors.
 *
 * ## What a fork is
 *
 * Two copies of a record that carry ONE version and DIFFERENT bodies cannot both be the record: sync keeps the second as a fork, a row of the same
 * kind under a derived id (`forkIdFor(forkOf, forkAt, body)`) whose `forkOf` names the first, its subject (D-23). Facts, entities, chrono entries and
 * edges fork (`FORKING_FAMILIES`); links and files do not.
 *
 * ## The question each export answers
 *
 *  - {@link refuseForkEdit}: "may an ordinary edit write this stored row?" A fork row changes only by resolve, delete, arrival or re-mint, so every
 *    update, relabel, save by id and merge is refused with `409 fork_row_read_only` where the stored copy is read (`writeAtReadVersion`,
 *    `ReadSet.stored()`, the update functions, `executeMerge`).
 *  - {@link removeForksOf}: "the subject goes; its unresolved versions go with it." The delete functions call it before the subject's own removal
 *    (each fork behind a tombstone issued here); the tombstone apply calls it for the ids it tombstoned (no tombstones: each instance removes its own).
 *  - {@link remintForks}: "the subject moved; its forks follow it under ids that still derive" (section 7). A fork is never edited in place: a new
 *    row is inserted under `forkIdFor(newSubject, newSeq, body')` and the old id is removed behind a tombstone, in the caller's transaction.
 *  - {@link listForks} and {@link resolveFork}: Review. A resolve settles THIS instance's copy (owner, 2026-10-25: my instance, my data): the kept
 *    body is written as a local edit of the parent above both versions, and the fork goes behind a tombstone this instance issues. A peer applies
 *    that tombstone only where its deletion authority accepts it (`sync/deletion-authority.ts`); where it declines, the peer keeps the fork, marked
 *    `_resolvedElsewhere` (`sync/resolved-elsewhere.ts`), and its own user decides it with the same resolve.
 *
 * ## What is inside so no door drops it
 *
 * - **One set of refusals.** Every resolve refusal is a {@link ForkRefusal} with one sentence; a missing parameter is the MCP validator's own sentence
 *   (`mcp/argument-sentence.ts`), so REST and MCP answer it alike.
 * - **The kept body is written FIRST**, by ONE keep-writer ({@link writeKeptBody}, called only by the resolve): a failure after it leaves the fork stored,
 *   and the retry writes the same body again.
 * - **The fork tombstone is filtered by the fork's version**, read again inside the transaction: a fork re-delivered at another version meanwhile is
 *   a 409 and is never tombstoned on the strength of the old one.
 *
 * The record modules (the delete functions, the relink, the write-at-read-version loop) import this module, so this one reaches them by a dynamic
 * import where it needs them: a static one would be an import cycle (`no-runtime-import-cycles`).
 */
import type { ClientSession } from 'mongodb';
import { z } from 'zod';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { admitSpaceWrite } from '../spaces/space-write-gate.js';
import { inHeldTransaction } from './held-transaction.js';
import { removeWithTombstones, stampTombstones } from './tombstones.js';
import { retireEmbedJobs, enqueueEmbedJob, EMBED_PRIORITY } from './embed-queue.js';
import { listReadMaxMs } from './tag-filter.js';
import { LANDING_ORDER } from './list-sort.js';
import { PROXY_PAGE_CEILING } from './query.js';
import { pageAcrossMembers } from '../spaces/page-across-members.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { NEVER_RETURNED_PROJECTION, withoutVector } from './read-projection.js';
import { linksPointingAt, linksStartingFrom } from './link-adjacency.js';
import { edgeIdFor } from './edge-id.js';
import { versionsFor } from '../util/version-stamp.js';
import { withLandingStamp, localRow } from '../sync/record-position-stream.js';
import { FORKING_FAMILIES, MAX_FORKS_PER_RECORD, MAX_FORK_DEPTH, forkIdFor, forkRowVerdict, type ForkingFamily, type ArrivalDoc } from '../sync/upsert-plan.js';
import { BODY_FIELDS_OF, authoredContentHash, bodiesDiffer } from '../sync/authored-content.js';
import { REDACTED_CHRONO_FIELDS } from './redacted-chrono-fields.js';
import { RESOLVED_ELSEWHERE, FUNCTIONAL_GUARD, rekeyedRow } from '../sync/local-only-fields.js';
import type { ResolvedElsewhereEntry } from '../sync/resolved-elsewhere.js';
import { instanceLabelOf } from '../sync/instance-label.js';
import { withEndpointNames } from './edge-endpoint-names.js';
import { getConfig } from '../config/loader.js';
import { TOMBSTONE_TYPE_OF, type TombstoneType } from '../config/types-knowledge.js';
import { MAX_SYNC_SEQ } from '../util/seq-ceiling.js';
import { edgeIdentityAdmitsForks } from '../spaces/edge-identity-index.js';
import { ForkRowReadOnly, ForkCapRefusal, EdgeIdentityBuilding } from '../util/errors.js';
import { SchemaViolationError } from './write-validation.js';
import { invalidArgumentsSentence, missingArgumentDetail } from '../mcp/argument-sentence.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import { limitRefusal, skipRefusal } from '../util/strict-limit.js';
import { log, peerText, refusalOfParse } from '../util/log.js';
import type { AuditChange } from '../audit/audit-changes.js';

export { MAX_FORKS_PER_RECORD, ForkRowReadOnly, ForkCapRefusal };

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// The kinds
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/** A kind that forks, by its record type. */
export type ForkKind = 'fact' | 'entity' | 'chrono' | 'edge';

/**
 * The field Review shows a version by, word by word: the one per-kind value that is presentation and not derivable, stated once and served to
 * the client in the list's `kinds`.
 */
const MAIN_FIELD: Readonly<Record<string, string>> = Object.freeze({ fact: 'fact', entity: 'name', chrono: 'title', edge: 'description' });

/** The word a sentence names a kind by. */
const KIND_WORD: Readonly<Record<string, string>> = Object.freeze({ fact: 'Fact', entity: 'Entity', chrono: 'Chrono entry', edge: 'Edge' });

/** One forking kind: its record type, its collection, the field Review shows it by, and the tombstone type that buries it. */
export interface ForkKindRow {
  readonly kind: ForkKind;
  readonly family: ForkingFamily;
  readonly mainField: string;
  readonly tombstoneType: TombstoneType;
}

/** Every forking kind, DERIVED from `FORKING_FAMILIES` (the planner's one list), keyed by record type. A Map: a kind is judged by membership, never by an object key. */
export const FORK_KINDS: ReadonlyMap<ForkKind, ForkKindRow> = new Map(FORKING_FAMILIES.map((family) => {
  const kind = TOMBSTONE_TYPE_OF[family] as ForkKind;
  return [kind, Object.freeze({ kind, family, mainField: MAIN_FIELD[kind]!, tombstoneType: kind as TombstoneType })] as const;
}));

/** The kinds, in `FORKING_FAMILIES` order: the enum both doors declare. */
export const FORK_KIND_NAMES: readonly ForkKind[] = Object.freeze([...FORK_KINDS.keys()]);

const rowOf = (kind: ForkKind): ForkKindRow => FORK_KINDS.get(kind)!;

/** The forking kind whose collection is `family`, or undefined for a collection that does not fork. */
export function forkKindOfFamily(family: string): ForkKind | undefined {
  for (const row of FORK_KINDS.values()) if (row.family === family) return row.kind;
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Read-only (section 8)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE refusal of an ordinary edit of a fork row: throws {@link ForkRowReadOnly} when `stored` carries `forkOf` and `kind` forks; returns otherwise.
 * `kind` is a record type (`fact`) or a collection (`facts`): the two callers that read by collection need not translate. A row of a kind that does
 * not fork passes whatever it carries.
 */
export function refuseForkEdit(kind: string, stored: { _id?: unknown; forkOf?: unknown } | null | undefined): void {
  if (!stored || typeof stored.forkOf !== 'string') return;
  const forkKind = FORK_KINDS.has(kind as ForkKind) ? kind as ForkKind : forkKindOfFamily(kind);
  if (forkKind === undefined) return;
  throw new ForkRowReadOnly(KIND_WORD[forkKind]!, String(stored._id), stored.forkOf);
}

/** {@link refuseForkEdit} for every stored row of `kind` among `ids`: one read, for a batch that names records by id before it is judged. */
export async function refuseForkRowsNamed(spaceId: string, kind: ForkKind, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const fork = await col<{ _id: string; forkOf?: string }>(spaceCollection(spaceId, rowOf(kind).family))
    .findOne(asFilter<{ _id: string }>({ _id: { $in: [...ids] }, forkOf: { $exists: true } }), { projection: { _id: 1, forkOf: 1 } });
  refuseForkEdit(kind, fork);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Removal with the subject (section 7)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every fork row of `subjectIds`, legacy fact chains walked down by `forkOf` to `MAX_FORK_DEPTH` levels (a new fork has none of its own): ids and
 * versions, read through the `{ forkOf: 1 }` index.
 */
export async function forkRowsUnder(spaceId: string, family: string, subjectIds: readonly string[], session?: ClientSession): Promise<Array<{ _id: string; seq?: number }>> {
  const out: Array<{ _id: string; seq?: number }> = [];
  const seen = new Set<string>(subjectIds);
  let level = [...subjectIds];
  for (let depth = 0; depth < MAX_FORK_DEPTH && level.length > 0; depth++) {
    const rows = await col<{ _id: string; seq?: number }>(spaceCollection(spaceId, family as ForkingFamily))
      .find(asFilter<{ _id: string }>({ forkOf: { $in: level } }), { projection: { _id: 1, seq: 1 }, ...(session ? { session } : {}) })
      .toArray() as Array<{ _id: string; seq?: number }>;
    const fresh = rows.filter(r => !seen.has(r._id));
    for (const r of fresh) seen.add(r._id);
    out.push(...fresh);
    level = fresh.map(r => r._id);
  }
  return out;
}

/** How many unresolved versions `subjectId` holds, chains included: what a delete of it takes with it (the entity cascade preview says it). */
export async function countForksOf(spaceId: string, kind: ForkKind, subjectId: string): Promise<number> {
  return (await forkRowsUnder(spaceId, rowOf(kind).family, [subjectId])).length;
}

/**
 * Remove the unresolved versions of `subjectIds` with their subject (an explicit delete, the TTL sweep, the entity cascade): each fork goes behind a
 * tombstone issued here, its embed job retired and its links removed, as the subject's are. Called BEFORE the subject's own removal, so a refusal
 * (a version at the ceiling) leaves both. An arriving tombstone's cascade is not this: it removes the forks with NO tombstone, because every instance
 * that holds the subject applies the same tombstone and removes its own (`sync/tombstone-apply.ts`, design rev 4 §7, R7). Returns the ids removed.
 */
export async function removeForksOf(
  spaceId: string, kind: ForkKind, subjectIds: readonly string[], { session }: { session?: ClientSession } = {},
): Promise<string[]> {
  if (subjectIds.length === 0) return [];
  const { family, tombstoneType } = rowOf(kind);
  const rows = await forkRowsUnder(spaceId, family, subjectIds, session);
  if (rows.length === 0) return [];
  const ids = rows.map(r => r._id);
  await removeWithTombstones(spaceId, family, rows.map(r => ({ _id: r._id, type: tombstoneType, originalSeq: r.seq })), session ? { session } : {});
  if (!session) await settleRemovedForks(spaceId, kind, ids);
  return ids;
}

/** After the removal committed: the forks' embed jobs and the links they start, each failure said once and never thrown (the removal stands). */
async function settleRemovedForks(spaceId: string, kind: ForkKind, ids: readonly string[]): Promise<void> {
  try { await retireEmbedJobs(spaceId, kind, ids); } catch (err) {
    log.warn(`forks: ${ids.length} removed ${kind} forks in '${peerText(spaceId)}' kept their embed jobs (the worker retires them): ${peerText(err)}`);
  }
  if (kind === 'entity' || kind === 'edge') return;   // nothing is linked FROM an entity or an edge
  try {
    const { removeLinksFromMany } = await import('./links.js');
    await removeLinksFromMany(spaceId, ids, kind);
  } catch (err) {
    log.warn(`forks: the links of ${ids.length} removed ${kind} forks in '${peerText(spaceId)}' were not removed: ${peerText(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// The re-mint (section 7)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/** One subject that moved: its forks follow it. `patch` is what changes in each fork's body (an edge's endpoints); a relabel leaves the fork's own label. */
export interface ForkRepoint {
  readonly oldSubject: string;
  readonly newSubject: string;
  readonly patch?: Readonly<Record<string, unknown>>;
}

/**
 * What a re-mint did: the old fork id and the new one, the old ids whose body the receiving subject already held (removed, nothing inserted), and what
 * followed the old ids: the edges and links that NAMED a removed fork now name its new id, or the row that already held its body ({@link remintForks}).
 * `rekeyed` and `deletedDuplicateEdgeIds` are the edge half's, for the steps a caller runs once its transaction has committed (embeds, webhooks).
 */
export interface ForkRemint {
  reminted: Array<{ from: string; to: string }>;
  alreadyHeld: string[];
  rekeyed: Array<import('./edge-rekey.js').EdgeRekey>;
  deletedDuplicateEdgeIds: string[];
}

/**
 * Re-point the forks of every `oldSubject` onto its `newSubject`, inside the caller's transaction (`session`), BEFORE the caller tombstones the old
 * subject. For each fork, in this order (R8):
 *  1. its version is allocated against the OLD fork id, whose tombstones are the ones the new row could fall below;
 *  2. the new id is derived, `forkIdFor(newSubject, newSeq, body')`, and `forkAt` is set to `newSeq`, so the row verifies at every peer;
 *  3. the new id must hold no row and no tombstone at or above `newSeq`, or the transaction aborts;
 *  4. the old row goes behind a tombstone issued here and the new one is inserted, carrying a `_resolvedElsewhere` mark: the decision is still owed.
 * A body the receiving subject or one of its forks already holds is not inserted again. The receiving subject's forks plus the incoming ones may not
 * pass `MAX_FORKS_PER_RECORD`: {@link ForkCapRefusal}, thrown before anything is written, so the transaction aborts and the store is unchanged.
 *
 * **What named an old fork id follows it (design §7, "What else follows the old fork id").** A fork entity, fact or chrono entry is listed in Brain, so an
 * edge or a link can name it. Each such reference is relinked, in the same transaction, from the old id to the re-minted one, or to the row that already
 * held the body when none was inserted, by the relink a subject's own references go through (`relinkEdgesOfRecord`, `relinkLinksOfRecord`). It is inside the
 * re-mint so no caller can leave it out: a removed id that a record still names is a dangling reference that no delete guard can see. An edge names nothing.
 */
export async function remintForks(
  spaceId: string, kind: ForkKind, repoints: readonly ForkRepoint[], { session, now }: { session: ClientSession; now: string },
): Promise<ForkRemint> {
  const out: ForkRemint = { reminted: [], alreadyHeld: [], rekeyed: [], deletedDuplicateEdgeIds: [] };
  const moving = repoints.filter(r => r.oldSubject !== r.newSubject || (r.patch && Object.keys(r.patch).length > 0));
  if (moving.length === 0) return out;
  const { family, tombstoneType } = rowOf(kind);
  const coll = col<Record<string, unknown> & { _id: string }>(spaceCollection(spaceId, family));
  const byOld = new Map(moving.map(r => [r.oldSubject, r]));
  const forks = await coll.find(asFilter<{ _id: string }>({ forkOf: { $in: [...byOld.keys()] } }), { session }).toArray() as Array<Record<string, unknown> & { _id: string; forkOf: string; seq?: number }>;
  if (forks.length === 0) return out;
  if (kind === 'edge' && !(await edgeIdentityAdmitsForks(spaceId))) throw new EdgeIdentityBuilding(spaceId);

  // What each receiving subject already holds: its own body and its forks' bodies, and how many forks.
  const targets = [...new Set(forks.map(f => byOld.get(f.forkOf)!.newSubject))];
  const heldBodies = new Map<string, Map<string, string>>();
  const heldCount = new Map<string, number>();
  for (const t of targets) {
    const rows = await coll.find(asFilter<{ _id: string }>({ $or: [{ _id: t }, { forkOf: t }] }), { session, projection: NEVER_RETURNED_PROJECTION }).toArray() as Array<Record<string, unknown>>;
    heldBodies.set(t, new Map(rows.map(r => [authoredContentHash(family, r).hash, String(r['_id'])] as const)));
    heldCount.set(t, rows.filter(r => typeof r['forkOf'] === 'string' && !byOld.has(String(r['forkOf']))).length);
  }
  const plan: Array<{ old: typeof forks[number]; target: string; body: Record<string, unknown> }> = [];
  /** Per removed id whose body was already held: the row that held it (a planned fork is named by its old id here, and followed to its new one below). */
  const holders = new Map<string, string>();
  for (const f of forks) {
    const rp = byOld.get(f.forkOf)!;
    const body = { ...f, ...(rp.patch ?? {}) };
    const hash = authoredContentHash(family, body).hash;
    const held = heldBodies.get(rp.newSubject)!;
    if (held.has(hash)) { out.alreadyHeld.push(f._id); holders.set(f._id, held.get(hash)!); continue; }
    held.set(hash, f._id);
    heldCount.set(rp.newSubject, (heldCount.get(rp.newSubject) ?? 0) + 1);
    plan.push({ old: f, target: rp.newSubject, body });
  }
  for (const [t, n] of heldCount) if (n > MAX_FORKS_PER_RECORD && plan.some(p => p.target === t)) throw new ForkCapRefusal(n, MAX_FORKS_PER_RECORD);

  // 1. Versions against the OLD ids; 2. the new ids derived from them.
  const versions = await versionsFor(spaceId, plan.map(p => p.old._id), { parts: [family], session });
  const minted = plan.map((p, i) => {
    const newSeq = versions[i]!.version;
    const text = authoredContentHash(family, { ...p.body, forkOf: p.target, forkAt: newSeq }).text;
    return { ...p, newSeq, newId: forkIdFor(p.target, newSeq, text) };
  });
  // 3. Nothing may stand at a new id: a row, or a tombstone at or above its version.
  if (minted.length > 0) {
    const ids = minted.map(m => m.newId);
    const [rowHeld, tombs] = await Promise.all([
      coll.findOne(asFilter<{ _id: string }>({ _id: { $in: ids } }), { session, projection: { _id: 1 } }),
      col<{ _id: string; seq: number }>(spaceCollection(spaceId, 'tombstones')).find(asFilter<{ _id: string }>({ _id: { $in: ids } }), { session, projection: { _id: 1, seq: 1 } }).toArray(),
    ]);
    const tombAt = new Map(tombs.map(t => [t._id, t.seq] as const));
    const clash = rowHeld?._id ?? minted.find(m => (tombAt.get(m.newId) ?? -1) >= m.newSeq)?.newId;
    if (clash !== undefined) throw new ForkRefusal(409, `the re-minted ${kind} fork '${peerText(clash)}' is already held here; nothing was written`);
  }
  // 4. The old rows go behind tombstones issued here (stamped below the inserts), then the new rows land.
  const gone = forks.map(f => ({ _id: f._id, type: tombstoneType, deletedAt: now, originalSeq: f.seq }));
  await removeWithTombstones(spaceId, family, gone, { session });
  if (minted.length > 0) {
    await withLandingStamp(spaceId, minted.map(m => localRow(m.newSeq)), async (patches) => {
      // `rekeyedRow` drops the write guard: a fork row is never stamped (`_functionalGuard` locks a SUBJECT's slot), and one that carried its old
      // subject's marker would hold that slot for ever. Dropped again here by name, so the guarantee does not rest on a helper's docblock.
      const docs = minted.map((m, i) => withoutField(FUNCTIONAL_GUARD, rekeyedRow(m.body, { _id: m.newId, forkOf: m.target, forkAt: m.newSeq, updatedAt: now, ...patches[i]! })));
      for (const chunk of inChunks(docs, ROWS_PER_BULK_COMMAND)) {
        await coll.insertMany(chunk.map(d => asDoc<Record<string, unknown> & { _id: string }>(d as Record<string, unknown> & { _id: string })), { ordered: true, session });
      }
    }, 'fork.remint');
  }
  out.reminted = minted.map(m => ({ from: m.old._id, to: m.newId }));
  if (kind !== 'edge') {
    // What named a removed id now names its new one, or the holder of its body (itself followed to its new id when the holder was re-minted too).
    const newIdOf = new Map(out.reminted.map(r => [r.from, r.to] as const));
    const follow = [...out.reminted, ...[...holders].map(([from, to]) => ({ from, to: newIdOf.get(to) ?? to }))];
    const relink = await relinkModule();
    for (const { from, to } of follow) {
      const edges = await relink.relinkEdgesOfRecord(spaceId, { absorbedId: from, survivorId: to, kind }, { now, session });
      out.rekeyed.push(...edges.rekeyed);
      out.deletedDuplicateEdgeIds.push(...edges.deletedDuplicateEdgeIds);
      await relink.relinkLinksOfRecord(spaceId, { absorbedId: from, survivorId: to, kind }, { now, session });
    }
  }
  return out;
}

/** A copy of `row` without `field`: every fork-module writer of an edge row inserts it without the write guard (`FUNCTIONAL_GUARD`), by name. */
function withoutField<T extends object>(field: string, row: T): T {
  const out = { ...row } as Record<string, unknown>;
  delete out[field];
  return out as T;
}

/**
 * The cap a merge is refused at in its READ phase (section 7): the survivor's forks plus the absorbed record's, past `MAX_FORKS_PER_RECORD`, is
 * {@link ForkCapRefusal} before anything is written.
 */
export async function assertForksFitTogether(spaceId: string, kind: ForkKind, survivorId: string, absorbedId: string): Promise<void> {
  const coll = col<{ _id: string }>(spaceCollection(spaceId, rowOf(kind).family));
  const [a, b] = await Promise.all([
    coll.countDocuments(asFilter<{ _id: string }>({ forkOf: survivorId })),
    coll.countDocuments(asFilter<{ _id: string }>({ forkOf: absorbedId })),
  ]);
  if (b > 0 && a + b > MAX_FORKS_PER_RECORD) throw new ForkCapRefusal(a + b, MAX_FORKS_PER_RECORD);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Review: parameters and refusals (section 10)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The page size when the caller names none. */
export const DEFAULT_FORK_PAGE = 25;
/** The largest page; a `limit` past it is refused, not served smaller. */
export const MAX_FORK_PAGE = 200;

/** Which side a resolve keeps. */
export const FORK_KEEPS = ['fork', 'parent'] as const;
export type ForkKeep = (typeof FORK_KEEPS)[number];

/** The sentence both doors say for a `keep` that is neither side. */
export const KEEP_REFUSAL = `keep must be one of ${FORK_KEEPS.map(k => `'${k}'`).join(' or ')}`;

/** A refusal of a Review call: the one sentence a caller reads on whichever door, with the status REST answers it by. */
export class ForkRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422, message: string) {
    super(message);
    this.name = 'ForkRefusal';
  }
}

const KIND_ENUM = z.enum(FORK_KIND_NAMES as unknown as [ForkKind, ...ForkKind[]]);
const VERSION = z.number().int().min(0).max(MAX_SYNC_SEQ);

/** The list's parameters: what BOTH doors validate by, and what the bounds gate reads the route's bounds from. `kind` is optional. */
export const ForkListParams = z.object({
  kind: KIND_ENUM.optional(),
  skip: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_FORK_PAGE).optional(),
});

/**
 * The resolve's parameters, ALL required (D5): `kind` (ids are unique per collection only), the fork, the side kept, and both versions as listed.
 * `ifMatchParentSeq: 0` says "this fork has no parent", and is accepted only when its parent is absent.
 */
export const ForkResolveParams = z.object({
  kind: KIND_ENUM,
  forkId: z.string().min(1),
  keep: z.string(),
  ifMatchSeq: VERSION,
  ifMatchParentSeq: VERSION,
});
export type ForkResolveInput = { kind: ForkKind; forkId: string; keep: ForkKeep; ifMatchSeq: number; ifMatchParentSeq: number };

/** The resolve's parameters in the order a missing one is reported, which is the order the tool schema declares them. */
const RESOLVE_ORDER = ['kind', 'forkId', 'keep', 'ifMatchSeq', 'ifMatchParentSeq'] as const;

/**
 * A query string's text is a number to the schema only when it is a whole one: an absent or empty value is absent, a JSON number stays itself,
 * and anything else stays as sent so the schema refuses it.
 */
const asNumber = (raw: unknown): unknown => {
  if (raw === undefined || raw === '') return undefined;
  return typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : raw;
};

/** `keep` as a side, or the one refusal. */
export function parseKeep(raw: unknown): ForkKeep {
  if (typeof raw !== 'string' || !(FORK_KEEPS as readonly string[]).includes(raw)) throw new ForkRefusal(400, KEEP_REFUSAL);
  return raw as ForkKeep;
}

/** The detail the MCP validator gives a value outside its bounds, so REST says it in the same words. */
function boundDetail(field: string, value: unknown, enumOf?: readonly string[]): string {
  if (enumOf) return `/${field}: must be equal to one of the allowed values (${enumOf.join(', ')})`;
  if (typeof value !== 'number' || !Number.isInteger(value)) return `/${field}: must be integer`;
  return value < 0 ? `/${field}: must be >= 0` : `/${field}: must be <= ${MAX_SYNC_SEQ}`;
}

/**
 * The resolve's five parameters, or the one 400 sentence: a missing one (an absent value, or a blank `forkId`) in the MCP validator's own words,
 * a `kind` outside the enum and a version outside its bounds likewise, and a `keep` that is neither side in {@link KEEP_REFUSAL}.
 */
export function parseResolveParams(raw: Readonly<Record<string, unknown>>): ForkResolveInput {
  const given: Record<string, unknown> = { ...raw, forkId: typeof raw['forkId'] === 'string' && raw['forkId'].trim() === '' ? undefined : raw['forkId'] };
  for (const p of RESOLVE_ORDER) {
    if (given[p] === undefined || given[p] === null) throw new ForkRefusal(400, invalidArgumentsSentence('resolve_fork', missingArgumentDetail(p)));
  }
  if (typeof given['kind'] !== 'string' || !FORK_KINDS.has(given['kind'] as ForkKind)) {
    throw new ForkRefusal(400, invalidArgumentsSentence('resolve_fork', boundDetail('kind', given['kind'], FORK_KIND_NAMES)));
  }
  for (const p of ['ifMatchSeq', 'ifMatchParentSeq'] as const) {
    if (!VERSION.safeParse(given[p]).success) throw new ForkRefusal(400, invalidArgumentsSentence('resolve_fork', boundDetail(p, given[p])));
  }
  const parsed = ForkResolveParams.safeParse(given);
  if (!parsed.success) throw new ForkRefusal(400, invalidArgumentsSentence('resolve_fork', `/${String(refusalOfParse(parsed.error).issues[0]?.path[0] ?? 'arguments')}: must be string`));
  return { ...parsed.data, keep: parseKeep(parsed.data.keep) };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Review: the list (section 10)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The fields a version shows: its id, the kind's body (`BODY_FIELDS_OF`), who wrote it, when, and its version. Never a vector or a position. */
function versionFieldsOf(kind: ForkKind): string[] {
  return ['_id', ...BODY_FIELDS_OF[rowOf(kind).family]!, 'author', 'createdAt', 'updatedAt', 'seq'];
}

type Version = Record<string, unknown> & { _id: string; seq?: number };

/** One entry of a row's `resolvedElsewhere`: the mark as stored, and which side that instance kept, derived when the list is read. */
export interface ResolvedElsewhereShown {
  by: string;
  /** The label this instance knows `by` under; absent when it knows none (the reader shows the short id then). */
  byLabel?: string;
  at: string;
  proven: boolean;
  via?: string;
  /** The same for `via`. */
  viaLabel?: string;
  kept: 'original' | 'this version' | 'not yet known';
}

/** One row of the list: a fork beside its parent (null when the parent is gone), what points at the fork, how many forks the parent holds, and its marks. */
export interface ForkRow {
  kind: ForkKind;
  /** The space the fork lives in: the one a resolve names. Through a personal view, one of its members. */
  space: string;
  forkId: string;
  parentId: string;
  fork: Version;
  parent: Version | null;
  orphaned: boolean;
  edgeCount: number;
  linkCount: number;
  siblings: number;
  resolvedElsewhere: ResolvedElsewhereShown[];
  /** An edge fork's endpoint names, the ones the Edges list shows (`withEndpointNames`); absent for another kind and for an end that is gone. */
  fromName?: string;
  toName?: string;
}

export interface ForkPage {
  forks: ForkRow[];
  /** Every fork of the kind asked (every kind when none is), not only this page's. */
  total: number;
  skip: number;
  limit: number;
  /** Per kind, every fork of the space; `resolvedElsewhere` per kind, the ones another instance already decided. */
  counts: Record<ForkKind, number> & { resolvedElsewhere: Record<ForkKind, number> };
  /** Per kind, the fields two versions are compared by and the one shown by word. */
  kinds: Record<ForkKind, { fields: string[]; mainField: string }>;
  /** The most forks one record may hold. */
  maxForksPerRecord: number;
}

const perKind = <T>(f: (k: ForkKind) => T): Record<ForkKind, T> => Object.fromEntries(FORK_KIND_NAMES.map(k => [k, f(k)])) as Record<ForkKind, T>;

/** Which side the instance that marked a fork kept (section 9a): read from the parent it wrote, never stored. */
function keptBy(kind: ForkKind, mark: ResolvedElsewhereEntry, fork: Version, parent: Version | null): ResolvedElsewhereShown['kept'] {
  if (!parent) return 'not yet known';
  const author = (parent['author'] as { instanceId?: string } | undefined)?.instanceId;
  if (author !== mark.by || typeof parent.seq !== 'number' || typeof fork.seq !== 'number' || parent.seq <= fork.seq) return 'not yet known';
  const family = rowOf(kind).family;
  return bodiesDiffer(authoredContentHash(family, parent), authoredContentHash(family, fork)) ? 'original' : 'this version';
}

/** How many edges and links point at each fork id of one kind: one read per collection for the page, never one per row. */
async function referencesTo(spaceId: string, kind: ForkKind, ids: readonly string[]): Promise<Map<string, { edgeCount: number; linkCount: number }>> {
  const out = new Map(ids.map(id => [id, { edgeCount: 0, linkCount: 0 }]));
  if (ids.length === 0 || kind === 'edge') return out;
  const wanted = new Set(ids);
  const ends = await col<{ from: string; to: string }>(spaceCollection(spaceId, 'edges')).aggregate<{ _id: string; n: number }>([
    { $match: { $or: [{ from: { $in: [...ids] } }, { to: { $in: [...ids] } }] } },
    // An end is an id AND a kind (`edge-ends-of-record.ts`; an absent kind is an entity): an edge of a fact holding a fork entity's id does not reference it.
    { $project: { ends: { $setUnion: [[{ id: '$from', kind: { $ifNull: ['$fromKind', 'entity'] } }], [{ id: '$to', kind: { $ifNull: ['$toKind', 'entity'] } }]] } } },
    { $unwind: '$ends' },
    { $match: { 'ends.id': { $in: [...ids] }, 'ends.kind': kind } },
    { $group: { _id: '$ends.id', n: { $sum: 1 } } },
  ], { maxTimeMS: listReadMaxMs(false) }).toArray();
  for (const e of ends) if (wanted.has(e._id)) out.get(e._id)!.edgeCount = e.n;
  const [pointing, starting] = await Promise.all([linksPointingAt(spaceId, ids), linksStartingFrom(spaceId, ids)]);
  for (const l of pointing) if (l.toKind === kind && wanted.has(l.to)) out.get(l.to)!.linkCount++;
  for (const l of starting) if (l.fromKind === kind && wanted.has(l.from)) out.get(l.from)!.linkCount++;
  return out;
}

/**
 * One page of the space's forks, newest landing first, each beside its parent (or marked orphaned), paged BEFORE any body is read: the ids, versions,
 * positions and marks of every forking collection are unioned, sorted by the space's one position stream, paged, and only the page's bodies and
 * parents are read. `counts` holds every kind whatever `kind` asked.
 *
 * `members` are the spaces the caller reads (`readSpacesOfRequest` / `readSpacesOfCall`): one for a space, a personal view's readable members for a
 * view. A view's id is never read as a space — that answered an empty page, or a 500, with no word that anything was skipped. Each row names the
 * `space` it lives in, which is what a resolve names. Several members are merged by `pageAcrossMembers`, the one paging rule for a merge.
 */
export async function listForks(members: readonly string[], opts: { kind?: unknown; skip?: unknown; limit?: unknown }): Promise<ForkPage> {
  const kindRaw = opts.kind === '' ? undefined : opts.kind;
  const asked = ForkListParams.safeParse({ kind: kindRaw, skip: asNumber(opts.skip), limit: asNumber(opts.limit) });
  if (!asked.success) {
    const field = refusalOfParse(asked.error).issues[0]?.path[0];
    if (field === 'kind') throw new ForkRefusal(400, invalidArgumentsSentence('list_forks', boundDetail('kind', kindRaw, FORK_KIND_NAMES)));
    throw new ForkRefusal(400, (field === 'skip' ? skipRefusal(Number.NaN) : limitRefusal(Number.NaN, MAX_FORK_PAGE)) ?? 'the paging parameters are not whole numbers');
  }
  const skip = asked.data.skip ?? 0;
  const limit = asked.data.limit ?? DEFAULT_FORK_PAGE;
  const only = asked.data.kind;
  const ofMember = new Map<string, MemberForks>();
  const read = await pageAcrossMembers<OrderedForkRow>({
    members, limit, skip, ceiling: PROXY_PAGE_CEILING,
    // Newest landing first, `_id` breaking a tie: the order each member's own page is read in (`LANDING_ORDER`).
    compare: (a, b) => (b.order.pos - a.order.pos) || (a.order.id < b.order.id ? 1 : a.order.id > b.order.id ? -1 : 0),
    readMember: async (space, lim, sk) => {
      const got = await forksOfSpace(space, only, sk, lim);
      ofMember.set(space, got);
      return got.rows;
    },
    finish: ({ order: _order, ...row }) => row as OrderedForkRow,
  });
  if (!read.ok) throw new ForkRefusal(400, read.error);
  const all = [...ofMember.values()];
  const sum = (pick: (m: MemberForks, k: ForkKind) => number) => perKind(k => all.reduce((n, m) => n + pick(m, k), 0));
  return {
    forks: read.rows as ForkRow[], total: all.reduce((n, m) => n + m.total, 0), skip, limit,
    counts: { ...sum((m, k) => m.counts[k]), resolvedElsewhere: sum((m, k) => m.marked[k]) },
    kinds: perKind(k => ({ fields: [...BODY_FIELDS_OF[rowOf(k).family]!], mainField: rowOf(k).mainField })),
    maxForksPerRecord: MAX_FORKS_PER_RECORD,
  };
}

/** A listed fork with the keys the merge orders by, which `finish` takes off before anything else reads the row. */
type OrderedForkRow = ForkRow & { order: { pos: number; id: string } };

/** One member's page of forks, with the counts the whole answer sums. */
interface MemberForks {
  rows: OrderedForkRow[];
  total: number;
  counts: Record<ForkKind, number>;
  marked: Record<ForkKind, number>;
}

/** One space's forks: the page `skip`/`limit` name (of `only`'s kind, or every kind), and the counts of every kind. See {@link listForks}. */
async function forksOfSpace(spaceId: string, only: ForkKind | undefined, skip: number, limit: number): Promise<MemberForks> {
  const stagesOf = (k: ForkKind) => [
    { $match: { forkOf: { $exists: true } } },
    { $project: { _id: 1, forkOf: 1, pos: 1, seq: 1, marked: { $gt: [{ $size: { $ifNull: [`$${RESOLVED_ELSEWHERE}`, []] } }, 0] }, kind: { $literal: k } } },
  ];
  const [first, ...rest] = FORK_KIND_NAMES;
  const pick = only ? [{ $match: { kind: only } }] : [];
  const [agg] = await col(spaceCollection(spaceId, rowOf(first!).family)).aggregate<{
    page: Array<{ _id: string; kind: ForkKind; forkOf: string; pos?: number }>; total: Array<{ n: number }>; counts: Array<{ _id: ForkKind; n: number; marked: number }>;
  }>([
    ...stagesOf(first!),
    ...rest.map(k => ({ $unionWith: { coll: spaceCollection(spaceId, rowOf(k).family), pipeline: stagesOf(k) } })),
    { $sort: { ...LANDING_ORDER } },
    { $facet: {
      page: [...pick, { $skip: skip }, { $limit: limit }],
      total: [...pick, { $count: 'n' }],
      counts: [{ $group: { _id: '$kind', n: { $sum: 1 }, marked: { $sum: { $cond: ['$marked', 1, 0] } } } }],
    } },
  ], { maxTimeMS: listReadMaxMs(false) }).toArray();
  const page = agg?.page ?? [];
  const counted = new Map((agg?.counts ?? []).map(c => [c._id, c] as const));

  const cfg = getConfig();
  // The page's bodies, parents, references and sibling counts: one read of each per kind.
  const forks: OrderedForkRow[] = [];
  const rowsByKind = new Map<ForkKind, Map<string, ForkRow>>();
  for (const kind of FORK_KIND_NAMES) {
    const ids = page.filter(p => p.kind === kind).map(p => p._id);
    if (ids.length === 0) continue;
    const coll = col<Version>(spaceCollection(spaceId, rowOf(kind).family));
    const projection = Object.fromEntries([...versionFieldsOf(kind), 'forkOf', 'forkAt', RESOLVED_ELSEWHERE].map(f => [f, 1]));
    const forkDocs = await coll.find(asFilter<Version>({ _id: { $in: ids } }), { projection, maxTimeMS: listReadMaxMs(false) }).toArray() as Version[];
    const parentIds = [...new Set(forkDocs.map(f => String(f['forkOf'])))];
    const parentProjection = Object.fromEntries(versionFieldsOf(kind).map(f => [f, 1]));
    const [parents, siblings, refs] = await Promise.all([
      coll.find(asFilter<Version>({ _id: { $in: parentIds } }), { projection: parentProjection, maxTimeMS: listReadMaxMs(false) }).toArray() as Promise<Version[]>,
      coll.aggregate<{ _id: string; n: number }>([{ $match: { forkOf: { $in: parentIds } } }, { $group: { _id: '$forkOf', n: { $sum: 1 } } }], { maxTimeMS: listReadMaxMs(false) }).toArray(),
      referencesTo(spaceId, kind, ids),
    ]);
    const parentOf = new Map(parents.map(p => [p._id, p]));
    const siblingsOf = new Map(siblings.map(s => [s._id, s.n]));
    const rows = new Map<string, ForkRow>();
    for (const f of forkDocs) {
      const { forkOf, forkAt: _forkAt, [RESOLVED_ELSEWHERE]: marks, ...fork } = f;
      const parentId = String(forkOf);
      const parent = parentOf.get(parentId) ?? null;
      rows.set(f._id, {
        kind, space: spaceId, forkId: f._id, parentId, fork: fork as Version, parent, orphaned: parent === null,
        ...refs.get(f._id)!, siblings: siblingsOf.get(parentId) ?? 1,
        resolvedElsewhere: ((marks as ResolvedElsewhereEntry[] | undefined) ?? []).map(m => {
          const stamped = [(fork as Version)['author'], parent?.['author']] as { instanceId?: unknown; instanceLabel?: unknown }[];
          const byLabel = instanceLabelOf(cfg, m.by, stamped);
          const viaLabel = m.via === undefined ? undefined : instanceLabelOf(cfg, m.via, stamped);
          return {
            by: m.by, ...(byLabel !== undefined ? { byLabel } : {}), at: m.at, proven: m.proven,
            ...(m.via !== undefined ? { via: m.via } : {}), ...(viaLabel !== undefined ? { viaLabel } : {}),
            kept: keptBy(kind, m, fork as Version, parent),
          };
        }),
      });
    }
    if (kind === 'edge') {
      const named = await withEndpointNames(
        [...rows.values()].map(r => ({ id: r.forkId, from: String(r.fork['from']), to: String(r.fork['to']), fromKind: r.fork['fromKind'] as never, toKind: r.fork['toKind'] as never })),
        async read => await read(spaceId),
      );
      for (const n of named) {
        const r = rows.get(n.id)!;
        if (n.fromName !== undefined) r.fromName = n.fromName;
        if (n.toName !== undefined) r.toName = n.toName;
      }
    }
    rowsByKind.set(kind, rows);
  }
  for (const p of page) {
    const row = rowsByKind.get(p.kind)?.get(p._id);
    if (row) forks.push({ ...row, order: { pos: typeof p.pos === 'number' ? p.pos : 0, id: p._id } });
  }
  return {
    rows: forks, total: agg?.total[0]?.n ?? 0,
    counts: perKind(k => counted.get(k)?.n ?? 0), marked: perKind(k => counted.get(k)?.marked ?? 0),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Review: the resolve (section 9)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

/** What a resolve answers: the side kept, the record that holds it now (null when an orphan's deletion stood), and what was repointed. */
export interface ForkResolution {
  resolved: true;
  kind: ForkKind;
  keep: ForkKeep;
  forkId: string;
  parentId: string;
  /** The parent as it is stored now, without its vector; null when the fork had no parent and its deletion stood. */
  parent: Record<string, unknown> | null;
  edgesRepointed: number;
  linksRepointed: number;
  /** Forks of the same body under another id (a legacy fact fork beside a body-derived one), removed with it. */
  siblingsRemoved: string[];
}

/** What the audit entry of a resolve is built from: the resolution, the mark the fork carried, and the two bodies. */
interface ResolveAudit { resolution: ForkResolution; marks: ResolvedElsewhereEntry[]; kept: Record<string, unknown> | null; discarded: Record<string, unknown> }

/**
 * The audit entry's `changes` for a resolve, built EXPLICITLY from the resolution (R12): the diff of before and after snapshots records nothing for a
 * resolve (`kind`, `keep` and `parentId` are equal in both, and the bodies are objects). `keep: 'parent'` discards content permanently and this row is
 * then the only place it survives, so both bodies are recorded. Handed to both doors.
 */
export function forkResolveAuditEntry({ resolution, marks, kept, discarded }: ResolveAudit): AuditChange[] {
  return [
    { field: 'kind', to: resolution.kind },
    { field: 'keep', to: resolution.keep },
    { field: 'parentId', to: resolution.parentId },
    { field: 'forkId', to: resolution.forkId },
    { field: 'resolvedElsewhere', to: marks.length > 0 ? JSON.stringify(marks) : null },
    { field: 'kept', to: kept ? JSON.stringify(kept) : null },
    { field: 'discarded', to: JSON.stringify(discarded) },
  ];
}

/** The body fields of a row, as written: what the audit records and the keep compares. */
function bodyOf(kind: ForkKind, row: Record<string, unknown>): Record<string, unknown> {
  const fields = BODY_FIELDS_OF[rowOf(kind).family]!;
  return { _id: row['_id'], ...Object.fromEntries(fields.filter(f => row[f] !== undefined).map(f => [f, row[f]])) };
}


/** The relink kinds' modules, loaded when a resolve needs them (they import this module: see the module docblock). */
async function relinkModule() { return import('./relink-references.js'); }

/** Each kind's ordinary delete, for an orphan whose deletion stands. */
async function deleteOf(kind: ForkKind): Promise<(spaceId: string, id: string, actor?: WebhookActor) => Promise<boolean>> {
  switch (kind) {
    case 'fact': return (await import('./fact.js')).deleteFact;
    case 'entity': return (await import('./entities.js')).deleteEntity;
    case 'chrono': return (await import('./chrono.js')).deleteChrono;
    case 'edge': return (await import('./edges.js')).deleteEdge;
  }
}

/**
 * Keep one side of a fork, on THIS instance (section 9). See the module docblock; the refusals, all {@link ForkRefusal}: a missing or malformed
 * parameter (400, one sentence on both doors); no such row (404); a row that is no fork, or whose id does not derive from its body (409); a fork or
 * a parent that changed since it was listed (409); `ifMatchParentSeq: 0` for a fork whose parent is stored (400).
 */
export async function resolveFork(spaceId: string, raw: Readonly<Record<string, unknown>>, actor?: WebhookActor): Promise<{ resolution: ForkResolution; audit: AuditChange[] }> {
  const { kind, forkId, keep, ifMatchSeq, ifMatchParentSeq } = parseResolveParams(raw);
  const { family, tombstoneType } = rowOf(kind);
  const word = KIND_WORD[kind]!;
  const coll = col<Record<string, unknown> & { _id: string }>(spaceCollection(spaceId, family));
  const fork = await coll.findOne(asFilter<{ _id: string }>({ _id: forkId }), { projection: NEVER_RETURNED_PROJECTION }) as (Record<string, unknown> & { _id: string; seq?: number; forkOf?: string }) | null;
  if (!fork) throw new ForkRefusal(404, `No ${word.toLowerCase()} fork '${peerText(forkId)}' in space '${peerText(spaceId)}'`);
  if (typeof fork.forkOf !== 'string') throw new ForkRefusal(409, `${word} '${peerText(forkId)}' is not a fork, so there is nothing to resolve`);
  // The derivation, again (D3): a planted `forkOf` cannot direct a keep at an unrelated record.
  if (forkRowVerdict(family, fork as unknown as ArrivalDoc, authoredContentHash(family, fork).text) === 'invalid') {
    throw new ForkRefusal(409, `${word} '${peerText(forkId)}' does not derive from its parent '${peerText(fork.forkOf)}'; delete it instead`);
  }
  if (fork.seq !== ifMatchSeq) throw new ForkRefusal(409, `${word} fork '${peerText(forkId)}' changed since it was listed; list again`);
  const parentId = fork.forkOf;
  const parent = await coll.findOne(asFilter<{ _id: string }>({ _id: parentId }), { projection: NEVER_RETURNED_PROJECTION }) as (Record<string, unknown> & { _id: string; seq?: number }) | null;
  if (parent && ifMatchParentSeq === 0) {
    throw new ForkRefusal(400, `ifMatchParentSeq 0 says the fork has no parent, and its parent '${peerText(parentId)}' is stored; send the parent's version as listed`);
  }
  if (!parent && ifMatchParentSeq !== 0) throw new ForkRefusal(409, `the parent '${peerText(parentId)}' of ${word.toLowerCase()} fork '${peerText(forkId)}' is no longer stored; list again`);
  if (parent && parent.seq !== ifMatchParentSeq) throw new ForkRefusal(409, `the parent '${peerText(parentId)}' of ${word.toLowerCase()} fork '${peerText(forkId)}' changed since it was listed; list again`);
  const marks = (fork[RESOLVED_ELSEWHERE] as ResolvedElsewhereEntry[] | undefined) ?? [];
  if (!parent) return resolveOrphan(spaceId, kind, fork as Record<string, unknown> & { _id: string; seq?: number; forkOf: string }, keep, marks, actor);

  // ── 1. The kept body, written FIRST, above both versions ─────────────────────────────────────────────────────────────────────────
  const { writeKeptBody, EDGE_IDENTITY_FIELDS } = await import('./fork-keep.js');
  if (kind === 'edge' && keep === 'fork' && EDGE_IDENTITY_FIELDS.some(f => fork[f] !== parent[f])) {
    throw new ForkRefusal(409, `Edge fork '${peerText(forkId)}' names other ends or another label than its subject '${peerText(parentId)}'; delete it instead`);
  }
  const redacted = kind === 'chrono' && (fork['contentRedacted'] === true || parent['contentRedacted'] === true);
  const blank = redacted ? [...REDACTED_CHRONO_FIELDS, 'contentRedacted', 'contentRedactedAt'] : [];
  const keptBody = keep === 'fork' ? fork : parent;
  // The type's schema refuses what the keep would leave: a 422 in the schema's own sentence, before anything is written (design §9).
  const written = await writeKeptBody(spaceId, family, parent, keptBody, { aboveVersion: Math.max(fork.seq ?? 0, parent.seq ?? 0), ifMatchSeq: ifMatchParentSeq, blank })
    .catch((err: unknown) => { throw err instanceof SchemaViolationError ? new ForkRefusal(422, err.check.message) : err; });
  if (!written) throw new ForkRefusal(409, `the parent '${peerText(parentId)}' of ${word.toLowerCase()} fork '${peerText(forkId)}' changed while it was being resolved; list again`);

  // ── 2. Siblings of the same body, what named the forks, and the forks behind tombstones issued here ─────────────────────────────────────
  const forkHash = authoredContentHash(family, fork).hash;
  const siblings = (await coll.find(asFilter<{ _id: string }>({ forkOf: parentId, _id: { $ne: forkId } }), { projection: NEVER_RETURNED_PROJECTION }).toArray() as Array<Record<string, unknown> & { _id: string; seq?: number }>)
    .filter(s => authoredContentHash(family, s).hash === forkHash);
  const gone = [fork, ...siblings];
  const before = await referencesTo(spaceId, kind, gone.map(g => g._id));
  const now = new Date().toISOString();
  const relink = await relinkModule();
  const relinked = await inHeldTransaction(spaceId, 'fork.resolve',
    (session) => admitSpaceWrite(spaceId, undefined, async () => {
      // The fork at the version it was resolved at: re-delivered at another one meanwhile, it is not tombstoned on the strength of the old one.
      if ((await coll.countDocuments(asFilter<{ _id: string }>({ _id: forkId, seq: fork.seq }), { session, limit: 1 })) === 0) {
        throw new ForkRefusal(409, `${word} fork '${peerText(forkId)}' changed since it was listed; list again`);
      }
      const rekeyed: Array<import('./edge-rekey.js').EdgeRekey> = [];
      const deletedDuplicateEdgeIds: string[] = [];
      if (kind !== 'edge') {
        for (const g of gone) {
          const edges = await relink.relinkEdgesOfRecord(spaceId, { absorbedId: g._id, survivorId: parentId, kind, moveForeign: true }, { now, session });
          rekeyed.push(...edges.rekeyed);
          deletedDuplicateEdgeIds.push(...edges.deletedDuplicateEdgeIds);
          await relink.relinkLinksOfRecord(spaceId, { absorbedId: g._id, survivorId: parentId, kind }, { now, session });
        }
      }
      await removeWithTombstones(spaceId, family, [{ _id: forkId, type: tombstoneType, deletedAt: now, originalSeq: fork.seq }], { session, filter: { seq: fork.seq } });
      await removeWithTombstones(spaceId, family, siblings.map(s => ({ _id: s._id, type: tombstoneType, deletedAt: now, originalSeq: s.seq })), { session });
      return { rekeyed, deletedDuplicateEdgeIds };
    }),
    // A commit whose answer was lost may have landed: the fork being gone IS the commit.
    { landed: async () => (await coll.countDocuments(asFilter<{ _id: string }>({ _id: forkId }), { limit: 1 })) === 0 });

  // ── 3. After the commit, each step guarded: the embed work and the webhooks ─────────────────────────────────────────────────────────
  await settleRemovedForks(spaceId, kind, gone.map(g => g._id));
  try { await enqueueEmbedJob(spaceId, kind, parentId, { priority: EMBED_PRIORITY.write }); } catch (err) {
    log.warn(`fork resolve: the parent '${peerText(parentId)}' in '${peerText(spaceId)}' was written but not queued for embedding: ${peerText(err)}`);
  }
  await relink.settleRekeyedEmbeds(spaceId, relinked.rekeyed, (err) => {
    log.warn(`fork resolve: '${peerText(forkId)}' was resolved into '${peerText(parentId)}' in '${peerText(spaceId)}', but the embed jobs of `
      + `${relinked.rekeyed.length} re-keyed edge(s) were not retired: ${peerText(err)}`);
  });
  if (actor) {
    emitWebhookEvent({ event: `${kind}.updated`, spaceId, entry: { _id: parentId }, ...actor });
    for (const g of gone) emitWebhookEvent({ event: `${kind}.deleted`, spaceId, entry: { _id: g._id }, ...actor });
    for (const id of relinked.deletedDuplicateEdgeIds) emitWebhookEvent({ event: 'edge.deleted', spaceId, entry: { _id: id }, ...actor });
  }
  const resolution: ForkResolution = {
    resolved: true, kind, keep, forkId, parentId, parent: withoutVector(written),
    edgesRepointed: [...before.values()].reduce((n, r) => n + r.edgeCount, 0),
    linksRepointed: [...before.values()].reduce((n, r) => n + r.linkCount, 0),
    siblingsRemoved: siblings.map(s => s._id),
  };
  return { resolution, audit: forkResolveAuditEntry({ resolution, marks, kept: bodyOf(kind, keptBody), discarded: bodyOf(kind, keep === 'fork' ? parent : fork) }) };
}

/**
 * A fork whose parent is gone. `keep: 'parent'`: the deletion stands, through the kind's ordinary delete. `keep: 'fork'`: the fork becomes the record,
 * stamped above its version. A fact, entity or chrono fork is unmarked in place (no identity slot); an edge fork is re-keyed onto the id its identity
 * derives, a new row WITHOUT `forkOf`, once the partial identity index stands and only when no edge holds that identity.
 */
async function resolveOrphan(
  spaceId: string, kind: ForkKind, fork: Record<string, unknown> & { _id: string; seq?: number; forkOf: string }, keep: ForkKeep,
  marks: ResolvedElsewhereEntry[], actor?: WebhookActor,
): Promise<{ resolution: ForkResolution; audit: AuditChange[] }> {
  const { family, tombstoneType } = rowOf(kind);
  const word = KIND_WORD[kind]!;
  const coll = col<Record<string, unknown> & { _id: string }>(spaceCollection(spaceId, family));
  const base = { resolved: true as const, kind, keep, parentId: fork.forkOf, edgesRepointed: 0, linksRepointed: 0, siblingsRemoved: [] as string[] };
  if (keep === 'parent') {
    const removed = await (await deleteOf(kind))(spaceId, fork._id, actor);
    if (!removed) throw new ForkRefusal(409, `${word} fork '${peerText(fork._id)}' changed since it was listed; list again`);
    const resolution: ForkResolution = { ...base, forkId: fork._id, parent: null };
    return { resolution, audit: forkResolveAuditEntry({ resolution, marks, kept: null, discarded: bodyOf(kind, fork) }) };
  }
  const now = new Date().toISOString();
  let keptId = fork._id;
  if (kind !== 'edge') {
    const [at] = await versionsFor(spaceId, [fork._id], { parts: [family] });
    const done = await admitSpaceWrite(spaceId, family, () => withLandingStamp(spaceId, [localRow(at!.version)], ([patch]) => coll.updateOne(
      asFilter<{ _id: string }>({ _id: fork._id, seq: fork.seq }),
      { $set: { updatedAt: now, ...patch! }, $unset: { forkOf: '', forkAt: '', [RESOLVED_ELSEWHERE]: '' } } as never,
    ), 'fork.resolve.orphan'));
    if (done.matchedCount === 0) throw new ForkRefusal(409, `${word} fork '${peerText(fork._id)}' changed since it was listed; list again`);
  } else {
    if (!(await edgeIdentityAdmitsForks(spaceId))) throw new EdgeIdentityBuilding(spaceId);
    const e = fork as unknown as Record<string, unknown> & { from: string; to: string; label: string; fromKind?: string; toKind?: string };
    keptId = edgeIdFor(e.from, e.to, e.label, e.fromKind as never, e.toKind as never);
    const held = await coll.findOne(asFilter<{ _id: string }>({ $or: [{ _id: keptId }, { from: e.from, to: e.to, label: e.label, fromKind: e.fromKind ?? null, toKind: e.toKind ?? null, forkOf: null }] }), { projection: { _id: 1 } });
    if (held) throw new ForkRefusal(409, `an edge already holds the identity of edge fork '${peerText(fork._id)}' (${peerText(held._id)}); delete the fork instead`);
    await inHeldTransaction(spaceId, 'fork.resolve.orphan', async (session) => {
      if ((await coll.countDocuments(asFilter<{ _id: string }>({ _id: fork._id, seq: fork.seq }), { session, limit: 1 })) === 0) {
        throw new ForkRefusal(409, `${word} fork '${peerText(fork._id)}' changed since it was listed; list again`);
      }
      const tomb = [{ _id: fork._id, type: tombstoneType, deletedAt: now, originalSeq: fork.seq }];
      const tombVersions = await stampTombstones(spaceId, tomb, { session });
      const [at] = await versionsFor(spaceId, [keptId], { parts: [family], known: new Map(tombVersions.map(v => [v.id, v.version] as const)), session });
      await removeWithTombstones(spaceId, family, tomb, { session, versions: tombVersions });
      await withLandingStamp(spaceId, [localRow(at!.version)], async ([patch]) => {
        const { forkOf: _f, forkAt: _a, [RESOLVED_ELSEWHERE]: _m, ...plain } = fork;
        // A new row under the identity's own id, WITHOUT `forkOf` and without any write guard (`_functionalGuard`): an orphan kept is never stamped here.
        await coll.insertOne(asDoc<Record<string, unknown> & { _id: string }>(withoutField(FUNCTIONAL_GUARD, rekeyedRow(plain, { _id: keptId, updatedAt: now, ...patch! })) as Record<string, unknown> & { _id: string }), { session });
      }, 'fork.resolve.orphan');
    }, { landed: async () => (await coll.countDocuments(asFilter<{ _id: string }>({ _id: keptId }), { limit: 1 })) === 1 });
    await settleRemovedForks(spaceId, kind, [fork._id]);
  }
  try { await enqueueEmbedJob(spaceId, kind, keptId, { priority: EMBED_PRIORITY.write }); } catch { /* the worker's sweep finds it */ }
  if (actor) emitWebhookEvent({ event: `${kind}.updated`, spaceId, entry: { _id: keptId }, ...actor });
  const stored = await coll.findOne(asFilter<{ _id: string }>({ _id: keptId }), { projection: NEVER_RETURNED_PROJECTION });
  const resolution: ForkResolution = { ...base, forkId: fork._id, parentId: keptId, parent: stored ? withoutVector(stored) : null };
  return { resolution, audit: forkResolveAuditEntry({ resolution, marks, kept: bodyOf(kind, fork), discarded: {} }) };
}
