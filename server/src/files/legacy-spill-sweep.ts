/**
 * Remove the read spills versions before 5.5.3 wrote INTO a space (Q-92).
 *
 * A recall's remainder and an over-cap traversal used to be a root `_tmp/results-<uuid>.json` or
 * `_tmp/graph-<uuid>.json` with a `<space>_files` record. They replicated, and a pulled copy never expired
 * (`_expireAt` is local-only), so peers have accumulated them since spills existed. Spills now live in the
 * instance's read-spill store, sync carries this path shape in neither direction (`isInstanceLocalFile`,
 * `ingestFileMeta`, the manifest and the space hash), and this sweep removes what is left locally.
 *
 * - **By PATH, not by tag**: metadata can arrive before its blob and a blob can outlive its record, so a sweep
 *   keyed on the FileMeta's tag leaves one half behind — and finds it again every run.
 * - **Hard, with no tombstone and no webhook**: no transport carries the path, so a tombstone would announce a
 *   deletion nobody is sent, and an upgrade would fire a burst of unattributed `file.deleted` events telling
 *   consumers that someone deleted files. One summary log line and one audit entry per space instead.
 * - **Recurring**, inside every TTL sweep cycle: older peers keep sending spills until they upgrade, so a
 *   boot-once sweep would leave every one that arrives after it. It is idempotent and cheap when there is
 *   nothing: one directory listing and one indexed query per space.
 *
 * Removed at the next major, with the deprecated `path` and `isSpillPath`'s hiding of `_tmp`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config/loader.js';
import { spaceRoot } from './sandbox.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { deleteStored } from './stored-bytes.js';
import { SPILL_DIR, spillIdFromPath } from '../brain/spill-path.js';
import { isProxy } from '../spaces/proxy.js';
import { logAuditEntry } from '../audit/audit.js';
import { LEGACY_SPILL_SWEEP_OPERATION } from '../audit/middleware.js';
import { log } from '../util/log.js';


export interface LegacySpillSweep {
  /** Spills removed, each counted once whichever of its two halves was present. */
  removed: number;
  /** Paths that could not be removed, with the reason; logged, retried next run. */
  failed: { spaceId: string; path: string; error: string }[];
}

export async function sweepLegacySpills(): Promise<LegacySpillSweep> {
  const out: LegacySpillSweep = { removed: 0, failed: [] };
  for (const space of getConfig().spaces) {
    if (isProxy(space)) continue;
    const spaceId = space.id;
    const started = Date.now();
    const found = new Set<string>();

    const dir = path.join(spaceRoot(spaceId), SPILL_DIR);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const rel = `${SPILL_DIR}/${name}`;
      if (spillIdFromPath(rel)) found.add(rel);
    }
    const metas = await col<{ _id: string }>(spaceCollection(spaceId, 'files'))
      // An anchored, case-sensitive prefix, so the query walks only the `_tmp/` range of the `_id` index on every
      // cycle; the exact spill shape is then decided by `spillIdFromPath` below, the one test for it.
      .find(asFilter({ _id: { $regex: `^${SPILL_DIR}/` } }), { projection: { _id: 1 } }).toArray();
    for (const m of metas) if (spillIdFromPath(m._id)) found.add(m._id);
    if (found.size === 0) continue;

    const removed: string[] = [];
    for (const rel of found) {
      try {
        await deleteStored(path.join(dir, rel.slice(SPILL_DIR.length + 1))).catch((err: NodeJS.ErrnoException) => {
          if (err?.code !== 'ENOENT') throw err;   // the blob never arrived, or is already gone
        });
        removed.push(rel);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        out.failed.push({ spaceId, path: rel, error });
        log.warn(`Legacy spill sweep: could not remove ${spaceId}/${rel}: ${error}`);
      }
    }
    if (removed.length === 0) continue;
    await col(spaceCollection(spaceId, 'files')).deleteMany(asFilter({ _id: { $in: removed } }));
    await col(spaceCollection(spaceId, 'fileHashes')).deleteMany(asFilter({ _id: { $in: removed } }));
    out.removed += removed.length;
    // The disk this freed is the files quota's, and a cached figure would keep charging for it until expiry.
    invalidateUsageCache();

    log.info(`Legacy spill sweep: removed ${removed.length} read spill(s) older versions wrote into '${spaceId}'`);
    logAuditEntry({
      ip: 'internal', method: 'SWEEP', path: 'internal:legacy-spill-sweep', spaceId,
      operation: LEGACY_SPILL_SWEEP_OPERATION, status: 200, durationMs: Date.now() - started,
    });
  }
  return out;
}
