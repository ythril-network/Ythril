/**
 * Review's forks: the list of them and the resolve of one, for both doors (bundle-81, design rev 8 section 5, decisions 19, 43, 44, 64).
 *
 * ## What a fork is, and why Review reads it
 *
 * Two copies of a fact that carry ONE version and DIFFERENT text cannot both be the fact: sync keeps the second as a fork — a fact under a derived id
 * (`forkIdFor`) whose `forkOf` names the first, its parent — rather than choose silently (D-23). Until this module nothing read a fork and nothing
 * resolved one, so the pair stayed for ever and the dropped third copy (`forkRefused`, at {@link MAX_FORKS_PER_RECORD}) was only a log line.
 *
 * ## The question each function answers
 *
 *  - {@link listForks}: "which forks does this space hold, each beside its parent, and what points at each?" A row is
 *    `{ forkId, parentId, fork, parent, edgeCount, linkCount, siblings }`; the page is `{ forks, total, skip, limit, maxForksPerRecord }`.
 *    A fork whose parent is gone is not listed (it is an ordinary fact now; there is nothing to choose between).
 *  - {@link resolveFork}: "keep one side": the kept body is written as a LOCAL EDIT of the parent id, stamped above both versions; the fork is deleted
 *    behind a tombstone this instance issues (`issuedHere`, so mesh peers receive the deletion); and every edge and link that named the fork names
 *    the parent (`brain/relink-references.ts`, the merge's relink).
 *
 * ## What it prevents, and what is inside so no door drops it
 *
 * - **Content is never lost to a half-done resolve.** The parent is written FIRST: if the transaction after it fails the fork is still stored and the
 *   retry resolves it again (the parent write is the same body). Written the other way round, a failure between the delete and the edit would lose the
 *   text the caller chose to keep.
 * - **One set of refusals.** Every refusal is a {@link ForkRefusal} with one sentence; REST answers it with its status, MCP throws the same sentence
 *   (so the caps and the words are not two copies the doors can drift on). `keep` and the paging parameters are checked here, never in a door's schema
 *   (a schema `enum` or `maximum` would say it in the validator's words on one door and ours on the other).
 * - **A resolve is one transaction under the position floor** (`inHeldTransaction`), so no reader is paged past the relink and the delete before they commit.
 */
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { admitSpaceWrite } from '../spaces/space-write-gate.js';
import { inHeldTransaction } from './held-transaction.js';
import { removeWithTombstones } from './tombstones.js';
import { updateFact } from './fact.js';
import { retireEmbedJob } from './embed-queue.js';
import { LANDING_ORDER } from './list-sort.js';
import { listReadMaxMs } from './tag-filter.js';
import { NEVER_RETURNED_PROJECTION, withoutVector } from './read-projection.js';
import { linksPointingAt, linksStartingFrom } from './link-adjacency.js';
import { edgesOfRecord, relinkEdgesOfRecord, relinkLinksOfRecord, settleRekeyedEmbeds } from './relink-references.js';
import { MAX_FORKS_PER_RECORD } from '../sync/upsert-plan.js';
import { limitRefusal, skipRefusal } from '../util/strict-limit.js';
import { z } from 'zod';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import { log, peerText, refusalOfParse } from '../util/log.js';
import type { EdgeDoc, FactDoc } from '../config/types.js';

export { MAX_FORKS_PER_RECORD };

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
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'ForkRefusal';
  }
}

/** The fields of a fact a Review row shows: what two versions are compared by, and who wrote each. Never a vector or a landing position. */
const VERSION_FIELDS = ['_id', 'type', 'fact', 'description', 'tags', 'properties', 'author', 'createdAt', 'updatedAt'] as const;
const VERSION_PROJECTION: Record<string, 1> = Object.fromEntries(VERSION_FIELDS.map(f => [f, 1 as const]));

type Version = Partial<Pick<FactDoc, (typeof VERSION_FIELDS)[number]>> & { _id: string };

/** One row of the list: a fork beside its parent, with what points at the fork and how many forks the parent holds. */
export interface ForkRow {
  forkId: string;
  parentId: string;
  fork: Version;
  parent: Version;
  edgeCount: number;
  linkCount: number;
  siblings: number;
}

export interface ForkPage {
  forks: ForkRow[];
  /** Every fork of the space that has a parent, not only this page's. */
  total: number;
  skip: number;
  limit: number;
  /** The most forks one record may hold: at it, the next differing copy of that record is dropped. */
  maxForksPerRecord: number;
}

/**
 * The list's parameters: what BOTH doors validate a `skip` and a `limit` by, and what `a-tool-and-its-route-agree-on-bounds` reads the route's bounds from.
 * Declared beside the tool's schema's bounds (1 to {@link MAX_FORK_PAGE}, from 0), so a door cannot state a number the other does not.
 */
export const ForkListParams = z.object({
  skip: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_FORK_PAGE).optional(),
});

/** The resolve's parameters, the same way: a non-empty fork id and a `keep`, which {@link parseKeep} judges. */
export const ForkResolveParams = z.object({
  forkId: z.string().min(1),
  keep: z.string(),
});

/**
 * A query string's text is a number to the schema above only when it is a whole one: an absent or empty value is absent, a JSON number stays itself,
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

/** What points at a fork: its edges (either end) and the links on either side of it. */
async function referencesTo(spaceId: string, forkId: string): Promise<{ edgeCount: number; linkCount: number }> {
  // The links through the link module's two readers (a link row is theirs to describe), narrowed to the fact end: ids are unique per collection only.
  const [edgeCount, pointing, starting] = await Promise.all([
    col<EdgeDoc>(spaceCollection(spaceId, 'edges')).countDocuments(edgesOfRecord(spaceId, forkId)),
    linksPointingAt(spaceId, [forkId]), linksStartingFrom(spaceId, [forkId]),
  ]);
  return { edgeCount, linkCount: pointing.filter(l => l.toKind === 'fact').length + starting.filter(l => l.fromKind === 'fact').length };
}

/**
 * One page of the space's forks, newest landing first, each with its parent. The paging is the brain lists' (`skip`, `limit`), with the caps
 * refused rather than clamped (`util/strict-limit.ts`).
 */
export async function listForks(spaceId: string, opts: { skip?: unknown; limit?: unknown }): Promise<ForkPage> {
  const asked = ForkListParams.safeParse({ skip: asNumber(opts.skip), limit: asNumber(opts.limit) });
  if (!asked.success) {
    // The words are the shared ones (`util/strict-limit.ts`): the sentence for a value that is no whole number is the sentence for any value out of bounds.
    const field = refusalOfParse(asked.error).issues[0]?.path[0];
    throw new ForkRefusal(400, (field === 'skip' ? skipRefusal(Number.NaN) : limitRefusal(Number.NaN, MAX_FORK_PAGE)) ?? 'the paging parameters are not whole numbers');
  }
  const skip = asked.data.skip ?? 0;
  const limit = asked.data.limit ?? DEFAULT_FORK_PAGE;
  const facts = col<FactDoc>(spaceCollection(spaceId, 'facts'));
  const [page] = await facts.aggregate<{ rows: Array<Version & { forkOf: string; parent: Version[] }>; total: Array<{ n: number }> }>([
    { $match: { forkOf: { $exists: true } } },
    { $lookup: { from: spaceCollection(spaceId, 'facts'), localField: 'forkOf', foreignField: '_id', as: 'parent', pipeline: [{ $project: VERSION_PROJECTION }] } },
    { $match: { 'parent.0': { $exists: true } } },
    { $sort: { ...LANDING_ORDER } },
    { $facet: {
      rows: [{ $skip: skip }, { $limit: limit }, { $project: { ...VERSION_PROJECTION, forkOf: 1, parent: 1 } }],
      total: [{ $count: 'n' }],
    } },
  ], { maxTimeMS: listReadMaxMs(false) }).toArray();
  const rows = page?.rows ?? [];
  const parentIds = [...new Set(rows.map(r => r.forkOf))];
  const siblings = new Map<string, number>();
  if (parentIds.length > 0) {
    const groups = await facts.aggregate<{ _id: string; n: number }>([
      { $match: { forkOf: { $in: parentIds } } },
      { $group: { _id: '$forkOf', n: { $sum: 1 } } },
    ], { maxTimeMS: listReadMaxMs(false) }).toArray();
    for (const g of groups) siblings.set(g._id, g.n);
  }
  const forks: ForkRow[] = [];
  for (const r of rows) {
    const { forkOf, parent, ...fork } = r;
    forks.push({
      forkId: r._id, parentId: forkOf, fork: fork as Version, parent: parent[0]!,
      ...await referencesTo(spaceId, r._id), siblings: siblings.get(forkOf) ?? 1,
    });
  }
  return { forks, total: page?.total[0]?.n ?? 0, skip, limit, maxForksPerRecord: MAX_FORKS_PER_RECORD };
}

/** What a resolve answers: which side was kept, which record holds it now, and what was repointed. */
export interface ForkResolution {
  resolved: true;
  keep: ForkKeep;
  forkId: string;
  parentId: string;
  /** The parent as it is stored now, without its vector. */
  parent: FactDoc;
  edgesRepointed: number;
  linksRepointed: number;
}

/** The properties of the parent the fork lacks, as `deleteFields` paths: a keep of the fork replaces the body, and a merge of properties alone would leave them. */
function propertyPathsToRemove(parent: Version, fork: Version): string[] {
  const kept = new Set(Object.keys(fork.properties ?? {}));
  return Object.keys(parent.properties ?? {}).filter(k => !kept.has(k)).map(k => `properties.${k}`);
}

/**
 * Keep one side of a fork. `keep: 'fork'` writes the fork's body onto the parent id; `keep: 'parent'` leaves the parent's body and still writes it, so
 * the parent is stamped above both versions either way — a peer holding either copy of the parent then takes this one as the newer. The fork is then
 * deleted with a tombstone this instance issues, and what pointed at it points at the parent.
 *
 * Refused (all with {@link ForkRefusal}): `keep` neither side (400); no such record (404); the record is no fork (409); the fork's parent is not stored
 * (409: its text is the only copy, edit or delete it as the ordinary fact it is).
 */
export async function resolveFork(spaceId: string, forkIdRaw: unknown, keepRaw: unknown, actor?: WebhookActor): Promise<ForkResolution> {
  const asked = ForkResolveParams.safeParse({ forkId: forkIdRaw, keep: keepRaw });
  if (!asked.success) {
    // `keep` first: a call that sends neither is told about the side it must name, as it was before the schema.
    throw new ForkRefusal(400, refusalOfParse(asked.error).issues.some(i => i.path[0] === 'keep') ? KEEP_REFUSAL : 'forkId must be a non-empty string');
  }
  const keep = parseKeep(asked.data.keep);
  const forkId = asked.data.forkId;
  const facts = col<FactDoc>(spaceCollection(spaceId, 'facts'));
  const fork = await facts.findOne({ _id: forkId, spaceId } as never, { projection: NEVER_RETURNED_PROJECTION }) as FactDoc | null;
  if (!fork) throw new ForkRefusal(404, `No fork '${peerText(forkId)}' in space '${peerText(spaceId)}'`);
  if (fork.forkOf === undefined) throw new ForkRefusal(409, `Fact '${peerText(forkId)}' is not a fork, so there is nothing to resolve`);
  const parentId = fork.forkOf;
  const parent = await facts.findOne({ _id: parentId, spaceId } as never, { projection: NEVER_RETURNED_PROJECTION }) as FactDoc | null;
  if (!parent) {
    throw new ForkRefusal(409, `The parent '${peerText(parentId)}' of fork '${peerText(forkId)}' is not stored, so there is nothing to choose between: the fork is an ordinary fact now`);
  }
  const before = await referencesTo(spaceId, forkId);

  // ── 1. The kept body, as a local edit of the parent, above both versions ───────────────────────────────────────────────────────────────
  // FIRST: a failure after this leaves the fork stored and the retry writes the same body again; the other order could lose the kept text.
  const updates: Parameters<typeof updateFact>[2] = {};
  let removals: string[] | undefined;
  if (keep === 'fork') {
    updates.fact = fork.fact;
    updates.tags = fork.tags ?? [];
    if (fork.description !== undefined) updates.description = fork.description;
    if (fork.properties !== undefined && Object.keys(fork.properties).length > 0) updates.properties = fork.properties;
    // An empty string CLEARS a type (`updateFact`): a fork with none leaves the parent with none.
    if (fork.type !== undefined || parent.type !== undefined) updates.type = fork.type ?? '';
    removals = [
      ...(fork.description === undefined && parent.description !== undefined ? ['description'] : []),
      ...propertyPathsToRemove(parent, fork),
    ];
    // A property key with a dot cannot be named by a path, so it could not be removed: refused before anything is written, not half applied.
    const dotted = Object.keys(parent.properties ?? {}).find(k => !Object.keys(fork.properties ?? {}).includes(k) && k.includes('.'));
    if (dotted !== undefined) {
      throw new ForkRefusal(409, `The parent's property '${peerText(dotted)}' has a dot in its name and cannot be removed by a path, so the fork's body cannot replace it whole; edit it first`);
    }
  }
  const written = await updateFact(spaceId, parentId, updates, removals && removals.length > 0 ? removals : undefined,
    actor, undefined, undefined, undefined, fork.seq);
  if (!written) throw new ForkRefusal(409, `The parent '${peerText(parentId)}' of fork '${peerText(forkId)}' changed while it was being resolved; resolve it again`);

  // ── 2. What named the fork names the parent, and the fork goes behind a tombstone this instance issues ─────────────────────────────────
  const now = new Date().toISOString();
  const forkTombstone = { _id: forkId, type: 'fact' as const, deletedAt: now, originalSeq: fork.seq };
  const relinked = await inHeldTransaction(spaceId, 'fork.resolve',
    (session) => admitSpaceWrite(spaceId, undefined, async () => {
      const edges = await relinkEdgesOfRecord(spaceId, { absorbedId: forkId, survivorId: parentId, moveForeign: true }, { now, session });
      await relinkLinksOfRecord(spaceId, { absorbedId: forkId, survivorId: parentId, kind: 'fact' }, { now, session });
      await removeWithTombstones(spaceId, 'facts', [forkTombstone], { session });
      return edges;
    }),
    // A commit whose answer was lost may have landed: the fork being gone IS the commit.
    { landed: async () => (await facts.countDocuments({ _id: forkId } as never, { limit: 1 })) === 0 });

  // After the commit: the queue takes no session (see `settleRekeyedEmbeds`), and the fork's own job has nothing left to embed.
  await retireEmbedJob(spaceId, 'fact', forkId);
  await settleRekeyedEmbeds(spaceId, relinked.rekeyed, (err) => {
    log.warn(`fork resolve: '${peerText(forkId)}' was resolved into '${peerText(parentId)}' in '${peerText(spaceId)}', but the embed jobs of `
      + `${relinked.rekeyed.length} re-keyed edge(s) were not retired: ${peerText(err)}`);
  });
  if (actor) {
    emitWebhookEvent({ event: 'fact.deleted', spaceId, entry: { _id: forkId }, ...actor });
    for (const id of relinked.deletedDuplicateEdgeIds) emitWebhookEvent({ event: 'edge.deleted', spaceId, entry: { _id: id }, ...actor });
  }
  return {
    resolved: true, keep, forkId, parentId, parent: withoutVector(written),
    edgesRepointed: before.edgeCount, linksRepointed: before.linkCount,
  };
}
