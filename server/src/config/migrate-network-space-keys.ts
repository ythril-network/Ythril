/**
 * Re-key what an older rename left under a space's OLD local id (`Q-133`).
 *
 * Before Q-133 a rename moved a network's space list and its alias, but not the two things a network keeps keyed by
 * the LOCAL id: the schema layer the network governs (`schemaLayers`) and who established the membership
 * (`spaceOrigins`). They stayed under the old name — so the network's layer dropped out of the space's effective
 * meta and the leave rule could no longer find who joined it. The dev instance's network showed exactly that: layers
 * under `flows`, `y-projects` and `y-twin` beside the live ones.
 *
 * ## What it does, and what it never does
 *
 * A key K the network does not carry under K is moved to `spaceMap[K]` — K is an old local name the rename turned
 * into an alias key, so the alias says where it belongs — when that space is carried here and has no entry of its
 * own. Otherwise it is LEFT, and logged once: an orphan costs nothing, and a dropped voted-network layer could never
 * be fetched again (a voted network has no meta pull; its layer arrives with a round). No spaceMap key is touched —
 * a later key for a space is an inbound alias a member may still use.
 *
 * Local state only (config.json does not sync), so a boot migration is the right shape; idempotent, computed first
 * and applied in one assignment per map, and it never throws out of `loadConfig`.
 */
import type { Config } from './types.js';
import { log } from '../util/log.js';

type Keyed = Record<string, unknown>;

function rekey(map: Keyed | undefined, carried: readonly string[], alias: Record<string, string>, what: string, networkId: string): Keyed | null {
  if (!map) return null;
  let changed = false;
  const next: Keyed = { ...map };
  for (const key of Object.keys(map)) {
    if (carried.includes(key)) continue;
    const target = alias[key];
    if (target !== undefined && carried.includes(target) && next[target] === undefined) {
      next[target] = next[key];
      delete next[key];
      changed = true;
      log.info(`Network ${networkId}: moved the ${what} kept under '${key}' to the space now called '${target}'`);
    } else {
      log.info(`Network ${networkId}: left the ${what} under '${key}' in place — no carried space it belongs to`);
    }
  }
  return changed ? next : null;
}

/** @returns whether anything was re-keyed (the caller saves). */
export function migrateNetworkSpaceKeys(config: Pick<Config, 'networks'>): boolean {
  let changed = false;
  for (const net of config.networks ?? []) {
    try {
      const alias = net.spaceMap ?? {};
      const layers = rekey(net.schemaLayers as Keyed | undefined, net.spaces, alias, 'schema layer', net.id);
      const origins = rekey(net.spaceOrigins as Keyed | undefined, net.spaces, alias, 'membership origin', net.id);
      if (layers) { net.schemaLayers = layers as typeof net.schemaLayers; changed = true; }
      if (origins) { net.spaceOrigins = origins as typeof net.spaceOrigins; changed = true; }
    } catch (err) {
      log.warn(`Network ${net.id}: could not re-key its per-space entries (will retry next boot): ${err}`);
    }
  }
  return changed;
}
