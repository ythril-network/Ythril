/**
 * The re-key of one legacy file row onto its key: the worker half of `files/legacy-file-keys.ts` (Q-413), which says what it prevents and the rules.
 *
 * One row moves in one held transaction (`rekeyRows`, all or nothing) with a landing position of this instance's own stream and the version, author,
 * creation time and metadata it had; what the old id still holds (derived rows, jobs, links, the hash cache entry) is taken off it after the commit, and
 * the file is queued for embedding again under the receiver's own rules. Loaded on demand by the module that owns the index: it reaches the tombstones,
 * the derived rows and the jobs, which all read `file-meta.ts`.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import { inHeldTransaction } from '../brain/held-transaction.js';
import { withLandingStamp, arrivalRow } from '../sync/record-position-stream.js';
import { rekeyedRow } from '../sync/local-only-fields.js';
import { admitSpaceWrite, assertSpaceTakesWrites } from '../spaces/space-write-gate.js';
import { inChunks } from '../util/chunks.js';
import { rekeyRows, StaleRekeyPlan } from './rekey-rows.js';
import { carryPathKeyedCache, forgetPathKeyedCache } from './path-keyed-cache.js';
import { decideArrivals } from './tombstones.js';
import { deleteRowsDerivedFrom, rowsOfFiles } from './derived-rows.js';
import { cancelJobsOwnedBy, cancelMediaJob } from './media/job-queue.js';
import { retireEmbedWorkOfRemovedRows } from './file-embed-work.js';
import { carryLinksToKey, dropLinkRowsLocally } from './move-links.js';
import { embedArrivedFiles } from '../sync/embed-arrived-files.js';
import { LIVE_FILE_ROW } from './live-file-row.js';
import type { FileMetaDoc } from '../config/types.js';

interface LegacyRow { seq?: number; author?: { instanceId?: string }; deliveredBy?: string }

/** The one legacy row of a key that is kept: the highest version, the smallest id on a tie. */
function bestLegacy(rows: ReadonlyMap<string, LegacyRow>, ids: readonly string[]): string | undefined {
  return [...ids].filter(id => rows.has(id)).sort((a, b) => (rows.get(b)!.seq ?? 0) - (rows.get(a)!.seq ?? 0) || (a < b ? -1 : 1))[0];
}

/** Put the legacy row `ids` of `key` at `key`, or remove it where it loses or is shadowed — see the module docblock. Throws what fails; the row stays where it was. */
export async function rekeyLegacy(spaceId: string, key: string, ids: readonly string[]): Promise<void> {
  assertSpaceTakesWrites(spaceId, 'files');
  const filesColl = spaceCollection(spaceId, 'files');
  // The legacy rows are live ones (the index holds no other); the row at the key is read at EVERY tier, because a flagged audit row there is replaced and an
  // absent one is not: the two are different plans.
  const rows = await readStoredById<LegacyRow>(filesColl, ids, { seq: 1, author: 1, deliveredBy: 1 }, { filter: LIVE_FILE_ROW });
  const best = bestLegacy(rows, ids);
  if (best === undefined) return;   // gone since the index was read: another door adopted it (before the key's row is read: nothing to plan)
  const keyRow =(await readStoredById<LegacyRow & { deletedAt?: string }>(filesColl, [key], { seq: 1, deletedAt: 1 })).get(key);
  const flaggedAtKey = keyRow?.deletedAt !== undefined;
  const atKey = flaggedAtKey ? undefined : keyRow;
  const keep = rows.get(best)!;

  const shadowed = atKey !== undefined && (atKey.seq ?? 0) >= (keep.seq ?? 0) ? false : await isShadowed(spaceId, key, keep);
  const wins = !shadowed && (atKey === undefined || (keep.seq ?? 0) > (atKey.seq ?? 0));
  if (wins) {
    await admitSpaceWrite(spaceId, 'files', () => inHeldTransaction(spaceId, 'file.rekey-legacy', async (session) => {
      await withLandingStamp(spaceId, [arrivalRow(keep.seq ?? 0)], async ([landing]) => {
        await rekeyRows<FileMetaDoc>(filesColl, session, {
          moves: [{ from: best, to: key }],
          rebuild: (row) => rekeyedRow(row, { _id: key, path: key, ...landing }, { sameRecord: true }),   // the same file's row at its key: it keeps its deliverer and per-peer base
          refuse: (to) => new StaleRekeyPlan(`a row appeared at '${to}' since the re-key was planned`),
          ...(atKey !== undefined ? { replacements: { replaced: [key] } } : flaggedAtKey ? { replacements: { flagged: [key] } } : {}),
        });
      }, 'file.rekey-legacy');
      await carryPathKeyedCache(spaceId, session, [{ from: best, to: key }]);
    }));
  }
  // What the old ids still hold: a loser, a shadowed row, the rows the winner's old id derived. Taken off after the commit, so a failure leaves the row at its key.
  await removeWhatTheOldIdsHold(spaceId, [...ids], wins ? ids.filter(id => id !== best) : [...ids], wins ? { from: best, to: key } : undefined);
  if (wins) await embedArrivedFiles(spaceId, [key]);
}

/** Whether a held file tombstone at `key` shadows a metadata arrival of this row's version: the question every arrival at the key is asked (`decideArrivals`). A path that cannot be looked at is thrown, and the row stays. */
async function isShadowed(spaceId: string, key: string, row: LegacyRow): Promise<boolean> {
  const verdict = await decideArrivals(spaceId, [{
    id: key, path: key, kind: 'meta', seq: row.seq ?? 0,
    ...(row.author?.instanceId !== undefined ? { author: row.author.instanceId } : {}),
    ...(row.deliveredBy !== undefined ? { deliveredBy: row.deliveredBy } : {}),
  }]);
  if (verdict.undecided.has(key)) throw verdict.cause ?? new Error(`a delete held for '${key}' cannot be looked at`);
  return verdict.shadowed.has(key);
}

/**
 * Take off the old ids what hung on them. `rows` are the old ids whose derived rows, jobs and links go; `remove` are the old ids whose own row is
 * removed (every one but the row that was re-keyed, which already left its id). Jobs first, as every remover revokes the claims before the rows.
 */
async function removeWhatTheOldIdsHold(spaceId: string, rows: readonly string[], remove: readonly string[], moved?: { from: string; to: string }): Promise<void> {
  for (const id of rows) {
    await cancelMediaJob(spaceId, id);
    await cancelJobsOwnedBy(spaceId, id, 'file');
  }
  const { ids, parents } = await rowsOfFiles(spaceId, rows, []);
  // Carried to the key and nothing removed there (`carryLinksToKey`): a re-key writes no tombstone of any kind, links included.
  if (moved) await carryLinksToKey(spaceId, [moved]);
  await deleteRowsDerivedFrom(spaceId, parents);
  await retireEmbedWorkOfRemovedRows(spaceId, { ids: [...ids] });
  const coll = col<{ _id: string }>(spaceCollection(spaceId, 'files'));
  await admitSpaceWrite(spaceId, 'files', async () => {
    for (const part of inChunks([...remove], READ_CHUNK)) await coll.deleteMany(asFilter<{ _id: string }>({ _id: { $in: part } }));
  });
  // What is keyed by the old ids' paths goes with them (the hash cache entry the re-key did not carry), as every remover of file rows forgets it.
  await forgetPathKeyedCache(spaceId, { ids: [...rows] });
  // The old ids' own link rows go from THIS instance's collection, with no tombstone (`dropLinkRowsLocally`): carried above, or the row did not survive.
  await dropLinkRowsLocally(spaceId, rows);
}
