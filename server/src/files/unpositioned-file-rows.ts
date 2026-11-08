/**
 * Give every LIVE file row that holds no position one (bundle-255): the boot pass that makes the change feed's cursor-less listing complete.
 *
 * ## What it prevents
 *
 * The change feed (`files/file-changes.ts`) reads `files` by position, so a row with none is in no page: a client that pages the feed from the start to
 * mirror a space never hears of it. Two kinds of row had none: bytes that arrived before this release (the insert branch of `recordArrivedFile` stamped
 * nothing until Q-725) and a pre-4.0 row with no version that nothing has written since. Each takes a fresh clock position and `posAtSeq` equal to its
 * own version (0 when it has none), so the position repair, which re-stamps a row whose `posAtSeq` is not its `seq`, never touches it again.
 *
 * Idempotent and cheap when there is nothing to do (one read of an empty page), so the boot pass runs it for every space. A space that still owes its
 * positions (a carry or a repair) is passed over: that work positions its rows by its own rules, and this pass runs again at the next boot.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { READ_CHUNK } from '../db/read-by-id.js';
import { writeInOneCommands } from '../db/one-command.js';
import { withLandingStamp, arrivalRow } from '../sync/record-position-stream.js';
import { positionsReady } from '../sync/positions-ready.js';
import { assertSpaceTakesWrites, isActRefusal } from '../spaces/space-write-gate.js';
import { LIVE_FILE_ROW } from './live-file-row.js';

/** Position the space's live file rows that hold none, a page at a time, each page one held block. Answers how many it positioned. */
export async function positionUnpositionedFileRows(spaceId: string): Promise<number> {
  // Housekeeping: a space an act owns is passed over, never a failure.
  try { assertSpaceTakesWrites(spaceId, 'files'); } catch (err) { if (isActRefusal(err)) return 0; throw err; }
  if (!await positionsReady(spaceId)) return 0;
  const coll = col<{ _id: string; seq?: number }>(spaceCollection(spaceId, 'files'));
  const unpositioned = { ...LIVE_FILE_ROW, pos: { $exists: false } };
  let positioned = 0;
  for (;;) {
    const rows = await coll.find(asFilter<{ _id: string }>(unpositioned), { projection: { _id: 1, seq: 1 }, limit: READ_CHUNK }).toArray();
    if (rows.length === 0) break;
    await withLandingStamp(spaceId, rows.map(r => arrivalRow(typeof r.seq === 'number' ? r.seq : 0)), (patches) => writeInOneCommands(rows.map((r, i) => ({
      updateOne: {
        filter: asFilter<{ _id: string }>({ _id: r._id, ...unpositioned }),
        update: [{ $set: { pos: { $literal: patches[i]!.pos }, posAtSeq: { $ifNull: ['$seq', 0] } } }] as never,
      },
    })), (slice, { ordered }) => coll.bulkWrite(slice, { ordered }), { ordered: false }), 'file.position-unpositioned');
    positioned += rows.length;
    if (rows.length < READ_CHUNK) break;
  }
  return positioned;
}
