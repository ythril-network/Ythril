/**
 * Change the LIVE config entry of some spaces, and save the config once if anything changed.
 *
 * ## What it prevents
 *
 * Local bookkeeping about a space's disk (`SpaceConfig.deliveredByBackfilled`, `SpaceConfig.leakedRowScan`) lives on the config entry, and
 * two sites each wrote the same four steps by hand: read the config AFTER their awaits, find the entry, change it, save. The steps are
 * the part a copy drops one of: a config taken before an await can be a reload behind, so the save writes a stale object over what a
 * concurrent edit put on disk; an entry that is no longer there (a space deleted while the work ran) must be skipped and not assumed; and a
 * save with nothing changed is a config write for no reason. Written here once, the read is the live one and the save is conditional.
 *
 * `change` returns whether it changed the entry. An id with no entry is skipped. Returns whether anything was saved. It is for a field
 * that is bookkeeping about THIS instance: a field a peer or an operator authors goes through the config's own writers, which merge.
 */
import { getConfig, saveConfig } from './loader.js';
import type { SpaceConfig } from './types.js';

export function changeSpaceEntries(spaceIds: readonly string[], change: (entry: SpaceConfig) => boolean): boolean {
  const cfg = getConfig();
  let changed = false;
  for (const id of spaceIds) {
    const entry = cfg.spaces.find(s => s.id === id);
    if (entry !== undefined && change(entry)) changed = true;
  }
  if (changed) saveConfig(cfg);
  return changed;
}
