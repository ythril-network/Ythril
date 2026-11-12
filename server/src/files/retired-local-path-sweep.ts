/**
 * Remove what a RETIRED writer left at a local-only path of a space: one walk, for every such writer (bundle-265, Q-735).
 *
 * ## Who calls it, and the one difference between them
 *
 * - **Legacy read spills** (`files/legacy-spill-sweep.ts`, Q-92): root `_tmp/graph-<uuid>.json` / `_tmp/results-<uuid>.json` that versions
 *   before 5.6.0 wrote with a `files` row, and older peers replicated. Every one goes, row or not (`rowed: 'remove'`).
 * - **Retired per-type schema files** (`files/retired-schema-file-sweep.ts`): `schemas/<space>_<kind>_<type>.json`, which 6.5 wrote after
 *   every schema save as bytes with NO row. A file at that path WITH a row is an operator's upload and stays (`rowed: 'keep'`).
 *
 * The question is one ("remove what a retired writer left at a local-only path"), so it is one module with a parameter, not two copies: the
 * spill sweep's own copy of this walk deleted the bytes, the cache entry and the row by hand and forgot the embed jobs and the derived rows,
 * which a second copy would have forgotten again.
 *
 * ## How
 *
 * - **By PATH**: the directory is listed (not recursively; a directory that is not there is an answer, any other failure to list is the
 *   space's), and with `rowed: 'remove'` the rows under it are found by an anchored prefix too, flagged ones included, because a row can
 *   outlive its bytes and bytes their row. `matches` decides the exact shape; anything else under the directory is the user's.
 * - **Each file is a unit** (`eachUnit`): its bytes, then everything it left besides its row through the one remover
 *   (`removeFileLeavingsHere`: its media job, its conversion's artefacts and derived rows, its cached hash, its embed jobs), so a file
 *   that fails is reported by name and the others still go.
 * - **The rows go LAST, hard, with no tombstone, no feed marker and no webhook**: a row is the finder of what is still owed, and no transport
 *   ever carries these paths (`isInstanceLocalFile`), so a tombstone or a feed marker would announce a deletion nobody is sent.
 * - **Links are left on purpose**, as `removeOneStoredFileHere` leaves them: a link is a record of whoever wrote it. Neither user has any:
 *   a spill is a hidden local file and a per-type schema file had no row, so neither was ever a link target.
 * - **Quiet when there is nothing**: one log line and one internal audit entry per space, only when something was removed.
 *
 * Throws what ends the space's sweep; the caller's walk (`eachSpace`) reports it and goes on with the next space.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spaceRoot } from './sandbox.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { deleteStoredIfPresent, isMissingPath } from './stored-bytes.js';
import { removeFileLeavingsHere } from './remove-file-here.js';
import { logInternalAudit } from '../audit/audit.js';
import { eachUnit } from '../util/housekeeping-walk.js';
import { log } from '../util/log.js';

/**
 * How old a file with no row must be before a `rowed: 'keep'` sweep takes it for the retired writer's: an upload writes its bytes before its row, and a
 * sweep that listed the directory between the two would delete a user's file. The retired writer's files are from before the upgrade, far older than this.
 * Written as one number (`N * 60_000`) for `doc-cited-constants`.
 */
export const ROWLESS_FILE_GRACE_MS = 10 * 60_000;

export interface RetiredLocalPaths {
  /** The directory under the space root the retired writer wrote into, as a relative path with `/`. */
  dir: string;
  /** Whether a relative path (`<dir>/<name>`) is one the retired writer wrote. */
  matches: (rel: string) => boolean;
  /** `'remove'`: the writer's rows go too; `'keep'`: the writer wrote no row, so a file with one is someone's upload and stays. */
  rowed: 'remove' | 'keep';
  /** The sweep's name, which its log line starts with. */
  step: string;
  /** What one of the removed files is called in that line, in the plural (`read spill(s)`). */
  what: string;
  /** The internal audit entry's operation and path suffix (`internal:<audit>`). */
  operation: string;
  audit: string;
}

/** Sweep one space; answers how many files it removed. */
export async function sweepRetiredLocalPaths(spaceId: string, { dir, matches, rowed, step, what, operation, audit }: RetiredLocalPaths): Promise<number> {
  const started = Date.now();
  const found = new Set<string>();
  const abs = path.join(spaceRoot(spaceId), ...dir.split('/'));
  const names = await fs.readdir(abs).catch((err: unknown) => {
    if (!isMissingPath(err)) throw err;   // not being there is an answer; a failure to look is the space's
    return [] as string[];
  });
  for (const name of names) {
    const rel = `${dir}/${name}`;
    if (matches(rel)) found.add(rel);
  }
  const files = col<{ _id: string }>(spaceCollection(spaceId, 'files'));
  if (rowed === 'remove') {
    // An anchored, case-sensitive prefix, so the query walks only the directory's range of the `_id` index on every cycle.
    const rows = await files.find(asFilter({ _id: { $regex: `^${dir}/` } }), { projection: { _id: 1 } }).toArray();
    for (const r of rows) if (matches(r._id)) found.add(r._id);
  } else if (found.size > 0) {
    // A row at the path, live or flagged, is what the retired writer never wrote: the file is someone's.
    const withRow = await files.find(asFilter({ _id: { $in: [...found] } }), { projection: { _id: 1 } }).toArray();
    for (const r of withRow) found.delete(r._id);
    // No row YET is not "the retired writer wrote it": an upload's bytes land before its row, so a file younger than the grace is left for a later cycle.
    // A file whose age cannot be read is kept too: the next cycle asks again, and nothing of a user's is removed on a guess.
    for (const rel of [...found]) {
      const st = await fs.stat(path.join(abs, rel.slice(dir.length + 1))).catch((err: unknown) => (isMissingPath(err) ? null : 'unread' as const));
      if (st === 'unread' || (st !== null && st.mtimeMs > started - ROWLESS_FILE_GRACE_MS)) found.delete(rel);
    }
  }
  if (found.size === 0) return 0;

  const removed: string[] = [];
  await eachUnit([...found], async (rel) => {
    // The bytes may never have arrived, or be already gone: both are fine. A directory at the path is not a file and is left alone.
    await deleteStoredIfPresent(path.join(abs, rel.slice(dir.length + 1)), { skipDirectory: true });
    await removeFileLeavingsHere(spaceId, rel, 'throw');
    removed.push(rel);
  });
  if (removed.length === 0) return 0;
  // The rows are the finder (see the header): they go last, so a failure of anything before is redone by the next run.
  if (rowed === 'remove') await files.deleteMany(asFilter({ _id: { $in: removed } }));

  log.info(`${step}: removed ${removed.length} ${what} from '${spaceId}'`);
  logInternalAudit({ method: 'SWEEP', path: `internal:${audit}`, spaceId, operation, startedAt: started });
  return removed.length;
}
