/**
 * What was written to an entity while it was being deleted or merged away, and what a writer does when the entity it wrote to is gone (Q-305).
 *
 * ## The race, and why BOTH sides check
 *
 * A door deletes or merges an entity after reading what references it (`entityDeleteBlockers`, the merge's relink read); an edge or link writer writes
 * after reading that its entity end exists (`resolveEdgeEndsForWrite`, the link reconcile's existence check). The two touch DIFFERENT documents — the
 * entity on one side, an edge or link row on the other — so Mongo reports no write conflict (write skew), and an edge lands naming an entity the delete
 * has just removed, or one that a merge's relink read missed. A transaction cannot close it without a document both writes touch, and the only one is the
 * entity, which is replicated and hashed: a lock field on it would be a sixth local-only class, out of proportion to a race this narrow.
 *
 * So each side checks AFTER its own write is acknowledged (a Dekker handshake). The writer writes its edge (t1) and reads the entity (t2); the remover
 * deletes the entity (t3) and reads the edges (t4). If t2 precedes t3 then t1 precedes t4 and the remover sees the edge; if t2 follows t3 the writer sees the
 * entity gone. Reads go to the primary at the default read concern, which sees every acknowledged write, so one of the two always notices. Both may notice,
 * and that is safe: each cleanup is idempotent and runs in a held transaction, so two cleanups of one row meet as one removal and a no-op.
 *
 * ## What each side does
 *
 *  - **The remover** ({@link settleReferencesToRemovedEntity}, reached from `removeRecords`' per-kind step and from `executeMerge`, so no door can omit it)
 *    reads the edges and links that name the removed entity NOW. A DELETE takes back those THIS instance wrote, with their tombstones; a MERGE moves what is
 *    left to the survivor, the way the merge itself moved the rest.
 *  - **The writer** ({@link takeBackEdgesToGoneEntities}, {@link takeBackLinksToGoneEntities}, called from the one commit and the one link-row writer) re-reads
 *    its entity ends after the write and takes back what names a gone entity: an edge is refused `409 endpoint_removed`, a link is dropped and reported
 *    (`link_target_removed`), the record that carried it stays written.
 *
 * ## My instance = my data
 *
 * A DELETE removes only rows this instance wrote (`writtenHereFilter`). A peer's edge that names the entity is the arrival writer's and the link-violation
 * recorder's business, never removed here: no action on one instance decides what another instance holds.
 *
 * ## Only a strictLinkage space
 *
 * A space that opted out allows an end that names nothing, so there is nothing to settle there. The question is asked INSIDE every entry point
 * (`isStrictLinkage`), so a caller cannot forget it and a non-strict space is never touched.
 */
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { andPredicates } from '../db/and-predicates.js';
import { readStoredById } from '../db/read-by-id.js';
import { isStrictLinkage } from '../spaces/space-lookup.js';
import { admitSpaceWrite } from '../spaces/space-write-gate.js';
import { writtenHereFilter } from '../sync/written-here.js';
import { log, peerText } from '../util/log.js';
import { inHeldTransaction } from './held-transaction.js';
import { removeRecords } from './record-removal.js';
import { removeWithTombstones } from './tombstones.js';
import { edgeEndpointKind, missingRefs } from './entity-refs.js';
import { edgeEndsAt, type EdgeEnds } from './edge-ends-of-record.js';
import { EndpointRemoved, LINK_TARGET_REMOVED } from '../util/errors.js';
import type { WebhookActor } from '../webhooks/dispatcher.js';
import type { EdgeDoc, LinkDoc } from '../config/types.js';
import type { UpdateValidation } from './write-validation.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';

/** What {@link settleReferencesToRemovedEntity} did. */
export interface SettledReferences {
  /** Edges taken back (a delete). */
  removedEdges: string[];
  /** Links taken back (a delete). */
  removedLinks: string[];
  /** Edges re-keyed or written in place onto the survivor (a merge). */
  relinked: number;
  /** Absorbed edges deleted because the survivor already held their identity (a merge): their `edge.deleted` is the caller's to announce. */
  collapsedEdgeIds: string[];
}

/** `relink-references.ts`, loaded where it is used (see {@link settleReferencesToRemovedEntity}). */
type Relink = typeof import('./relink-references.js');

const NOTHING_SETTLED =(): SettledReferences => ({ removedEdges: [], removedLinks: [], relinked: 0, collapsedEdgeIds: [] });

/** An edge as the writer-side check reads it: its identity and its ends. */
export type EdgeToCheck = EdgeEnds & { _id: string; from: string; to: string };

/** An entity end of an edge that names no stored entity. */
export interface GoneEnd { id: string; side: 'from' | 'to' }

/**
 * After an entity was removed (deleted, or absorbed by a merge): take back what was written to it since its remover looked. Returns at once when the space
 * is not strict, or when the entity is stored again (re-created): nothing to settle. See the module docblock for what a delete and a merge each do.
 *
 * Thrown on a failure, as the removal's other per-kind steps are: the entity is gone and a caller that carried on would answer a removal whose references
 * are still owed. `executeMerge` logs it instead, because its merge has committed and the writer side still catches its own edge.
 */
export async function settleReferencesToRemovedEntity(
  spaceId: string, entityId: string, opts: SettleHow,
): Promise<SettledReferences> {
  if (!isStrictLinkage(spaceId)) return NOTHING_SETTLED();
  if ((await readStoredById(spaceCollection(spaceId, 'entities'), [entityId], { _id: 1 })).size > 0) return NOTHING_SETTLED();
  // Imported where it runs: `relink-references.ts` reaches `links.ts`, which reaches the commit, which calls this module's writer-side checks.
  const relink = await import('./relink-references.js');
  const settled = 'survivorId' in opts
    ? await moveReferencesToSurvivor(relink, spaceId, entityId, opts.survivorId, opts.maxRelinks)
    : await takeBackReferencesWrittenHere(relink, spaceId, entityId, opts.removalBegan, opts.actor);
  const counts = `${settled.removedEdges.length} edge(s) and ${settled.removedLinks.length} link(s) taken back, ${settled.relinked} edge(s) moved`;
  if (settled.removedEdges.length + settled.removedLinks.length + settled.relinked + settled.collapsedEdgeIds.length > 0) {
    log.info(`entity ${'survivorId' in opts ? 'merge' : 'delete'}: references written to '${peerText(entityId)}' in '${peerText(spaceId)}' while it was being removed were settled: ${counts}`);
  }
  return settled;
}

/**
 * How the removal went, which decides what is settled: a merge names the survivor the rest moves to; a delete names the record position it BEGAN at
 * (`removeRecords`' `began`), so what it takes back is bounded to what landed since.
 */
export type SettleHow =
  | { survivorId: string; /** The bound the merge was held to (`MERGE_MAX_RELINKS`, passed by `executeMerge` so there is one definition). */ maxRelinks: number }
  | { removalBegan: number; actor?: WebhookActor };

/**
 * How far before the removal's start a row may have landed and still be taken back by a delete's settle, in record-position microseconds. A door reads
 * what references the entity (the blockers) a moment before it deletes; a row that lands in that interval was never seen by the guard and is just as much
 * a straggler as one that lands after the delete began. A minute is long over the interval and short against any row that was already there to be seen.
 */
export const SETTLE_LOOKBACK_MICROS = 60_000_000;

/**
 * A delete: the edges and links that name the entity, THIS instance wrote, and that landed since the removal began (less {@link SETTLE_LOOKBACK_MICROS}),
 * removed with their tombstones. An older row is left as it was before the bundle: an unguarded delete (the TTL sweep's, an orphan fork's) never
 * read the references, so it is not entitled to take what was there to be read. A row's `pos` is where THIS instance landed it, restamped by every
 * local write, so what matches is a row written or last rewritten in the window.
 */
async function takeBackReferencesWrittenHere(
  relink: Relink, spaceId: string, entityId: string, removalBegan: number, actor: WebhookActor | undefined,
): Promise<SettledReferences> {
  const settled = NOTHING_SETTLED();
  const landedSince = { pos: { $gte: removalBegan - SETTLE_LOOKBACK_MICROS } };
  const mine = andPredicates(writtenHereFilter(), landedSince)!;
  const edgeIds = (await col<EdgeDoc>(spaceCollection(spaceId, 'edges'))
    .find(andPredicates(relink.edgesOfRecord(spaceId, entityId, 'entity'), mine) as never, { projection: { _id: 1 } })
    .toArray() as Array<Pick<EdgeDoc, '_id'>>).map(e => e._id);
  if (edgeIds.length > 0) settled.removedEdges = [...await removeRecords(spaceId, 'edge', edgeIds, actor)];
  const links = await relink.linkRowsOfRecord(spaceId, entityId, 'entity', mine);
  if (links.length > 0) {
    await removeWithTombstones(spaceId, 'links', links.map(l => ({ _id: l._id, type: 'link' as const, originalSeq: l.seq })), { filter: { spaceId } });
    settled.removedLinks = links.map(l => l._id);
  }
  return settled;
}

/**
 * A merge: whatever still names the absorbed entity moves to the survivor, as the merge's own relink moved the rest, in one held transaction — and only up to
 * `maxRelinks`, the bound the merge itself is refused at: a peer's burst that arrived during the merge is read whole inside one transaction otherwise. Past it
 * nothing is moved and the settle throws, which `executeMerge` says (the merge has committed); what names the absorbed id is then the arrival writer's and the
 * link-violation recorder's, as before the settle existed.
 */
async function moveReferencesToSurvivor(relink: Relink, spaceId: string, absorbedId: string, survivorId: string, maxRelinks: number): Promise<SettledReferences> {
  const settled = NOTHING_SETTLED();
  // The cheap read first, counted to one past the bound: the common case is that nothing arrived (no transaction is opened), and a count past the bound need not be exact.
  const [edgeCount, linkCount] = await Promise.all([
    col<EdgeDoc>(spaceCollection(spaceId, 'edges')).countDocuments(relink.edgesOfRecord(spaceId, absorbedId, 'entity'), { limit: maxRelinks + 1 }),
    col<LinkDoc>(spaceCollection(spaceId, 'links')).countDocuments(relink.linksOfRecord(spaceId, absorbedId, 'entity'), { limit: maxRelinks + 1 }),
  ]);
  if (edgeCount + linkCount === 0) return settled;
  if (edgeCount + linkCount > maxRelinks) {
    throw new Error(`more than ${maxRelinks} references name the merged-away entity '${peerText(absorbedId)}', more than a merge relinks: none was moved`);
  }
  const now = new Date().toISOString();
  const edges = await inHeldTransaction(spaceId, 'entity.merge.settle', (session) => admitSpaceWrite(spaceId, undefined, async () => {
    const relinked = await relink.relinkEdgesOfRecord(spaceId, { absorbedId, survivorId, kind: 'entity' }, { now, session });
    await relink.relinkLinksOfRecord(spaceId, { absorbedId, survivorId, kind: 'entity' }, { now, session });
    return relinked;
  }));
  await relink.settleRekeyedEmbeds(spaceId, edges.rekeyed, (err) => {
    log.warn(`merge settle: the embed jobs of ${edges.rekeyed.length} edge(s) moved to '${peerText(survivorId)}' in '${peerText(spaceId)}' were not retired: ${peerText(err)}`);
  });
  settled.relinked = edges.rekeyed.length;
  settled.collapsedEdgeIds = edges.deletedDuplicateEdgeIds;
  return settled;
}

/**
 * The entity ends among `ends` that are not stored any more — one `$in` read. Empty in a space that is not strict, which allows an end that names nothing,
 * so a caller cannot forget to ask.
 */
export async function goneEntityEnds(spaceId: string, ends: readonly string[]): Promise<Set<string>> {
  if (ends.length === 0 || !isStrictLinkage(spaceId)) return new Set();
  return new Set(await missingRefs(spaceId, 'entity', ends));
}

/** The ends of an edge that name an ENTITY (an absent kind is an entity), by side. */
export function entityEndsOf(edge: EdgeEnds & { from: string; to: string }): GoneEnd[] {
  const ends: GoneEnd[] = [];
  if (edgeEndpointKind(edge.fromKind) === 'entity') ends.push({ id: edge.from, side: 'from' });
  if (edgeEndpointKind(edge.toKind) === 'entity') ends.push({ id: edge.to, side: 'to' });
  return ends;
}

/**
 * The writer's check after its edges landed: each of `edges` whose entity end is gone is taken back (removed with its tombstone, only while it still names
 * the gone entity) and answered in the returned map by edge id — the end the caller refuses `endpoint_removed` for. Empty in a space that is not strict.
 * Thrown on a failure to take one back: the edge is stored against a gone entity and the caller must not report it written.
 */
export async function takeBackEdgesToGoneEntities(spaceId: string, edges: readonly EdgeToCheck[]): Promise<Map<string, GoneEnd>> {
  const refused = new Map<string, GoneEnd>();
  if (edges.length === 0) return refused;
  const gone = await goneEntityEnds(spaceId, edges.flatMap(e => entityEndsOf(e).map(end => end.id)));
  if (gone.size === 0) return refused;
  for (const goneId of gone) {
    const naming = edges.filter(e => entityEndsOf(e).some(end => end.id === goneId));
    // Only a row that STILL names the gone entity is removed, and only what was removed is refused: an edge a merge's settle moved meanwhile is the
    // survivor's now, and the write that made it succeeded (answering 409 "nothing is stored" for an edge that exists would send the caller to retry against
    // the entity that is gone).
    const removed = await removeRecords(spaceId, 'edge', naming.map(e => e._id), undefined, { filter: edgeEndsAt(goneId, 'entity') });
    for (const e of naming) if (removed.has(e._id) && !refused.has(e._id)) refused.set(e._id, entityEndsOf(e).find(end => end.id === goneId)!);
  }
  return refused;
}

/**
 * The writer's check after its link rows landed: the rows among `rows` that point at an entity that is gone are removed with their tombstones, and answered
 * as link id to the gone entity's id. Empty in a space that is not strict. A link's id derives from both ends, so a row that is there names the entity it
 * was written for.
 */
export async function takeBackLinksToGoneEntities(
  spaceId: string, rows: ReadonlyArray<{ _id: string; to: string; toKind: string; seq: number }>,
): Promise<Map<string, string>> {
  const toEntity = rows.filter(r => r.toKind === 'entity');
  if (toEntity.length === 0) return new Map();
  const gone = await goneEntityEnds(spaceId, toEntity.map(r => r.to));
  if (gone.size === 0) return new Map();
  // Only a row that is STILL stored: one a merge's settle re-keyed onto the survivor meanwhile is the survivor's now (not removed, not reported, no second
  // tombstone for an id the settle already buried).
  const stored = await readStoredById(spaceCollection(spaceId, 'links'), toEntity.filter(r => gone.has(r.to)).map(r => r._id), { _id: 1 });
  const taken = toEntity.filter(r => gone.has(r.to) && stored.has(r._id));
  await removeWithTombstones(spaceId, 'links', taken.map(r => ({ _id: r._id, type: 'link' as const, originalSeq: r.seq })), { filter: { spaceId } });
  return new Map(taken.map(r => [r._id, r.to]));
}

/**
 * The warning rows for links taken back because their entity was deleted while the record that carried them was written: one row per entity, the
 * `reason` starting with the code. THE one spelling, for every writer that carries links and answers `warnings` — the fact and chrono writers (through
 * {@link takenBackLinkWarnings}), the inline connections of a record write and a file's `linkEntities` — so the row reads the same whichever door wrote it.
 * Empty for no entities, so a caller adds it unconditionally.
 */
export function linkTargetRemovedWarnings(entityIds: readonly string[]): SchemaViolation[] {
  return entityIds.map(id => ({
    field: 'linkEntities', value: id,
    reason: `${LINK_TARGET_REMOVED}: the entity '${id}' was deleted while this record was written, so the link to it was not kept; the record itself is written.`,
  }));
}

/**
 * The door-side half of `link_target_removed`: the write's own `onValidation` channel (the one every door already renders as `warnings`, REST and MCP
 * alike), wrapped so the classification the planner hands back is remembered, and a warning row per taken-back entity is added to it once the commit
 * says which links were taken back. One function for the create and the update doors of every record that carries links, so the warning reads the same
 * on both surfaces and cannot be spelled twice. `onValidation` is what the planner is to be given; `announce` is called with the entity ids after the write.
 */
export function takenBackLinkWarnings(onValidation: ((check: UpdateValidation) => void) | undefined): {
  onValidation: ((check: UpdateValidation) => void) | undefined;
  announce: (entityIds: readonly string[]) => void;
} {
  let last: UpdateValidation | undefined;
  return {
    onValidation: onValidation ? (check) => { last = check; onValidation(check); } : undefined,
    announce(entityIds) {
      if (!onValidation || entityIds.length === 0) return;
      const base: UpdateValidation = last ?? { blocked: false, introduced: [], preExisting: [], all: [], warnings: [], message: '' };
      onValidation({ ...base, warnings: [...base.warnings, ...linkTargetRemovedWarnings(entityIds)] });
    },
  };
}

/**
 * `updateEdgeById`'s check after a patch that CHANGED an end's kind to entity: the edge as it now stands is taken back and `EndpointRemoved` is thrown
 * when the entity at either end is gone (no other update changes an end, so none asks). Nothing in a space that is not strict.
 */
export async function refuseEdgeToGoneEntity(spaceId: string, edge: EdgeToCheck): Promise<void> {
  const end = (await takeBackEdgesToGoneEntities(spaceId, [edge])).get(edge._id);
  if (end) throw new EndpointRemoved(end.id, end.side);
}
