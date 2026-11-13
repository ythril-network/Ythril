/**
 * Remove the per-type schema files 6.5 wrote into a space (`schemas/<space>_<kind>_<type>.json`), locally, in every TTL cycle (Q-735).
 *
 * 6.6.0 keeps a schema version privately (`<space>_schema_snapshots`, `spaces/schema-snapshot-store.ts`) while a record here carries it, or while
 * it is current, a layer, or linked by a kept version, and writes no such file. What
 * 6.5 left is stale from the first schema change and of no use to anyone (a reader reads `GET /api/spaces/:id/meta` or `space_meta`), and it
 * never travels (`RETIRED_SCHEMA_FILE` stays in `isInstanceLocalFile`). Every cycle and not once at boot, because a 6.5 backup restored later
 * brings the files back.
 *
 * - **Only what the retired writer wrote**: 6.5 recorded no `files` row for them, so a file at such a path WITH a row is an operator's upload
 *   and stays, row and bytes (`rowed: 'keep'`). A file that only looks like one (another folder, another name under `schemas/`) is the user's.
 * - **Locally, with no tombstone and no webhook**, one log line and one internal audit entry per space that lost files: the shared walk
 *   (`files/retired-local-path-sweep.ts`), whose other user is the legacy spill sweep.
 */
import { RETIRED_SCHEMA_FILE } from '../sync/file-conflict.js';
import { configuredSpaces } from '../spaces/space-lookup.js';
import { RETIRED_SCHEMA_FILE_SWEEP_OPERATION } from '../audit/middleware.js';
import { eachSpace, type WalkResult } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { sweepRetiredLocalPaths } from './retired-local-path-sweep.js';

/** The name a failure of this sweep is reported, counted and quarantined under. */
const STEP = declareStep('Retired schema file sweep');

/** The directory the retired writer wrote into. */
const SCHEMAS_DIR = 'schemas';

export async function sweepRetiredSchemaFiles(): Promise<WalkResult<void>> {
  return eachSpace(STEP, configuredSpaces(), async (space) => {
    await sweepRetiredLocalPaths(space.id, {
      dir: SCHEMAS_DIR, matches: rel => RETIRED_SCHEMA_FILE.test(rel), rowed: 'keep',
      step: STEP, what: 'retired per-type schema file(s)', operation: RETIRED_SCHEMA_FILE_SWEEP_OPERATION, audit: 'retired-schema-file-sweep',
    });
  });
}
