/**
 * Retire the conversion sidecars a PEER delivered to this instance before sidecars became instance-local (bundle-48, Q-260).
 *
 * ## The question this answers
 *
 * "This space holds a file row at `_converted/…` or `_extracted/…` that a peer made — whose is it now?" It is nobody's to keep:
 * a conversion's sidecar is derived by each instance from the file, by that instance's own configuration, and no instance sends
 * or accepts one any more (`isInstanceLocalFile`, `sync/file-conflict.ts`). A peer's, held here, is a copy of ANOTHER
 * instance's conversion sitting where this instance's own would go: found beside the receiver's own conversion as a conflict copy,
 * or pushed over the publisher's. So each is retired — its bytes and its row, through the one removal every peer-driven
 * delete uses (`removeOneStoredFileHere`) — whatever the receiver's conversion setting: a receiver with conversion off holds no derived text at all.
 *
 * ## What it touches, and what it never does
 *
 * Only a TOP-LEVEL row (no `parentFileId`) under a derived root whose author or deliverer is another instance. The sidecars this
 * instance's own pipeline writes are derived rows (`parentFileId`), and a row this instance authored is a person's choice to keep
 * a file there; neither is read. It publishes NO tombstone and fires no webhook: the path is instance-local, so a tombstone would
 * announce a deletion to peers that never received the file from this instance, and an upgrade would tell every integrator that
 * somebody deleted files. A count per space is one log line instead.
 *
 * ## Why it recurs and is cheap
 *
 * It runs inside every TTL sweep cycle, like `files/legacy-spill-sweep.ts`: an older peer keeps pushing sidecars until it upgrades
 * (the upload door answers `200 {ignored}` and stores nothing, but a metadata arrival from an older version is the writer's to
 * refuse). With nothing to retire it is one anchored-prefix query per space. At most {@link RETIRE_PER_SPACE_PER_CYCLE} are
 * retired per space per cycle, so an upgrade of a space holding a peer's whole conversion tree is worked off over cycles.
 *
 * ## Failure is the space's, or the unit's
 *
 * Every space goes through `eachSpace` and each file through `eachUnit` (`util/housekeeping-walk.ts`): a space whose read fails
 * is reported once per window and the next is still visited, a file whose removal fails is reported by name and retried next cycle.
 * The row is the finder and goes last inside `removeFileHere`, so a failed run leaves the row that names what is still owed.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { getConfig } from '../config/loader.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { CONVERTED_ROOT, EXTRACTED_ROOT } from '../files/moved-paths.js';
import { resolveSafePathChecked } from '../files/sandbox.js';
import { removeOneStoredFileHere } from '../files/remove-file-here.js';
import { LIVE_FILE_ROW } from '../files/live-file-row.js';
import { deliveredByAPeer } from './delivered-by.js';
import { escapeRegex } from '../util/redos.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { log, peerText } from '../util/log.js';
import { logInternalAudit } from '../audit/audit.js';
import { PEER_SIDECAR_RETIREMENT_OPERATION } from '../audit/middleware.js';

const STEP = declareStep('Peer sidecar retirement');

/** The most sidecars retired from one space in one cycle: the rest are found again next cycle, by the same query. */
export const RETIRE_PER_SPACE_PER_CYCLE = 200;

/** Retire the peer-supplied sidecars of one space; returns how many were retired. Throws what ends the space's step. */
async function retireInSpace(spaceId: string): Promise<number> {
  const startedAt = Date.now();
  const self = getConfig().instanceId;
  const found = await col<{ _id: string }>(spaceCollection(spaceId, 'files')).find(asFilter<{ _id: string }>({
    _id: { $regex: `^(?:${escapeRegex(CONVERTED_ROOT)}|${escapeRegex(EXTRACTED_ROOT)})` },
    ...LIVE_FILE_ROW,
    // A peer's: it delivered the bytes, or it wrote the row. A row this instance authored with nobody delivering is its own.
    $or: [deliveredByAPeer(self), { 'author.instanceId': { $exists: true, $ne: self } }],
  }), { projection: { _id: 1 } }).limit(RETIRE_PER_SPACE_PER_CYCLE).toArray();
  if (found.length === 0) return 0;

  let retired = 0;
  await eachUnit(found.map(r => String(r._id)), async (rel) => {
    // The bytes first (a path that is a directory is left alone), then the row and everything hanging off it, in the one order
    // every peer-driven removal uses: the row is the finder, so a failure here leaves what a later cycle needs to finish the job.
    await removeOneStoredFileHere(spaceId, rel, await resolveSafePathChecked(spaceId, rel));
    retired++;
  });
  if (retired > 0) {
    log.info(`Retired ${retired} conversion sidecar(s) a peer delivered into space '${peerText(spaceId)}': sidecars are this instance's own now`);
    // Files no request named were removed: audited after the removal succeeded, as the stray drain's drop is.
    logInternalAudit({ method: 'SWEEP', path: 'internal:peer-sidecar-retirement', spaceId, operation: PEER_SIDECAR_RETIREMENT_OPERATION, startedAt });
  }
  return retired;
}

/** Retire the peer-supplied sidecars of every space. Never throws: a failure is the space's, reported by the walk. */
export async function retirePeerSidecars(): Promise<number> {
  let total = 0;
  await eachSpace(STEP, concreteSpaces(), async (space) => { total += await retireInSpace(space.id); });
  return total;
}
