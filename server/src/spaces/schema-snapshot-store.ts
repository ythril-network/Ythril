/**
 * Every schema version a space's server has used is kept as a row of a PRIVATE per-space collection, `<space>_schema_snapshots`, named by its
 * fingerprint (Q-735, bundle-265). This module writes the rows; `schema-stamp.ts` says what a fingerprint is.
 *
 * ## Why a collection and not a file
 *
 * The 6.5 writer put one file per type under `schemas/` in the space. A file is visible and writable through the Files area, enters the files
 * family's rows, hashes, sync and tombstones, and every file name is one a user can create. A collection has none of that, and `_id` = the
 * fingerprint makes "write once" one upsert. The collection is no brain family (`BRAIN_COLLECTIONS`), so no sync door serves it, Merkle never
 * reads it and the files wipe never touches it; it is per space, so a space delete drops it and a rename moves it with the prefix walks, and a
 * database backup carries it.
 *
 * ## What a row is
 *
 * `{ _id: fp, text, origin, networkId?, from?, links, at, orphanSince? }`: `text` is the canonical schema text the fingerprint is the hash of.
 * `origin` says how this server came to hold it: `own` (a variation of the space this server ran), `layer` (a network's layer as received;
 * `links: null`, because this server cannot know what the upstream built it from) or `fetched` (from a peer, with `from`). An own row's `links`
 * say what the variation was built from: the own definitions' fingerprint, each layer received and what this server serves each network.
 * Content-addressed, so a row's text never changes: a second write of the same text keeps the first row. Two things do change, by rule:
 *
 * - `orphanSince`, the mark the snapshot sweep (`schema-snapshot-sweep.ts`) sets when it first finds the row unused, and removes the row a
 *   grace after; every writer that makes the version current or a held layer clears it, whatever the held cache says.
 * - The origin, when a version kept as `fetched` (or `own`) becomes current or a held layer: that writer rewrites `origin`, `networkId` and
 *   `links` to its own (`from` goes), so a version an import or a fetch landed first is served and kept as what it now is. A `layer` row is
 *   never rewritten: it is the network history the behind hint reads.
 *
 * **"Don't copy, just use"**: a variation that adds nothing to a layer has the layer's text and so the layer's fingerprint, and writes no own row.
 *
 * ## Who writes, and how
 *
 * `updateSpace` (the one funnel of effective-meta writes), `storeNetworkLayer`, `createSpace`, a library save (each space linking the saved
 * entry), the housekeeping cycle (the current variation and every layer of every space; it also repairs a row lost to a failed write), and the
 * per-write backstop (a stamping write whose fingerprint has no known row, `stampOp`). Every write asks the space's write gate
 * (`admitSpaceWrite`, every family): a space an act stands on gets nothing now and the cycle writes the row once the act is gone. Every write
 * but the cycle's is detached: a write never waits for its snapshot, and a failure is reported through the shared reporter, never thrown at
 * the write that asked.
 */
import type { Collection } from 'mongodb';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { detachedWrite } from '../db/write-bound.js';
import { isDuplicateKey } from '../db/write-errors.js';
import { getConfig } from '../config/loader.js';
import { isOverSnapshotCap } from './schema-snapshot.js';
import { admitSpaceWrite, isActRefusal } from './space-write-gate.js';
import { configuredSpaces } from './space-lookup.js';
import { libraryUsages } from './library-usages.js';
import {
  variationOf, layerStampOf, knownHeld, noteHeld, forgetHeld, heldGeneration,
  type SnapshotLinks, type Stamp,
} from './schema-stamp.js';
import type { SpaceMeta } from '../config/types.js';
import { eachSpace } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { warnOnce } from '../util/warn-once.js';
import { schemaSnapshotTotal } from '../metrics/schema-snapshot-count.js';
import { log, peerText } from '../util/log.js';


/** The name the cycle's step, and every failure of a snapshot write, is reported under. */
export const SCHEMA_SNAPSHOT_STEP = declareStep('Schema snapshots');

export type SnapshotOrigin = 'own' | 'layer' | 'fetched';

/** How a row is kept: everything of it but the text and the time. */
export interface KeptAs {
  origin: SnapshotOrigin;
  networkId?: string;
  from?: string;
  links: SnapshotLinks | null;
}

/** A row of `<space>_schema_snapshots`. */
export interface SnapshotRow extends KeptAs {
  _id: string;
  text: string;
  at: string;
  /** The ISO time of the sweep pass that first found the row unused; absent while it is used. */
  orphanSince?: string;
}

export const snapshots = (spaceId: string): Collection<SnapshotRow> => col<SnapshotRow>(spaceCollection(spaceId, 'schemaSnapshots'));

const overCapSaid = warnOnce<string>();

/**
 * Write the row of `stamp` in `spaceId` unless it is there: one upsert that inserts and never rewrites. A concurrent writer's duplicate key is
 * the row being there. `refused` when an act stands on the space (the cycle writes it later); anything else the store answers is thrown.
 */
export async function ensureSnapshot(spaceId: string, stamp: Stamp, kept: KeptAs): Promise<'written' | 'held' | 'refused'> {
  if (knownHeld(spaceId, stamp.fp)) return 'held';
  if (isOverSnapshotCap(stamp.text)) {
    overCapSaid(`${spaceId}:${stamp.fp}`, () => log.warn(`Schema snapshot ${peerText(stamp.fp)} of space '${peerText(spaceId)}' is larger than a peer `
      + 'takes: it is kept here, and no member can fetch it'));
  }
  const row: Omit<SnapshotRow, '_id'> = {
    text: stamp.text, origin: kept.origin,
    ...(kept.networkId !== undefined ? { networkId: kept.networkId } : {}),
    ...(kept.from !== undefined ? { from: kept.from } : {}),
    links: kept.links, at: new Date().toISOString(),
  };
  // Read before the upsert: a forgetHeld (the sweep removing the row) while it is in flight moves it, and the row is then not noted held.
  const generation = heldGeneration(spaceId);
  try {
    const done = await admitSpaceWrite(spaceId, undefined, () =>
      snapshots(spaceId).updateOne(asFilter<SnapshotRow>({ _id: stamp.fp }), { $setOnInsert: row }, { upsert: true }));
    // A row that was there already is not a snapshot written; a fetched one is counted `fetched`, whoever it came from.
    if (done.upsertedCount > 0) schemaSnapshotTotal.note(kept.origin === 'fetched' ? 'fetched' : 'written');
  } catch (err) {
    if (isActRefusal(err)) return 'refused';
    if (!isDuplicateKey(err)) throw err;
  }
  if (heldGeneration(spaceId) === generation) noteHeld(spaceId, stamp.fp);
  return 'written';
}

/** The rows a writer of a version that is current or a held layer claims: one whose origin is not `kept`'s (a `layer` row never), or one that is marked. */
const claimFilters = (fp: string, kept: KeptAs): [Record<string, unknown>, Record<string, unknown>] => [
  { _id: fp, origin: { $nin: [kept.origin, 'layer'] } },
  { _id: fp, orphanSince: { $exists: true } },
];

/**
 * Claim the row of `stamp` for a version that is current or a held layer now (design r3 D-upgrade and S-6): a row whose origin is not `kept`'s takes
 * `kept`'s origin, network and links (the text is equal by its hash; `from` goes), and a mark the sweep set is cleared. Both whatever the held cache
 * says, both conditional, in one round trip through the write gate. An act standing on the space: nothing now, and the cycle claims it later.
 */
async function claimKept(spaceId: string, stamp: Stamp, kept: KeptAs): Promise<void> {
  const [wrongOrigin, marked] = claimFilters(stamp.fp, kept);
  const $set = { origin: kept.origin, links: kept.links, ...(kept.networkId !== undefined ? { networkId: kept.networkId } : {}) };
  const $unset = { from: '' as const, ...(kept.networkId === undefined ? { networkId: '' as const } : {}) };
  try {
    await admitSpaceWrite(spaceId, undefined, () => snapshots(spaceId).bulkWrite([
      { updateOne: { filter: asFilter<SnapshotRow>(wrongOrigin), update: { $set, $unset } } },
      { updateOne: { filter: asFilter<SnapshotRow>(marked), update: { $unset: { orphanSince: '' } } } },
    ], { ordered: false }));
  } catch (err) {
    if (!isActRefusal(err)) throw err;
  }
}

/** Does a present row (`origin` and `orphanSince` read) need {@link claimKept} for `kept`? The same rule as its filters, so the cycle writes only what it must. */
const needsClaim = (row: Pick<SnapshotRow, 'origin' | 'orphanSince'>, kept: KeptAs): boolean =>
  row.orphanSince !== undefined || (row.origin !== kept.origin && row.origin !== 'layer');

/**
 * Claim and keep the row of a version that is current or a held layer now (detached): {@link claimKept}, then {@link ensureSnapshot}. The claim
 * first, so once the row is seen the claim has landed: a claim landing later would clear a mark a sweep set after the version stopped being current.
 */
function keepCurrentSnapshot(spaceId: string, stamp: Stamp, kept: KeptAs): void {
  detachedWrite(async () => { await claimKept(spaceId, stamp, kept); await ensureSnapshot(spaceId, stamp, kept); })
    .catch(err => { schemaSnapshotTotal.note('failed'); reportSpaceFailure(SCHEMA_SNAPSHOT_STEP, spaceId, err); });
}

/** {@link ensureSnapshot}, detached: never awaited by the write that asked, a failure reported once per window through the shared reporter. */
export function keepSnapshot(spaceId: string, stamp: Stamp, kept: KeptAs): void {
  const key = `${spaceId}:${stamp.fp}`;
  // One detached upsert per fingerprint at a time: a burst of writes right after a schema save would otherwise schedule one each until the first lands.
  if (knownHeld(spaceId, stamp.fp) || keeping.has(key)) return;
  keeping.add(key);
  detachedWrite(() => ensureSnapshot(spaceId, stamp, kept))
    .catch(err => { schemaSnapshotTotal.note('failed'); reportSpaceFailure(SCHEMA_SNAPSHOT_STEP, spaceId, err); })
    .finally(() => keeping.delete(key));
}

/** The detached upserts in flight, `space:fp`: each entry leaves when its upsert settles, so the set holds no more than the writes running now. */
const keeping = new Set<string>();

/**
 * What `spaceId` keeps for its variation now: every layer's row, and its own unless it is one of them ("don't copy, just use"). The sweep's keep set:
 * read here, never copied.
 */
export function owedOf(spaceId: string): Array<readonly [Stamp, KeptAs]> {
  const v = variationOf(spaceId);
  if (!v) return [];
  const out: Array<readonly [Stamp, KeptAs]> = v.layers.map(l => [l.stamp, { origin: 'layer', networkId: l.networkId, links: null }] as const);
  if (!v.layers.some(l => l.stamp.fp === v.stamp.fp)) out.push([v.stamp, { origin: 'own', links: v.links }]);
  return out;
}

/** Keep the rows of `spaceId`'s variation as the config holds it now (detached). `updateSpace` and `createSpace` call it. */
export function keepVariationSnapshots(spaceId: string): void {
  for (const [stamp, kept] of owedOf(spaceId)) keepCurrentSnapshot(spaceId, stamp, kept);
}

/** Keep the row of a network layer `storeNetworkLayer` just stored for `spaceId` (detached), claimed as that layer's. */
export function keepLayerSnapshot(networkId: string, spaceId: string, layer: SpaceMeta): void {
  keepCurrentSnapshot(spaceId, layerStampOf(layer), { origin: 'layer', networkId, links: null });
}

/** After a library save: keep the variation of every space that links one of `names` (its fingerprint moved with the entry). */
export function keepSnapshotsOfSpacesLinking(names: readonly string[]): void {
  const usages = libraryUsages(getConfig().spaces);
  for (const spaceId of new Set(names.flatMap(n => (usages.get(n) ?? []).map(u => u.spaceId)))) keepVariationSnapshots(spaceId);
}

/**
 * The housekeeping step: for every space, the rows its variation and its layers owe, read from the store (not from what is known held, so a
 * row a restore or a failed write lost is written again), and the missing ones written; a present one with the wrong origin or a sweep's mark is
 * claimed. A space an act stands on is passed over quietly.
 */
export async function ensureSchemaSnapshots(): Promise<void> {
  await eachSpace(SCHEMA_SNAPSHOT_STEP, configuredSpaces(), async (space) => {
    const owed = owedOf(space.id);
    if (owed.length === 0) return;
    const present = new Map<string, Pick<SnapshotRow, 'origin' | 'orphanSince'>>((await snapshots(space.id)
      .find(asFilter<SnapshotRow>({ _id: { $in: [...new Set(owed.map(([s]) => s.fp))] } }), { projection: { _id: 1, origin: 1, orphanSince: 1 } }).toArray())
      .map(r => [String(r._id), r] as const));
    for (const [stamp, kept] of owed) {
      const row = present.get(stamp.fp);
      if (row) {
        if (needsClaim(row, kept)) await claimKept(space.id, stamp, kept);
        noteHeld(space.id, stamp.fp);
        continue;
      }
      forgetHeld(space.id, stamp.fp);
      if (await ensureSnapshot(space.id, stamp, kept) === 'refused') return;
      present.set(stamp.fp, { origin: kept.origin });
    }
  });
}

/**
 * The per-write backstop (`stampOp`): a record stamped with a fingerprint no known row holds keeps the snapshot of the very text it was stamped
 * with. The space's current variation or one of its layers when it is one of them; otherwise (the schema moved on since the write read it) an
 * own row whose links are not known any more.
 */
export function keepStampedSnapshot(spaceId: string, stamp: Stamp): void {
  const v = variationOf(spaceId);
  const layer = v?.layers.find(l => l.stamp.fp === stamp.fp);
  const kept: KeptAs = layer ? { origin: 'layer', networkId: layer.networkId, links: null }
    : { origin: 'own', links: v?.stamp.fp === stamp.fp ? v.links : null };
  keepSnapshot(spaceId, stamp, kept);
}
