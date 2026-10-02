/**
 * Merge the file metadata a 4.0-5.6.1 pull stored in `<space>_filemeta` into `<space>_files`, then drop the stray
 * collection (`Q-219`).
 *
 * From P-32 (4.0) to 5.6.1 the pull wrote each family to `${spaceId}_${payloadKey}`, and the payload key of file
 * metadata is `filemeta`, not `files`. Nothing reads that collection and the receive watermark has passed its
 * records, so they are never pulled again: a publisher's descriptions and tags never reached the subscriber's files.
 * 5.6.2 pulls into the right collection; this recovers what the old one left.
 *
 * - **Through the arrival writer, as if the records arrived now** — never a copy loop. It owns every rule a
 *   hand-written merge would drop: the seq-guarded accept (an older stray record never overwrites a later edit), the
 *   authored-keys-only merge (`ingestFileMeta`: the receiver's own size and hash stand), a chunk refused rather than
 *   stored as a file, and the embed enqueue when this instance holds the blob.
 * - **Only into a file this instance still has a record for.** A stray record is old by construction, and a file
 *   whose record is gone was usually DELETED since — its tombstone removed the `_files` row and never touched this
 *   collection. Inserting it would bring back a deleted file's path and description as a row with no bytes, hashed
 *   and diverging from every peer for good. A file whose bytes never arrived loses only the stray description.
 * - **Dropped only after a page loop that did not throw.** A refused or older record is an answer, not a failure, so
 *   it is dropped with the rest; a write the store could not make keeps the collection for the next cycle.
 * - **Recurring, inside the TTL sweep cycle**, like `files/legacy-spill-sweep.ts`: cheap when there is nothing (one
 *   `listCollections` per space), and a failed drain is retried without a restart. The source is local state no
 *   transport carries, so draining it is not a migration of synced data.
 *
 * Removed at the next major.
 */
import { concreteSpaces } from '../spaces/proxy.js';
import { getDb, col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { writeArrivals } from './arrivals.js';
import { log } from '../util/log.js';

const PAGE = 500;

/** Drain every space's stray file-metadata collection. Returns the spaces drained. */
export async function drainStrayFileMeta(): Promise<string[]> {
  const drained: string[] = [];
  // Proxy spaces own no collections; `concreteSpaces` is empty before setup.
  for (const space of concreteSpaces()) {
    const spaceId = space.id;
    // The name the 4.0-5.6.1 pull built (`${spaceId}_${payloadKey}`); not a collection this version routes.
    const collName = `${spaceId}_filemeta`;
    if ((await getDb().listCollections({ name: collName }, { nameOnly: true }).toArray()).length === 0) continue;
    let after: string | undefined;
    const merged: string[] = [], kept: string[] = [], unstored: string[] = [];
    for (;;) {
      const page = await col<{ _id: string }>(collName)
        .find(asFilter<{ _id: string }>(after === undefined ? {} : { _id: { $gt: after } }))
        .sort({ _id: 1 }).limit(PAGE).toArray();
      if (page.length === 0) break;
      after = page[page.length - 1]!._id;
      const have = new Set((await col<{ _id: string }>(spaceCollection(spaceId, 'files'))
        .find(asFilter<{ _id: string }>({ _id: { $in: page.map(d => d._id) } }), { projection: { _id: 1 } })
        .toArray()).map(d => d._id));
      for (const d of page) if (!have.has(d._id)) unstored.push(d._id);
      const out = await writeArrivals(spaceId, 'files', 'file', page.filter(d => have.has(d._id)),
        { from: 'a 4.0-5.6.1 pull (stray filemeta collection)' });
      merged.push(...out.inserted, ...out.updated);
      kept.push(...out.newerLocal);
      // `refused` holds shape refusals and what the store refused alike, on this branch's writer.
      unstored.push(...out.refused.map(r => r._id), ...out.derived);
    }
    await getDb().dropCollection(collName);
    drained.push(spaceId);
    log.info(`Space '${spaceId}': merged ${merged.length} file metadata record(s) a 4.0-5.6.1 pull left in '${collName}' `
      + `(${kept.length} older than the stored copy, ${unstored.length} with no file here or not stored), and dropped `
      + 'the collection (Q-219).');
  }
  return drained;
}
