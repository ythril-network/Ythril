/**
 * What a config reload does to the space list — added, removed, and kept against the file (S-10).
 *
 * `applyConfigFromDisk` used to take `config.json` as the truth: a space in memory and absent from the file simply
 * left config, its collections stayed in Mongo as orphans, and nothing but the watcher's "reloading" line said so.
 * Any writer of that file — a deploy step, a second replica on the same volume, a restore, a hand edit — deleted
 * spaces as far as every surface could see.
 *
 * So a space missing from the reloaded file is KEPT, unless the file says it goes: named in `removeSpaces`, or taken
 * away by the in-flight rename or delete its `pendingSpaceOp` records. Everything added, removed and kept is returned
 * by id, so the caller restores what is kept and audits every one. Pure, so the decision is tested without a stack.
 */
import type { PendingSpaceOp, SpaceConfig } from './types.js';

export interface ReloadSpaceDiff {
  /** Ids the file adds. */
  added: string[];
  /** Ids the file removes, explicitly: in `removeSpaces`, or by the in-flight space op. */
  removed: string[];
  /** Spaces missing from the file with no explicit removal: the in-memory entry is put back. */
  kept: SpaceConfig[];
}

export function reloadSpaceDiff(
  before: readonly SpaceConfig[],
  after: { spaces: readonly SpaceConfig[]; removeSpaces?: readonly string[]; pendingSpaceOp?: PendingSpaceOp },
): ReloadSpaceDiff {
  const afterIds = new Set(after.spaces.map(s => s.id));
  const beforeIds = new Set(before.map(s => s.id));
  const explicit = new Set(after.removeSpaces ?? []);
  if (after.pendingSpaceOp) explicit.add(after.pendingSpaceOp.spaceId);
  const missing = before.filter(s => !afterIds.has(s.id));
  return {
    added: after.spaces.map(s => s.id).filter(id => !beforeIds.has(id)),
    removed: missing.filter(s => explicit.has(s.id)).map(s => s.id),
    kept: missing.filter(s => !explicit.has(s.id)),
  };
}
