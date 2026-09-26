/**
 * Repair instance-admin tokens stored without their space-admin floor, once, on boot.
 *
 * An instance admin holds space admin on the floor (`auth/instance-admin-grants.ts`) — that was the behaviour, and
 * tokens stored while the grant was missing came back reaching only the spaces they have rows for: an instance
 * admin refused its own instance's spaces. Writes apply the grant again; this repairs the tokens stored meanwhile.
 *
 * A BOOT migration because tokens are local config and never replicate: there is no peer to write the old
 * shape back, and no lazy path to prefer. Idempotent — a token that already holds the floor is left alone.
 * Every token it repairs is named in the log.
 */
import type { TokenRecord } from './types.js';
import { withInstanceAdminGrants } from '../auth/instance-admin-grants.js';
import { log } from '../util/log.js';

export interface InstanceAdminFloorOutcome {
  /** Ids of the tokens that gained the floor. */
  granted: string[];
}

/** Rewrite in place and report which tokens changed, so the caller can persist and the log can name them. */
export function migrateInstanceAdminFloor(tokens: TokenRecord[] | undefined): InstanceAdminFloorOutcome {
  const out: InstanceAdminFloorOutcome = { granted: [] };
  for (const token of tokens ?? []) {
    const next = withInstanceAdminGrants(token.rights);
    if (next === token.rights) continue;
    token.rights = next;
    out.granted.push(token.id);
  }
  if (out.granted.length > 0) {
    log.info(`Restored the space-admin floor on ${out.granted.length} instance-admin token(s) stored without it: `
      + `${out.granted.join(', ')}.`);
  }
  return out;
}
