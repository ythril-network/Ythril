/**
 * A space's config entry as a caller may read it — the ONE place that shapes a `SpaceConfig` for the wire.
 *
 * ## What it prevents
 *
 * The space routes answered the live config entry whole (`{ space }` after a rename, a create, a meta change, a schema replacement), and
 * the MCP rename tool the same. A key on that entry is not always the caller's to read: `leakedRowScan` is where the leaked-rows repair
 * is in this space's files, and it carries the NAME OF A FILE PATH (the cursor of its link phase is the last source it read), which a
 * token with a `knowledge` or `schema` right on the space has no business learning, and which means nothing to a client. A field added
 * to the entry tomorrow is answered by the same four lines unless one function decides, so one function does.
 *
 * ## What it removes
 *
 * {@link LOCAL_BOOKKEEPING_KEYS}: bookkeeping about THIS disk that lives on the entry because a rename carries it with the space and a
 * deleted space takes it away (`SpaceConfig.leakedRowScan`), never governed, synced, exported or settable through the space API. A copy
 * is returned; the live entry is never touched. `GET /api/spaces` builds its answer field by field from an allowlist and needs none of this.
 */
import type { SpaceConfig } from '../config/types.js';

/** The keys of a space's config entry that are local bookkeeping and never answered. */
export const LOCAL_BOOKKEEPING_KEYS = ['leakedRowScan'] as const satisfies ReadonlyArray<keyof SpaceConfig>;

/** `space` without its local bookkeeping: what a route or a tool answers where it answers a space's entry. */
export function spaceForWire(space: SpaceConfig): SpaceConfig {
  const copy: SpaceConfig = { ...space };
  for (const key of LOCAL_BOOKKEEPING_KEYS) delete copy[key];
  return copy;
}
