import { getConfig } from '../config/loader.js';
import type { SpaceConfig } from '../config/types.js';

/**
 * Whether a space RECORD is a proxy: it names at least one member. A proxy holds no records of its own.
 *
 * Takes the record rather than an id so a caller already holding one (a loop over the configured spaces)
 * asks the same question without a second lookup, and so the rule can be exercised without a config. An
 * empty member list is a real space, which only a hand-edited config can produce — the API refuses one.
 */
export function isProxy(space: { proxyFor?: string[] } | undefined): boolean {
  return !!(space?.proxyFor && space.proxyFor.length > 0);
}

/** Returns true if the space is a proxy space (has proxyFor member list). */
export function isProxySpace(spaceId: string): boolean {
  return isProxy(getConfig().spaces.find(s => s.id === spaceId));
}

/** Get the SpaceConfig for a given id, or undefined. */
export function findSpace(spaceId: string): SpaceConfig | undefined {
  return getConfig().spaces.find(s => s.id === spaceId);
}

/**
 * Resolve the member space IDs for a given space.
 * - Regular space  → [spaceId]
 * - Proxy space with specific IDs → those IDs
 * - Proxy space with ['*'] wildcard → all current non-proxy space IDs
 */
export function resolveMemberSpaces(spaceId: string): string[] {
  const space = findSpace(spaceId);
  if (!space) return [];
  if (space.proxyFor && space.proxyFor.length > 0) {
    if (space.proxyFor.length === 1 && space.proxyFor[0] === '*') {
      // Wildcard: proxy for all non-proxy spaces at query time
      return getConfig().spaces
        .filter(s => !s.proxyFor || s.proxyFor.length === 0)
        .map(s => s.id);
    }
    return space.proxyFor;
  }
  return [spaceId];
}

/**
 * Validate and resolve a targetSpace parameter for a write operation on a proxy space.
 * Returns the resolved target space ID, or an error string.
 */
export function resolveWriteTarget(
  spaceId: string,
  targetSpace: string | undefined,
): { ok: true; target: string } | { ok: false; error: string } {
  const space = findSpace(spaceId);
  if (!space) return { ok: false, error: `Space '${spaceId}' not found` };

  // Regular space — ignore targetSpace, write directly
  if (!space.proxyFor || space.proxyFor.length === 0) {
    return { ok: true, target: spaceId };
  }

  // Proxy space — targetSpace is required
  if (!targetSpace) {
    const members = resolveMemberSpaces(spaceId);
    return {
      ok: false,
      error: `This is a proxy space. Specify targetSpace (one of: ${members.join(', ')})`,
    };
  }

  // Wildcard proxy — any non-proxy space is a valid target
  if (space.proxyFor.length === 1 && space.proxyFor[0] === '*') {
    const target = findSpace(targetSpace);
    if (!target) return { ok: false, error: `Target space '${targetSpace}' not found` };
    if (target.proxyFor && target.proxyFor.length > 0) {
      return { ok: false, error: `'${targetSpace}' is itself a proxy space and cannot be a write target` };
    }
    return { ok: true, target: targetSpace };
  }

  if (!space.proxyFor.includes(targetSpace)) {
    return {
      ok: false,
      error: `'${targetSpace}' is not a member of proxy space '${spaceId}' (members: ${space.proxyFor.join(', ')})`,
    };
  }

  return { ok: true, target: targetSpace };
}

/**
 * Whether a space enforces that a reference field actually contains record IDs.
 *
 * **Defaults to ON** — absent means strict. It used to default off, which meant the safe behaviour
 * was the one nobody opted into: a name (or a typo, or an id from another space) landed in
 * `entityIds` unvalidated, the write returned success, and the missing link only surfaced later as a
 * traversal that quietly returned nothing.
 *
 * The opt-out survives for the case that justified it: importing records whose targets do not exist
 * yet, where refs are resolved in a later pass. Turning it off is a deliberate, per-space choice to
 * accept dangling references — not something you get by saying nothing.
 */
export function isStrictLinkage(spaceId: string): boolean {
  return findSpace(spaceId)?.meta?.strictLinkage !== false;
}

// ── Member fan-out ─────────────────────────────────────────────────────────
// A proxy space reads/writes across its member spaces. Two shapes recur across the REST brain
// routes and MCP tools: "try each member in order, stop at the first hit" (get/update/delete by id)
// and "query every member and flatten" (list/search). These two helpers centralise both so proxy
// semantics (member ordering, the resolve step) stay uniform instead of being re-derived ~40 times.

/**
 * Run `fn` against each member space **in order** and return the first accepted result — the
 * proxy read/update-by-id pattern (the record lives in exactly one member). `accept` decides what
 * counts as a hit; it defaults to "non-null", which also treats a truthy boolean (e.g. a
 * `deleteX() → boolean`) as a hit. Members after the first hit are not visited. Returns the
 * accepted result, or `undefined` if no member produced one.
 */
export async function findFirstAcrossMembers<T>(
  spaceId: string,
  fn: (memberId: string) => Promise<T>,
  accept: (result: T) => boolean = (r): boolean => r != null && r !== false,
): Promise<T | undefined> {
  for (const member of resolveMemberSpaces(spaceId)) {
    const result = await fn(member);
    if (accept(result)) return result;
  }
  return undefined;
}

/**
 * Run `fn` against every member space **concurrently** and flatten the per-member arrays into one
 * — the proxy list/search pattern. Preserves member order in the flattened output (Promise.all
 * keeps input order). The caller still applies any paging/cap to the combined result.
 */
export async function collectAcrossMembers<T>(
  spaceId: string,
  fn: (memberId: string) => Promise<T[]>,
): Promise<T[]> {
  const perMember = await Promise.all(resolveMemberSpaces(spaceId).map(fn));
  return perMember.flat();
}
