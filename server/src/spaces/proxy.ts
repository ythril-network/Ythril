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
 * - Regular space → [spaceId]
 * - Proxy space   → proxyFor array (validated that all members exist)
 */
export function resolveMemberSpaces(spaceId: string): string[] {
  const space = findSpace(spaceId);
  if (!space) return [];
  if (space.proxyFor && space.proxyFor.length > 0) {
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
    return {
      ok: false,
      error: `This is a proxy space. Specify targetSpace (one of: ${space.proxyFor.join(', ')})`,
    };
  }

  if (!space.proxyFor.includes(targetSpace)) {
    return {
      ok: false,
      error: `'${targetSpace}' is not a member of proxy space '${spaceId}' (members: ${space.proxyFor.join(', ')})`,
    };
  }

  return { ok: true, target: targetSpace };
}
