import { getConfig, isConfigLoaded } from '../config/loader.js';
import type { SpaceConfig } from '../config/types.js';

/**
 * Whether a space RECORD is a proxy: it names at least one member. A proxy holds no records of its own.
 *
 * Takes the record rather than an id so a caller already holding one (a loop over the configured spaces)
 * asks the same question without a second lookup, and so the rule can be exercised without a config. An
 * empty member list is a real space, which only a hand-edited config can produce — the API refuses one, and
 * the loader removes it (`normaliseLoadedConfig`), so no reader meets it.
 *
 * THE ONLY place `proxyFor` is tested (`Q-80`). It was tested about forty times in two spellings, truthy and
 * non-empty, which disagree on exactly that empty list — so such a space was served as a real space and
 * skipped as a proxy by the embed worker, the scanners, the prunes and the metrics, and deleted as a proxy
 * with its collections left behind. `a-proxy-is-asked-one-way.test.js` reads the syntax tree and refuses a
 * hand-written test anywhere else. Anything shaped `{ proxyFor?: string[] }` may be asked — a request body,
 * a refusal body — because the question is the same one.
 */
export function isProxy(space: { proxyFor?: string[] } | undefined): boolean {
  return !!(space?.proxyFor && space.proxyFor.length > 0);
}

/** Whether a space is the `['*']` proxy — a proxy over every concrete space, resolved at query time. */
export function isWildcardProxy(space: { proxyFor?: string[] } | undefined): boolean {
  return isProxy(space) && space!.proxyFor!.length === 1 && space!.proxyFor![0] === '*';
}

/**
 * The configured spaces that OWN collections — every space that is not a proxy — as a fresh array.
 *
 * ## Why this exists (`Q-98`)
 *
 * *"For each configured space, skip the proxies"* was written by hand at every sweep, scanner, prune and metrics
 * collector, each with its own proxy test and, in about half, its own `try { getConfig() } catch` for the
 * pre-setup case. The loops that FORGOT were worse than the copies: `initAllSpaces` created every proxy's
 * collections at every boot, the restore rebuild reconciled proxies' search indexes, and neither said so.
 * `every-concrete-space-loop-uses-one-helper.test.js` refuses a hand-written skip in a walk over the
 * configured spaces, and a walk that opens a space collection over anything but this.
 *
 * ## The two guards a hand-written copy dropped
 *
 *   - **Pre-setup is an empty list**, answered here once. Only the not-loaded case: any other failure of the
 *     config still throws, because an empty answer where there should have been an error moves the bug.
 *   - **A snapshot.** The array is new, so a reload during the caller's awaits cannot change what it walks. The
 *     SpaceConfig objects in it are the live ones and become detached by a reload — read them freely, but a
 *     caller that WRITES a space's config re-resolves it by id inside the write, as `renameSpace` does.
 */
export function concreteSpaces(): SpaceConfig[] {
  if (!isConfigLoaded()) return [];
  return getConfig().spaces.filter(s => !isProxy(s));
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
 * - Proxy space with ['*'] wildcard → all current concrete space IDs
 */
export function resolveMemberSpaces(spaceId: string): string[] {
  const space = findSpace(spaceId);
  if (!space) return [];
  if (isWildcardProxy(space)) return concreteSpaces().map(s => s.id);
  if (isProxy(space)) return space.proxyFor!;
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
  if (!isProxy(space)) {
    return { ok: true, target: spaceId };
  }
  const members = space.proxyFor!;

  // Proxy space — targetSpace is required
  if (!targetSpace) {
    return {
      ok: false,
      error: `This is a proxy space. Specify targetSpace (one of: ${resolveMemberSpaces(spaceId).join(', ')})`,
    };
  }

  // Wildcard proxy — any non-proxy space is a valid target
  if (isWildcardProxy(space)) {
    const target = findSpace(targetSpace);
    if (!target) return { ok: false, error: `Target space '${targetSpace}' not found` };
    if (isProxy(target)) {
      return { ok: false, error: `'${targetSpace}' is itself a proxy space and cannot be a write target` };
    }
    return { ok: true, target: targetSpace };
  }

  if (!members.includes(targetSpace)) {
    return {
      ok: false,
      error: `'${targetSpace}' is not a member of proxy space '${spaceId}' (members: ${members.join(', ')})`,
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
