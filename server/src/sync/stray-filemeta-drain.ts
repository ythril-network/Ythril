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
 *   stored as a file, and the embed enqueue when this instance holds the blob. `fileMetaForWire` first, because the
 *   old pull stored the sender's whole record and the file schema is strict.
 * - **Dropped only after a page loop that did not throw.** A refused or older record is an answer, not a failure, so
 *   it is dropped with the rest; a write the store could not make keeps the collection for the next cycle.
 * - **Recurring, inside the TTL sweep cycle**, like `files/legacy-spill-sweep.ts`: cheap when there is nothing (one
 *   `listCollections` per space), and a failed drain is retried without a restart. The source is local state no
 *   transport carries, so draining it is not a migration of synced data.
 *
 * Removed at the next major.
 */
import { getConfig } from '../config/loader.js';
import { getDb, col, asFilter } from '../db/mongo.js';
import { fileMetaForWire } from '../api/sync/_shared.js';
import { writeArrivals } from './arrivals.js';
import { log } from '../util/log.js';

const PAGE = 500;

/** The collection the 4.0-5.6.1 pull wrote file metadata to. */
const strayCollection = (spaceId: string): string => `${spaceId}_filemeta`;

/** Drain every space's stray file-metadata collection. Returns the spaces drained. */
export async function drainStrayFileMeta(): Promise<string[]> {
  let cfg;
  try { cfg = getConfig(); } catch { return []; } // pre-setup
  const drained: string[] = [];
  for (const space of cfg.spaces) {
    if (space.proxyFor?.length) continue; // proxy spaces own no collections
    const name = strayCollection(space.id);
    if ((await getDb().listCollections({ name }, { nameOnly: true }).toArray()).length === 0) continue;
    let after: string | undefined;
    let merged = 0, kept = 0, refused = 0;
    for (;;) {
      const page = await col<{ _id: string }>(name)
        .find(asFilter<{ _id: string }>(after === undefined ? {} : { _id: { $gt: after } }))
        .sort({ _id: 1 }).limit(PAGE).toArray();
      if (page.length === 0) break;
      after = page[page.length - 1]!._id;
      const out = await writeArrivals(space.id, 'files', 'file', page.map(fileMetaForWire),
        { from: 'a 4.0-5.6.1 pull (stray filemeta collection)' });
      merged += out.inserted.length + out.updated.length;
      kept += out.newerLocal.length;
      refused += out.refused.length + out.storeRefused.length + out.derived.length;
    }
    await getDb().dropCollection(name);
    drained.push(space.id);
    log.info(`Space '${space.id}': merged ${merged} file metadata record(s) a 4.0-5.6.1 pull left in '${name}' `
      + `(${kept} older than the stored copy, ${refused} not stored), and dropped the collection (Q-219).`);
  }
  return drained;
}
