/**
 * The 6.0 upgrade: a proxy space becomes personal views, by one pure transform of the parsed config (Q-531).
 *
 * ## The rule
 *
 * A pre-6.0 proxy is a `config.spaces` entry with a NON-EMPTY `proxyFor` (`proxyFor: []` is a real space, Q-80). Each one becomes a
 * personal view named for it, owned by EACH live instance-admin token (so each copy is private and revoking one admin token removes only
 * its own copies); when no live instance-admin token exists the definition is kept in `unclaimedViews` for an instance admin to claim, and
 * is never lost. The old id leaves `spaces`, every network, and every token's rights rows, and is RESERVED in `retiredSpaceIds`: creating,
 * renaming or joining under it is refused until an admin purges it, and every door that names it answers `410 space_retired`.
 *
 * ## What it must not do
 *
 * - **It reads and saves nothing but the object it is handed** (`loadConfig` saves after it; `reloadConfig`, whose contract is that it
 *   saves nothing, does not). A transform that called `getConfig()` would migrate a different object than the one being loaded.
 * - **It is idempotent by ORIGIN, not by name**: a second run, and a re-upgrade of a restored 5.x config, add no copy for an owner that
 *   already holds a view `migratedFrom` that proxy; a copy whose name an unrelated view of the same owner holds becomes `-N`.
 * - **A live space wins**: a reserved id that is a space again (created after a rollback) loses its reservation.
 * - **A webhook subscription that named ONLY retired ids is disabled, never emptied**: an empty `spaces` list means every space
 *   ({@link subscriptionAfterRetiredIds}; subscriptions live in Mongo, so a DB-phase boot step applies it).
 */
import type { Config, TokenRecord, ViewRecord } from './types.js';
import { isInstanceAdmin } from '../auth/instance-admin.js';
import { takeSpaceOutOfNetwork } from '../networks/take-space-out-of-network.js';
import { freeViewName, liveOwnerKeys, viewIdOf } from './view-shape.js';

/** What a run did, for the boot log and the durable report. */
export interface ProxyMigrationResult {
  config: Config;
  changed: boolean;
  /** Proxy ids migrated in this run. */
  migrated: string[];
  /** Views created in this run. */
  copies: number;
  /** Proxies kept as unclaimed definitions (no live instance-admin token). */
  unclaimed: string[];
  /** Networks that lost a proxy id in this run. */
  networksLeft: { networkId: string; spaceIds: string[] }[];
}

const isProxyEntry = (s: { proxyFor?: string[] }): boolean => Array.isArray(s.proxyFor) && s.proxyFor.length > 0;

/** Whether a parsed config still holds a pre-6.0 proxy: what the boot asks before it takes the pre-6.0 copy of the file. */
export const holdsLegacyProxies = (cfg: Pick<Config, 'spaces'>): boolean => (cfg.spaces ?? []).some(isProxyEntry);

/** The owner keys of the live instance-admin tokens, each once (two tokens of one connector are one owner). */
function adminOwners(tokens: readonly TokenRecord[], now: number): string[] {
  return [...liveOwnerKeys(tokens.filter(t => isInstanceAdmin(t)), now)];
}

export function migrateProxiesToViews(cfg: Config, now: number = Date.now()): ProxyMigrationResult {
  try {
    return convertProxies(cfg, now);
  } catch (err) {
    // Named, and the file is untouched: the transform saves nothing, so a throw leaves `config.json` exactly as it was.
    throw new Error(`config.json: converting proxy spaces to personal views failed (${err instanceof Error ? err.message : String(err)}); config.json was not changed`);
  }
}

function convertProxies(cfg: Config, now: number): ProxyMigrationResult {
  cfg.spaces ??= [];
  cfg.tokens ??= [];
  cfg.networks ??= [];
  const result: ProxyMigrationResult = { config: cfg, changed: false, migrated: [], copies: 0, unclaimed: [], networksLeft: [] };
  const createdAt = new Date(now).toISOString();
  const proxies = cfg.spaces.filter(isProxyEntry);

  if (proxies.length > 0) {
    cfg.views ??= [];
    const owners = adminOwners(cfg.tokens, now);
    const retired = new Set(cfg.retiredSpaceIds ?? []);
    for (const proxy of proxies) {
      const members = [...new Set(proxy.proxyFor ?? [])];
      if (owners.length === 0) {
        cfg.unclaimedViews ??= [];
        if (!cfg.unclaimedViews.some(u => u.migratedFrom === proxy.id)) {
          cfg.unclaimedViews.push({ name: proxy.id, members, migratedFrom: proxy.id, createdAt });
          result.unclaimed.push(proxy.id);
        }
      }
      for (const owner of owners) {
        const mine = cfg.views.filter(v => v.ownerId === owner);
        if (mine.some(v => v.migratedFrom === proxy.id)) continue;
        const name = freeViewName(proxy.id, new Set(mine.map(v => v.name)));
        const view: ViewRecord = { id: viewIdOf(name), name, ownerId: owner, members: [...members], createdAt, migratedFrom: proxy.id };
        cfg.views.push(view);
        result.copies++;
      }
      cfg.spaces = cfg.spaces.filter(s => s !== proxy);
      for (const net of cfg.networks) {
        const left = takeSpaceOutOfNetwork(net, proxy.id);
        if (left.carried) {
          // Left, not lost: a peer asking for it is answered `423 space_declined` (`refusePeerSpace`), which it records and stops
          // asking for, rather than a 403 it counts as a failed member every cycle.
          if (left.networkSpaceId && !(net.dismissedSpaces ?? []).includes(left.networkSpaceId)) {
            net.dismissedSpaces = [...(net.dismissedSpaces ?? []), left.networkSpaceId];
          }
          const row = result.networksLeft.find(r => r.networkId === net.id);
          if (row) row.spaceIds.push(proxy.id); else result.networksLeft.push({ networkId: net.id, spaceIds: [proxy.id] });
        }
      }
      for (const token of cfg.tokens) {
        const rights = token.rights as { perSpace?: Record<string, unknown>; spaceAdmin?: { spaces?: string[] } } | undefined;
        if (rights?.perSpace && proxy.id in rights.perSpace) delete rights.perSpace[proxy.id];
        if (rights?.spaceAdmin?.spaces?.includes(proxy.id)) rights.spaceAdmin.spaces = rights.spaceAdmin.spaces.filter(id => id !== proxy.id);
      }
      retired.add(proxy.id);
      result.migrated.push(proxy.id);
    }
    cfg.retiredSpaceIds = [...retired];
    result.changed = true;
  }

  // A live space wins over a reservation of its id (a space created after a rollback to 5.x).
  if (cfg.retiredSpaceIds?.length) {
    const live = new Set(cfg.spaces.map(s => s.id));
    const kept = cfg.retiredSpaceIds.filter(id => !live.has(id));
    if (kept.length !== cfg.retiredSpaceIds.length) {
      cfg.retiredSpaceIds = kept;
      result.changed = true;
    }
  }
  if (result.migrated.length > 0) {
    const previous = cfg.viewsMigration;
    cfg.viewsMigration = {
      at: createdAt,
      proxies: [...new Set([...(previous?.proxies ?? []), ...result.migrated])],
      copies: (previous?.copies ?? 0) + result.copies,
      networksLeft: [...(previous?.networksLeft ?? []), ...result.networksLeft],
    };
  }
  return result;
}

/**
 * What a webhook subscription becomes when `retiredIds` are reserved: one that named ONLY retired ids is DISABLED and keeps its list
 * (emptying it would subscribe it to every space); one that named others loses only the retired ones; one that names no space (every
 * space) is not about a retired id and is untouched. Pure; the DB-phase boot step stores what it returns.
 *
 * The disable happens ONCE per set of ids: it records the ids it disabled for (`retiredIdsDisabledFor`), and a subscription whose
 * every id is among them is left as it is. The step runs on every boot, so without the record a subscription an admin re-enabled after
 * the upgrade was disabled again at each restart; an id retired later is a new reason, and disables it again.
 */
export function subscriptionAfterRetiredIds<T extends { spaces: string[]; enabled: boolean; retiredIdsDisabledFor?: string[] | undefined }>(
  subscription: T, retiredIds: readonly string[],
): T {
  if (subscription.spaces.length === 0) return subscription;
  const retired = new Set(retiredIds);
  const remaining = subscription.spaces.filter(id => !retired.has(id));
  if (remaining.length === subscription.spaces.length) return subscription;
  if (remaining.length === 0) {
    const handled = new Set(subscription.retiredIdsDisabledFor ?? []);
    if (subscription.spaces.every(id => handled.has(id))) return subscription;
    return { ...subscription, enabled: false, retiredIdsDisabledFor: [...subscription.spaces] };
  }
  return { ...subscription, spaces: remaining };
}
