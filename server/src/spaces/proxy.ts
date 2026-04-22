import { getConfig } from '../config/loader.js';
import type { SpaceConfig } from '../config/types.js';

/** Returns true if the space is a proxy space (has proxyFor member list). */
export function isProxySpace(spaceId: string): boolean {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  return !!(space?.proxyFor && space.proxyFor.length > 0);
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

/** Returns true if strict linkage enforcement is enabled for a space. */
export function isStrictLinkage(spaceId: string): boolean {
  return findSpace(spaceId)?.meta?.strictLinkage === true;
}
