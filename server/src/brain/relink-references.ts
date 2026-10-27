/**
 * Pointing what references one record at another — the edges and the links of a record that is about to be deleted in favour of a
 * survivor (bundle-81 slice I4; extracted from `brain/merge.ts` at the second site, the fork resolve).
 *
 * ## The question it answers
 *
 * "Every edge and link that names `absorbed` names `survivor` instead, and none is left naming a record that is about to go." Two doors ask it: the
 * entity merge (`executeMerge`: the absorbed entity's edges and the links that point at it) and Review's fork resolve (`brain/forks.ts`: the fork's
 * edges and the links on either side of it, to the parent). They differ in which links the record is on the end of — an entity is only ever a `to`
 * (`LinkClass`: nothing hangs off an entity), a fact is a `from` of entity links and a `to` of chrono and file links — and in nothing else, so the
 * kind is the one parameter ({@link RelinkKind}).
 *
 * ## What it prevents, and what is inside so no caller drops it
 *
 * - **The collision is decided by identity, not by id** ({@link storedEdgeIdentities}): an edge from before 3.6, or a peer's edge relinked in place, is
 *   stored under an id its identity does not derive, and looked up by id its collision is invisible. A relink whose identity the survivor already holds
 *   is a duplicate: deleted with its tombstone, never moved into the unique index.
 * - **An edge moves by re-key, and where the re-key declines (a peer authored it) it is written in place** — dropping that write would leave the edge
 *   pointing at the record this call's caller deletes. The write guard is dropped on the in-place write, never restamped.
 * - **A link is RE-KEYED**: its id derives from both ends. The old id gets a tombstone below the new row's version, and a row the survivor already
 *   holds is kept as it is, author included.
 * - **The embed queue is touched AFTER the commit** ({@link settleRekeyedEmbeds}); inside the transaction the worker would claim a job for an uncommitted
 *   edge, find nothing and delete the job. It is a function of this module so a caller cannot run the transaction and forget what follows it.
 *
 * Every function here runs inside the caller's transaction under the position floor (`inHeldTransaction`) and awaits nothing that is not the driver.
 */
import type { ClientSession } from 'mongodb';
import { col, asFilter, asBulk } from '../db/mongo.js';
import { versionsFor } from '../util/version-stamp.js';
import { withLandingStamp, localRow } from '../sync/record-position-stream.js';
import { writeInOneCommands } from '../db/one-command.js';
import { readStoredById } from '../db/read-by-id.js';
import { edgeIdFor } from './edge-id.js';
import { edgeEndpointKind } from './entity-refs.js';
import { linkIdFor } from './links.js';
import { rekeyEdges, embedQueueWorkFor, type EdgeRekey } from './edge-rekey.js';
import { enqueueWriteEmbedJobs, retireEmbedJobs, EMBED_PRIORITY } from './embed-queue.js';
import { removeWithTombstones } from './tombstones.js';
import { spaceCollection } from '../db/space-collection.js';
import { CHOSEN_VERSION_ROWS } from './chosen-versions.js';
import { remintForks, type ForkRepoint } from './forks.js';
import { rekeyedRow, UNSET_GUARD } from '../sync/local-only-fields.js';
import type { RefKind } from '../config/types-knowledge.js';
import type { EdgeDoc, LinkDoc } from '../config/types.js';

/** What kind of record is absorbed: it decides which links are on the end of it. */
export type RelinkKind = Extract<RefKind, 'entity' | 'fact' | 'chrono'>;

/**
 * The edges of a record, either end, FORK ROWS INCLUDED. ONE definition for what a record's removal must deal with: the fork resolve, and the entity delete's
 * guard and cascade (a fork edge ending at the record is a reference to it). A reader that means "the relationships of this record" asks
 * {@link relationshipEdgesOfRecord} instead.
 */
export function edgesOfRecord(spaceId: string, id: string) {
  return asFilter<EdgeDoc>({ spaceId, $or: [{ from: id }, { to: id }] });
}

/**
 * The relationships of a record, either end: {@link edgesOfRecord} without the unchosen versions (`CHOSEN_VERSION_ROWS`). What a merge's plan, its detection and its
 * relink read: a fork edge is not a second relationship of the record, so it is no duplicate, no endpoint-rule break and no contradiction of its subject (Q-624,
 * design rev 4 section 6). The clause is inside, so no detection can drop it.
 */
export function relationshipEdgesOfRecord(spaceId: string, id: string) {
  return asFilter<EdgeDoc>({ spaceId, $or: [{ from: id }, { to: id }], ...CHOSEN_VERSION_ROWS });
}

/**
 * The links on the end of a record. An entity is only a `to`; a fact is the `from` of its entity links and the `to` of the chrono and file links that
 * name it. Never the links an entity or a fact HOLDS as array fields: those are the deprecated 4.x spellings, refused on write.
 */
export function linksOfRecord(spaceId: string, id: string, kind: RelinkKind) {
  // A chrono entry is the `from` of its links, as a fact is (Q-624: a chrono fork resolved moves its links to the parent). An entity is a `to`; a link
  // FROM one is written by no door, and is moved too when one arrived (a peer's link from a fork entity).
  return kind === 'entity'
    ? asFilter<LinkDoc>({ spaceId, $or: [{ to: id, toKind: 'entity' }, { from: id, fromKind: 'entity' }] })
    : asFilter<LinkDoc>({ spaceId, $or: [{ from: id, fromKind: kind }, { to: id, toKind: kind }] });
}

/** How many identities one collision read asks for: an `$or` of this many exact tuples. */
const IDENTITIES_PER_READ = 200;

/**
 * Which of the identities a relink would produce are already held by a stored edge — as `edgeIdFor` keys.
 *
 * Read by the five identity fields, never by `_id` (see the module docblock), and only for the tuples asked: the cost is the relink's, not the
 * survivor's degree. An absent kind is stored for an entity end, so an `entity` end matches both. A fork edge holding the tuple is not a holder: it would
 * mark its own subject a duplicate (Q-624), so the read carries `CHOSEN_VERSION_ROWS` itself.
 */
async function storedEdgeIdentities(
  edgeColl: ReturnType<typeof col<EdgeDoc>>, spaceId: string,
  relinked: ReadonlyArray<{ edge: EdgeDoc; from: string; to: string }>, session: ClientSession,
): Promise<Set<string>> {
  const kindIs = (k: string | undefined): unknown => (edgeEndpointKind(k as RefKind | undefined) === 'entity' ? { $in: [null, 'entity'] } : k);
  // The dedupe the collision rule rests on: one key per identity, however many stored edges hold it.
  const keys: Set<string> = new Set();
  for (let i = 0; i < relinked.length; i += IDENTITIES_PER_READ) {
    const tuples = relinked.slice(i, i + IDENTITIES_PER_READ).map(r => ({
      from: r.from, to: r.to, label: r.edge.label, fromKind: kindIs(r.edge.fromKind), toKind: kindIs(r.edge.toKind),
    }));
    const found = await edgeColl
      .find(asFilter<EdgeDoc>({ spaceId, $or: tuples, ...CHOSEN_VERSION_ROWS }),
        { session, projection: { _id: 1, from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 } })
      .toArray() as EdgeDoc[];
    for (const e of found) keys.add(edgeIdFor(e.from, e.to, e.label, e.fromKind, e.toKind));
  }
  return keys;
}

/** What the edge half wrote, for the steps that run once the transaction has committed. */
export interface EdgeRelink {
  rekeyed: EdgeRekey[];
  deletedDuplicateEdgeIds: string[];
}

/**
 * Every edge of `absorbedId` now ends at `survivorId`: a duplicate (the survivor already holds that identity) is deleted with its tombstone, the rest
 * are re-keyed onto the id their new identity derives, or written in place where the re-key declines (an edge a peer authored, unless `moveForeign`:
 * the fork resolve moves those too, see `rekeyEdges`).
 */
export async function relinkEdgesOfRecord(
  spaceId: string, { absorbedId, survivorId, moveForeign = false }: { absorbedId: string; survivorId: string; moveForeign?: boolean },
  { now, session }: { now: string; session: ClientSession },
): Promise<EdgeRelink> {
  const edgeColl = col<EdgeDoc>(spaceCollection(spaceId, 'edges'));
  // WITH their vectors: a re-key carries the stored document across, embedding included (`rekeyEdges`). The ids first, then the documents by id in
  // chunks: inside the transaction a read must come back in one batch (`db/write-bound.ts`), and a hub's edges with their vectors are far more than one batch holds.
  const ids = (await edgeColl
    .find(relationshipEdgesOfRecord(spaceId, absorbedId), { session, projection: { _id: 1 } })
    .toArray() as Array<Pick<EdgeDoc, '_id'>>).map(e => e._id);
  const edges = [...(await readStoredById<EdgeDoc>(spaceCollection(spaceId, 'edges'), ids, 'carried', { session })).values()];
  const relinked = edges.map(edge => ({
    edge,
    from: edge.from === absorbedId ? survivorId : edge.from,
    to: edge.to === absorbedId ? survivorId : edge.to,
  }));

  /*
   * Collisions are found by IDENTITY, keyed through `edgeIdFor` because it length-prefixes each part (a joined string collides two relationships the
   * moment a label holds the separator). And only the identities the relink PRODUCES are looked up — at most the caller's bound — never the survivor's
   * whole edge set (bundle-30 I8): a survivor hub of eighty thousand edges was read inside the transaction, past the one batch a read there may take.
   */
  const survivorKeys = await storedEdgeIdentities(edgeColl, spaceId, relinked, session);
  const duplicates: EdgeDoc[] = [];
  const toRelink: typeof relinked = [];
  for (const r of relinked) {
    const postKey = edgeIdFor(r.from, r.to, r.edge.label, r.edge.fromKind, r.edge.toKind);
    // A survivor edge holds this identity, or an absorbed edge relinked earlier in this loop now does: the absorbed one is a duplicate, deleted with
    // its tombstone rather than relinked into the unique index.
    if (survivorKeys.has(postKey)) duplicates.push(r.edge);
    else { toRelink.push(r); survivorKeys.add(postKey); }
  }

  // The duplicates: one delete, and their tombstones in one block, each carrying the seq of the edge it deletes.
  await removeWithTombstones(spaceId, 'edges',
    duplicates.map(e => ({ _id: e._id, type: 'edge' as const, deletedAt: now, originalSeq: e.seq })), { session });

  /*
   * RE-KEYED rather than `$set`: relinking an endpoint changes what the edge IS, and its `_id` is derived from its identity — a `$set` left it under an id
   * the identity no longer derived, and the next peer to create that relationship inserted and hit the unique index instead of converging. `rekeyEdges`
   * owns the delete-and-insert, the tombstones, and the seq ordering that makes one safe on a synced collection.
   *
   * Where it declines (`null`) the endpoints are written IN PLACE: an edge a PEER authored is not moved (its copy would refuse our tombstone and hold
   * two rows), and dropping the write would leave the edge pointing at the record this relink's caller deletes.
   */
  const moved = await rekeyEdges(spaceId, toRelink.map(r => ({ existing: r.edge, next: { from: r.from, to: r.to } })),
    { updatedAt: now }, [], session, undefined, { moveForeign });
  const inPlace = toRelink.filter((_, i) => moved[i] === null);
  if (inPlace.length > 0) {
    // A relink moves `from`, and the write guard (`_functionalGuard`, cleared by `UNSET_GUARD`) is a function of `(from, label)`: it is DROPPED, never
    // restamped, so a relink — which reports a functional breach and never refuses one — can never fail on the guard index (`Q-439`). The re-key above
    // drops it inside `rekeyedRow`; this is the in-place twin, whoever authored the edge. A hub's count is the store's, so the write is sliced to one
    // command each (`db/one-command.ts`), inside the one hold. `ordered: true`: the transaction is aborted at the first error, so going on would only
    // send it into a dead transaction and bury the real failure.
    const versions = await versionsFor(spaceId, inPlace.map(r => r.edge._id), { parts: ['edges'], session });
    await withLandingStamp(spaceId, versions.map(v => localRow(v.version)), (patches) => writeInOneCommands(inPlace.map((r, i) => {
      const updates: Record<string, unknown> = { updatedAt: now, ...patches[i]! };
      if (r.edge.from === absorbedId) updates['from'] = survivorId;
      if (r.edge.to === absorbedId) updates['to'] = survivorId;
      return { updateOne: { filter: { _id: r.edge._id }, update: { $set: updates, $unset: UNSET_GUARD } } };
    }), (slice, { ordered }) => edgeColl.bulkWrite(asBulk<EdgeDoc>(slice), { ordered, session }), { ordered: true }), 'relink.edge');
  }

  /*
   * The FORK edges of the absorbed record follow what their subject became (Q-624, design rev 4 §7): the re-keyed id, the surviving holder when the
   * subject was deleted as a duplicate, or the subject's own id when it was written in place. They were partitioned out of the read above (a fork is
   * not a relationship of the record), and they are never edited in place: `remintForks` inserts each under an id that derives from its new subject,
   * version and body, and removes the old id behind a tombstone, in this transaction. Past the fork cap it throws, and the transaction writes nothing.
   */
  const forkEdges = await edgeColl.find(asFilter<EdgeDoc>({ spaceId, $or: [{ from: absorbedId }, { to: absorbedId }], forkOf: { $exists: true } }),
    { session, projection: { _id: 1, forkOf: 1, from: 1, to: 1, label: 1 } }).toArray() as unknown as Array<Pick<EdgeDoc, '_id' | 'from' | 'to' | 'label'> & { forkOf: string }>;
  if (forkEdges.length > 0) {
    const becameOf = new Map<string, string>();
    toRelink.forEach((r, i) => becameOf.set(r.edge._id, moved[i]?.edge._id ?? r.edge._id));
    for (const d of duplicates) {
      const from = d.from === absorbedId ? survivorId : d.from;
      const to = d.to === absorbedId ? survivorId : d.to;
      const holder = await edgeColl.findOne(asFilter<EdgeDoc>({ spaceId, from, to, label: d.label, ...CHOSEN_VERSION_ROWS }), { session, projection: { _id: 1 } });
      if (holder) becameOf.set(d._id, holder._id);
    }
    const repoints = new Map<string, ForkRepoint>();
    for (const f of forkEdges) {
      if (repoints.has(f.forkOf)) continue;
      repoints.set(f.forkOf, {
        oldSubject: f.forkOf, newSubject: becameOf.get(f.forkOf) ?? f.forkOf,
        patch: { ...(f.from === absorbedId ? { from: survivorId } : {}), ...(f.to === absorbedId ? { to: survivorId } : {}) },
      });
    }
    await remintForks(spaceId, 'edge', [...repoints.values()], { session, now });
  }
  return { rekeyed: moved.filter((m): m is EdgeRekey => m !== null), deletedDuplicateEdgeIds: duplicates.map(e => e._id) };
}

/**
 * Every link on the end of `absorbedId` now ends at `survivorId`. **A link is RE-KEYED, not updated**: its `_id` is derived from both endpoints
 * (`linkIdFor`), so moving one end changes the identity. **The old id gets a TOMBSTONE**, or the next pull from any peer still holding it re-creates the
 * link pointing at the record that is deleted. The survivor may ALREADY hold the connection: that row is kept as it is, author included, and only the
 * absorbed one goes — two rows describing one connection is what the derived id exists to prevent, and overwriting the survivor's row would hand its
 * authorship to whoever wrote the absorbed one.
 */
export async function relinkLinksOfRecord(
  spaceId: string, { absorbedId, survivorId, kind }: { absorbedId: string; survivorId: string; kind: RelinkKind },
  { now, session }: { now: string; session: ClientSession },
): Promise<void> {
  const linkColl = col<LinkDoc>(spaceCollection(spaceId, 'links'));
  const affected = await linkColl.find(linksOfRecord(spaceId, absorbedId, kind), { session }).toArray() as LinkDoc[];
  if (affected.length === 0) return;
  const moves = affected.map(link => {
    const from = link.from === absorbedId ? survivorId : link.from;
    const to = link.to === absorbedId ? survivorId : link.to;
    return { link, from, to, newId: linkIdFor(from, link.fromKind, to, link.toKind) };
  });
  const held = await readStoredById<{ _id: string }>(spaceCollection(spaceId, 'links'), moves.map(m => m.newId), { _id: 1 }, { session });
  const fresh = moves.filter(m => !held.has(m.newId));
  // The old rows' tombstones BELOW the new rows' seqs — the re-key's order (`edge-rekey.ts`).
  await removeWithTombstones(spaceId, 'links',
    moves.map(({ link }) => ({ _id: link._id, type: 'link' as const, deletedAt: now, originalSeq: link.seq })),
    { session, filter: { spaceId } });
  if (fresh.length === 0) return;
  // Stamped after the tombstones above, so every new row's version is above every tombstone's (the re-key's order, `edge-rekey.ts`).
  const versions = await versionsFor(spaceId, fresh.map(m => m.newId), { parts: ['links'], session });
  await withLandingStamp(spaceId, versions.map(v => localRow(v.version)), (patches) => writeInOneCommands(fresh.map(({ link, from, to, newId }, i) => ({
    replaceOne: {
      filter: { _id: newId, spaceId },
      // `rekeyedRow`: a link under a NEW id is a record this instance wrote, stamped as nobody's delivery, with none of the old row's position.
      replacement: rekeyedRow(link, { _id: newId, from, to, updatedAt: now, ...patches[i]! }),
      upsert: true,
    },
  })), (slice, { ordered }) => linkColl.bulkWrite(asBulk<LinkDoc>(slice), { ordered, session }), { ordered: true }), 'relink.link');
}

/**
 * The embed-queue work the re-keyed edges leave, run once the transaction has COMMITTED: retire the old ids' jobs, enqueue the new ones. Relinking changes
 * an edge's embed text either way, because it is built from the endpoint NAMES. Batched, and on the background lane: a hub's thousands of re-embeds must
 * not queue ahead of the writes people are waiting on. A failure to retire is `onRetireFailure`'s to say and never thrown: the relink is stored, and
 * reporting it failed would invite a retry of a change whose absorbed record no longer exists.
 */
export async function settleRekeyedEmbeds(
  spaceId: string, rekeyed: readonly EdgeRekey[], onRetireFailure: (err: unknown) => void,
): Promise<void> {
  if (rekeyed.length === 0) return;
  try {
    await retireEmbedJobs(spaceId, 'edge', rekeyed.map(m => embedQueueWorkFor(m).retire));
  } catch (err) {
    onRetireFailure(err);
  }
  await enqueueWriteEmbedJobs(spaceId, rekeyed.map(m => ({ recordType: 'edge' as const, recordId: embedQueueWorkFor(m).enqueue })),
    { priority: EMBED_PRIORITY.background });
}
