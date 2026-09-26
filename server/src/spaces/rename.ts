/**
 * Space rename — collection data movement and the config rewrite that follows it.
 *
 * Split out of spaces.ts (A17.7 step 2). Renaming a space renames its `{spaceId}_*` collections and
 * then rewrites every config reference (networks, tokens, proxy members). Depends only on _shared.
 */
import { escapeRegex } from '../util/redos.js';
import fs from 'fs/promises';
import path from 'path';
import { getDb, col, asDoc, asFilter } from '../db/mongo.js';
import { getConfig, saveConfig, getDataRoot, mutateConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { Config, SpaceConfig } from '../config/types.js';
import { PER_SPACE_WATERMARKS } from '../config/types-networks.js';
import { repairStaleSpaceIds, pendingOpConflictMessage, beginSpaceOp, endSpaceOp } from './_shared.js';

/** Physically move a space's MongoDB collections and file directories from
 *  {oldId}_* / files/oldId to {newId}_* / files/newId. Idempotent — after a partial
 *  run, only the collections/dirs still under `oldId` remain to move, so re-running
 *  completes it. Returns hard errors (empty on full success). */
export async function moveSpaceData(oldId: string, newId: string): Promise<string[]> {
  const db = getDb();
  const errors: string[] = [];

  // 1. Rename MongoDB collections ({oldId}_* → {newId}_*). Only collections still
  //    under the old prefix remain after a partial run, so this is idempotent.
  //
  //    Prefix match with no boundary check — safe only because a space id is validated `^[a-z0-9-]+$`,
  //    so `_` cannot occur inside an id and separates cleanly (`work-archive_facts` does not start with
  //    `work_`). See the fuller note on the drop path in `lifecycle.ts`, which has the same dependency with
  //    worse consequences. Pinned by `space-id-prefix-safety.test.js`.
  const existingColls = await db.listCollections().toArray();
  const prefix = `${oldId}_`;
  for (const coll of existingColls.filter(c => c.name.startsWith(prefix))) {
    const suffix = coll.name.slice(prefix.length);
    const newName = `${newId}_${suffix}`;
    try {
      await db.collection(coll.name).rename(newName);
      log.debug(`Renamed collection ${coll.name} → ${newName}`);
    } catch (err) {
      const msg = `Could not rename collection ${coll.name} → ${newName}: ${err}`;
      log.warn(msg);
      errors.push(msg);
    }
  }

  // 1b. Rewrite the `spaceId` field inside the moved documents.
  //
  // Renaming the collection is NOT enough: every document still carries the OLD space id,
  // and the read paths filter on that field (listEntities, findEntityByName, the edge-dedup
  // lookup, the cascade deletes). Without this the renamed space looks CATASTROPHIC but is
  // actually intact — counts still show the documents (counts read the collection) while
  // every list comes back empty, and `findEntityByName` stops matching, so `saveFact` starts
  // creating duplicates instead of linking to the existing entity.
  //
  // Idempotent, and safe on a partial re-run: a document living in `{newId}_*` belongs to
  // `newId` by definition, so we only touch the ones that disagree.
  try {
    const repaired = await repairStaleSpaceIds(newId);
    if (repaired > 0) log.debug(`Rewrote spaceId on ${repaired} document(s) for renamed space ${newId}`);
  } catch (err) {
    const msg = `Could not rewrite spaceId field for renamed space ${newId}: ${err}`;
    log.warn(msg);
    errors.push(msg);
  }

  // 1c. Migrate the GLOBAL collections that are keyed by space id.
  //
  // These are not under the `{oldId}_` prefix, so the collection rename above misses them
  // entirely — and for the seq counter that is dangerous, not cosmetic:
  //
  //   `ythril_counters` stores the space's monotonic seq as `_id: <spaceId>`. Losing it
  //   means nextSeq() restarts at 1 — while applySpaceRenameToConfig deliberately carries
  //   the OLD, high `lastSeqPushed` / `lastSeqReceived` watermarks over to the new id. Every
  //   subsequent local write would then get a seq BELOW the watermark, and sync would skip
  //   it forever: the space keeps working locally while silently never pushing to peers.
  //
  // `_id` is immutable in MongoDB, so these are copy-then-delete. Take the MAX of old and
  // any pre-existing counter so a re-run can never move the sequence backwards.
  try {
    const counters = col<{ _id: string; seq: number }>('ythril_counters');
    const oldCounter = await counters.findOne(asFilter<{ _id: string; seq: number }>({ _id: oldId }));
    if (oldCounter) {
      const newCounter = await counters.findOne(asFilter<{ _id: string; seq: number }>({ _id: newId }));
      const seq = Math.max(oldCounter.seq ?? 0, newCounter?.seq ?? 0);
      await counters.replaceOne(
        asFilter<{ _id: string; seq: number }>({ _id: newId }),
        asDoc({ _id: newId, seq }),
        { upsert: true },
      );
      await counters.deleteOne(asFilter<{ _id: string; seq: number }>({ _id: oldId }));
      log.debug(`Migrated seq counter ${oldId} → ${newId} (seq=${seq})`);
    }
  } catch (err) {
    const msg = `Could not migrate the seq counter ${oldId} → ${newId}: ${err}`;
    log.warn(msg);
    errors.push(msg);
  }

  // The duplicate-scanner cursor is keyed `${spaceId}:${type}`. Losing it is harmless
  // (the space simply re-scans from the start) but it leaves orphaned rows behind, so
  // move it across rather than stranding it.
  try {
    const scanState = col<{ _id: string }>('ythril_dupe_scan_state');
    const stale = await scanState
      .find(asFilter<{ _id: string }>({ _id: { $regex: `^${escapeRegex(oldId)}:` } }))
      .toArray() as Array<Record<string, unknown> & { _id: string }>;
    for (const doc of stale) {
      const moved = { ...doc, _id: `${newId}:${doc._id.slice(oldId.length + 1)}` };
      await scanState.replaceOne(asFilter<{ _id: string }>({ _id: moved._id }), asDoc(moved), { upsert: true });
      await scanState.deleteOne(asFilter<{ _id: string }>({ _id: doc._id }));
    }
  } catch (err) {
    // Non-fatal: worst case the renamed space re-scans for duplicates from scratch.
    log.warn(`Could not migrate the dupe-scan cursor ${oldId} → ${newId}: ${err}`);
  }

  // 2. Move the files directory (skip if already moved — old dir gone)
  const dataRoot = getDataRoot();
  const oldDir = path.resolve(dataRoot, 'files', oldId);
  const newDir = path.resolve(dataRoot, 'files', newId);
  try {
    await fs.access(oldDir);
    await fs.rename(oldDir, newDir);
    log.debug(`Moved files directory ${oldDir} → ${newDir}`);
  } catch (err) {
    // If old dir doesn't exist, that's fine — space had no files, or it was already moved.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      const msg = `Could not move files directory: ${err}`;
      log.warn(msg);
      errors.push(msg);
    }
  }

  // 3. Move chunked-upload directory if it exists
  const oldChunks = path.resolve(dataRoot, '.chunks', oldId);
  const newChunks = path.resolve(dataRoot, '.chunks', newId);
  try {
    await fs.access(oldChunks);
    await fs.rename(oldChunks, newChunks);
  } catch { /* ignore — chunks dir may not exist / already moved */ }

  // Usage history follows the space. `space_activity` is instance-wide and its bucket `_id` embeds the
  // space id, so the collection renames above cannot carry it: without this a renamed space starts with a
  // blank Usage panel while its old rows linger under an id that no longer exists.
  try {
    const { renameSpaceActivity } = await import('../metrics/space-activity-store.js');
    const moved = await renameSpaceActivity(oldId, newId);
    if (moved > 0) log.debug(`Moved ${moved} activity bucket(s) from '${oldId}' to '${newId}'`);
  } catch (err) {
    // Non-fatal: a rename that otherwise succeeded must not fail over its usage history.
    log.warn(`Could not move activity buckets for the rename ${oldId} -> ${newId}: ${err}`);
  }

  return errors;
}

/** Apply the logical config changes of a rename: point the space entry at `newId`
 *  and rewrite every reference (networks, spaceMap, member watermarks, token scopes,
 *  proxy targets). Pure/synchronous — the caller persists with a single saveConfig. */
export function applySpaceRenameToConfig(cfg: Config, space: SpaceConfig, oldId: string, newId: string): void {
  // Update the space config entry
  space.id = newId;

  // Embedded spaceId fields in docs stay as-is — that's the space the doc was
  // originally written in (provenance). Local lookups use collection names.

  // Update network references
  for (const net of cfg.networks) {
    const idx = net.spaces.indexOf(oldId);
    if (idx !== -1) {
      net.spaces[idx] = newId;
      // Record in spaceMap so peers using the old ID can still sync.
      if (!net.spaceMap) net.spaceMap = {};
      // Update any existing mapping whose target was oldId (rare: chained renames)
      for (const [remote, local] of Object.entries(net.spaceMap)) {
        if (local === oldId) {
          net.spaceMap[remote] = newId;
        }
      }
      // Add direct mapping oldId → newId (a peer spoke may still reference the old ID)
      if (!net.spaceMap[oldId] || net.spaceMap[oldId] === oldId) {
        net.spaceMap[oldId] = newId;
      }
    }

    // Update member watermark keys (lastSeqReceived / lastSeqPushed / lastSeqServed /
    // lastFileTombstoneAckedAt).
    //
    // All four are keyed by space id, so a rename that misses one silently resets that watermark to
    // "unknown". For the two pull watermarks that means re-pulling from 0 (idempotent by seq). For the two
    // retention floors it means the tombstone prune stops until every member has pulled (or acked) again —
    // safe, and invisible, which is why they are carried here rather than left to heal.
    /*
     * ONE loop over `PER_SPACE_WATERMARKS`, not one `if` per field.
     *
     * It was four blocks differing only in the key, which is the same rule written four times — and the
     * failure of the fourth copy is silent by construction: a watermark that is not carried resets to
     * "unknown", which is SAFE and invisible. A fifth watermark would have been added to the type by
     * somebody who never opened this file.
     */
    for (const member of net.members) {
      for (const key of PER_SPACE_WATERMARKS) {
        const marks = member[key] as Record<string, unknown> | undefined;
        if (marks?.[oldId] === undefined) continue;
        marks[newId] = marks[oldId];
        delete marks[oldId];
      }
    }
  }

  /**
   * Update token scopes — the rights MATRIX as well as the legacy allowlist.
   *
   * ## The defect this closes
   *
   * Only `tok.spaces` was re-keyed here. Nothing anywhere touched `rights.perSpace`, so renaming a space
   * silently stripped every matrix-scoped token's access to it: the row stayed under the OLD id, which now
   * names nothing, and the token simply stopped reaching a space it had rights in.
   *
   * That is every token minted since 2.9 — the rights editor writes `perSpace` and nothing writes the
   * allowlist. So the half that was maintained was the half nobody has, and the failure is silent on both
   * sides: no error at rename time, and later a 403 that looks like the rights were never granted.
   *
   * One rule — a token's scope follows a rename — with two implementations, and the live one missing. That
   * is the defect class this codebase names as the one it produces most, and it was hiding inside the
   * mechanism for renaming.
   *
   * ## Why the collision check
   *
   * `perSpace` is keyed by space id, so re-keying is a move within an object rather than an index swap. A
   * row already at `newId` would be overwritten by one that used to be somewhere else — quietly widening or
   * narrowing that token. It cannot happen through the rename route (which refuses a `newId` that exists),
   * but this function is also reached on resume after a crash, so the guard is cheap and the alternative is
   * unreviewable.
   */
  for (const tok of cfg.tokens) {
    const perSpace = tok.rights?.perSpace;
    if (perSpace && perSpace[oldId] !== undefined && perSpace[newId] === undefined) {
      perSpace[newId] = perSpace[oldId]!;
      delete perSpace[oldId];
    }
    // The space-admin list names spaces too (Q-58): left on the old id, the renamed space silently lost its
    // named administrators. Rewritten in place, never duplicated when the new id is already listed.
    const sa = tok.rights?.spaceAdmin;
    if (sa?.spaces.includes(oldId)) {
      sa.spaces = sa.spaces.includes(newId) ? sa.spaces.filter(s => s !== oldId) : sa.spaces.map(s => (s === oldId ? newId : s));
    }
  }

  // Update proxy space references
  for (const s of cfg.spaces) {
    if (s.proxyFor) {
      const idx = s.proxyFor.indexOf(oldId);
      if (idx !== -1) s.proxyFor[idx] = newId;
    }
  }
}

/** Rename a space: renames all MongoDB collections, moves the file directory, and
 *  updates config references (networks, tokens, proxy spaces).
 *
 *  Crash-safe: a `pendingSpaceOp` marker is persisted BEFORE any MongoDB/fs change
 *  and cleared only once the logical config change commits. The physical move is
 *  idempotent, so a crash mid-rename is completed on the next boot by
 *  reconcilePendingSpaceOp(); a caught error keeps the marker so the operator can
 *  retry (the retry resumes the same op rather than starting over).
 *  Returns the updated SpaceConfig on success. */
export async function renameSpace(oldId: string, newId: string): Promise<SpaceConfig> {
  // Crash recovery must not run against a rename that is still running HERE. The marker written below is
  // what `reconcilePendingSpaceOp` acts on, and that reconciler also runs on the config-reload path — so
  // without this, a config reload during the collection work starts a SECOND `moveSpaceData` over the same
  // collections, and whichever loses reports `Source collection … does not exist` on a rename that
  // succeeded. See `beginSpaceOp` in `_shared.ts`.
  beginSpaceOp();
  try {
    return await renameSpaceInner(oldId, newId);
  } finally {
    endSpaceOp();
  }
}

async function renameSpaceInner(oldId: string, newId: string): Promise<SpaceConfig> {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === oldId);
  if (!space) throw new Error(`Space '${oldId}' not found`);
  if (space.builtIn) throw new Error(`Cannot rename built-in space '${oldId}'`);
  if (cfg.spaces.some(s => s.id === newId)) throw new Error(`Space '${newId}' already exists`);

  const resuming = cfg.pendingSpaceOp?.type === 'rename'
    && cfg.pendingSpaceOp.spaceId === oldId
    && cfg.pendingSpaceOp.newId === newId;
  if (cfg.pendingSpaceOp && !resuming) {
    throw new Error(pendingOpConflictMessage(cfg.pendingSpaceOp, `rename space '${oldId}'`));
  }

  // Write-ahead: record the intent (atomically) before touching MongoDB/fs.
  if (!resuming) {
    cfg.pendingSpaceOp = { type: 'rename', spaceId: oldId, newId, startedAt: new Date().toISOString() };
    saveConfig(cfg);
  }

  const errors = await moveSpaceData(oldId, newId);
  if (errors.length > 0) {
    // Keep the marker — the rename is incomplete but idempotent, so a retry or the
    // next boot resumes it. Config still points at the old id until it commits.
    throw new Error(
      `Space '${oldId}' rename incomplete (${errors.length} error(s)). ` +
      `Rename will be resumed on retry or next restart. ` +
      `Errors: ${errors.join('; ')}`,
    );
  }

  // Commit: physical move done — apply the logical config change and clear the marker in one
  // atomic write.
  //
  // Re-resolve the space by id inside the write instead of committing the `space` object looked up
  // at the top. That lookup happened before `moveSpaceData`, which renames every collection and takes
  // seconds; a config reload landing in that window replaces `cfg.spaces` wholesale and leaves the
  // reference orphaned. Mutating the orphan and saving produced the worst possible outcome: the API
  // returned 200, the collections had moved, and config still carried the OLD id — so the rename
  // silently did not happen and every lookup under the new id 404'd.
  let renamed: SpaceConfig | undefined;
  mutateConfig(fresh => {
    const live = fresh.spaces.find(s => s.id === oldId);
    if (!live) return; // already committed by a concurrent resume — nothing left to do
    applySpaceRenameToConfig(fresh, live, oldId, newId);
    delete fresh.pendingSpaceOp;
    renamed = live;
  });
  if (!renamed) {
    // The physical move succeeded, so treat an already-committed config as success rather than
    // failing a rename that has, in fact, happened.
    const committed = getConfig().spaces.find(s => s.id === newId);
    if (!committed) throw new Error(`Space '${oldId}' rename committed no config change — refusing to report success`);
    log.info(`Renamed space '${oldId}' → '${newId}' (config already committed)`);
    return committed;
  }
  log.info(`Renamed space '${oldId}' → '${newId}'`);
  return renamed;
}
