import { getConfig, isConfigLoaded } from '../config/loader.js';
import type { SpaceConfig } from '../config/types.js';
import type { Rung, SpaceArea, TokenRights } from '../config/rights-shape.js';
import { NAME_QUOTED, peerText } from '../util/log.js';
import { reachesSpace, reachableSpaceIds } from '../auth/space-reach.js';
import { holdsRung, rungRefusal } from '../auth/reachable-spaces.js';

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

/**
 * The ids of {@link concreteSpaces}, in its order, as a fresh array — for a walk that needs only the ids.
 *
 * "The ids of the spaces that own collections" was spelled four ways (`spaceIds()` in `embed-worker.ts`,
 * `getLocalSpaceIds()` in `media/worker.ts`, and `.map(s => s.id)` inline), and the one thing a copy must not change is
 * the proxy rule, so this derives from `concreteSpaces()` and decides nothing itself (`Q-274`, bundle-53).
 */
export function concreteSpaceIds(): string[] {
  return concreteSpaces().map(s => s.id);
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
 * What resolving a write target answers: the one space the write lands in, or the status and the sentence both doors refuse with.
 *
 * **The status travels WITH the refusal** (`Q-440`). Each door used to answer `wt.error` with a status of its own, always 400, so a
 * refusal the resolver could say as a 403 had nowhere to go; now one helper per door says it (`answerWriteTarget` on REST, a
 * `ToolRefusal` on MCP) and a site that answers the sentence itself is refused by a gate.
 */
export type ResolvedWriteTarget = { ok: true; target: string } | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * What the CALLER may do, handed to every resolution of a write target: the rights matrix it holds, and the area and rung the act
 * needs in the space it lands in. `needs` is `read` for a READ that goes through the resolver (an ingest run's status) and `write`
 * for every write, because the resolver judges the rung on the member the act lands in, not on the proxy it was addressed through.
 *
 * `rights` is optional because the call sites hold it optionally (a tool context, a request's token). **An absent matrix is
 * refused inside the resolver** (no matrix reaches nothing), so no site writes `!` to get past the type.
 */
export interface WriteGrant { rights: TokenRights | undefined; area: SpaceArea; needs: Rung }

/**
 * Validate and resolve a targetSpace parameter for a write operation on a proxy space, against what the caller may reach and do.
 * Returns the resolved target space ID, or a refusal with its status.
 *
 * ## Why the grant is an argument and not a later check (`Q-440`)
 *
 * This answered MEMBERSHIP and never reach: a token holding write on `qa` only wrote into `secret` through a wildcard proxy
 * (`?targetSpace=secret`, 201) on both doors, and the wildcard branch answered a space the token cannot see (201) differently from one
 * that does not exist (400): an existence oracle. Every door checked the rung on the proxy id it was addressed through, which is
 * where an operator grants a proxy, never on the member the write lands in.
 *
 * **The order is the rule:** the target exists -> the token reaches it -> it is not itself a proxy -> the token holds the rung there.
 * A target the token does not reach is refused EXACTLY as one that does not exist (the same status and sentence, with the name the
 * caller sent), so a refusal cannot be read as an inventory; every member list in a refusal is the members the token reaches. Reach
 * and rung are `reachesSpace` and `holdsRung`, and the narrowed member list is `reachableSpaceIds` — never respelled here.
 *
 * **`targetSpace` is `unknown`, and a PRESENT value that is not a string is refused here, first, on every door** (`targetSpace must be
 * a string`), ahead of everything but the absent-matrix refusal: it is whatever a caller chose to send. Express 5 parses `?targetSpace=a&targetSpace=b` to an ARRAY, which the templates
 * below stringified into a misleading "not found" name, and an MCP caller's `{"toString":1}` threw a `TypeError` out of them. Absent is
 * `undefined` or `null` — what a body or query that names no target holds — and an empty string is still "name none" below.
 *
 * **Every name echoed back is rendered by `peerText`**: the space and the target are caller text, and one oversized or line-breaking
 * name neither floods the answer nor forges a line. The member lists are the members THE CALLER reaches (never the proxy's whole
 * configuration), listed as they are.
 */
export function resolveWriteTarget(
  spaceId: string,
  targetSpace: unknown,
  grant: WriteGrant,
): ResolvedWriteTarget {
  // No matrix reaches nothing, and holds no rung anywhere: refused before anything about the instance is said.
  if (!grant.rights) return refuseTarget(403, rungRefusal(grant.needs, grant.area));
  return resolveTarget(spaceId, targetSpace, { ...grant, rights: grant.rights });
}

/** What {@link resolveTarget} judges against: the caller's grant with its matrix present, or `null` for membership alone. */
type TargetScope = (WriteGrant & { rights: TokenRights }) | null;

function refuseTarget(status: 400 | 403 | 404, error: string): ResolvedWriteTarget {
  return { ok: false, status, error };
}

/**
 * The one resolution, against a scope. `scope === null` answers membership only — the dispatcher's pre-resolution
 * ({@link resolveCallWriteTarget}) until it passes the caller's grant; every other caller reaches this through `resolveWriteTarget`.
 */
function resolveTarget(spaceId: string, targetSpace: unknown, scope: TargetScope): ResolvedWriteTarget {
  if (targetSpace !== undefined && targetSpace !== null && typeof targetSpace !== 'string') {
    return refuseTarget(400, 'targetSpace must be a string');
  }
  const space = findSpace(spaceId);
  const shownSpace = peerText(spaceId, { max: NAME_QUOTED });
  const noSuchSpace = (): ResolvedWriteTarget => refuseTarget(404, `Space '${shownSpace}' not found`);
  if (!space) return noSuchSpace();
  const reaches = (id: string): boolean => scope === null || reachesSpace(scope.rights, id);
  /** The rung's refusal on a space the token reaches, or `null`. */
  const lacksRung = (id: string): ResolvedWriteTarget | null =>
    scope === null || holdsRung(scope.rights, id, scope.area, scope.needs)
      ? null
      : refuseTarget(403, rungRefusal(scope.needs, scope.area, id));

  // Regular space — ignore targetSpace, write directly
  if (!isProxy(space)) {
    if (!reaches(spaceId)) return noSuchSpace();
    return lacksRung(spaceId) ?? { ok: true, target: spaceId };
  }
  const members = space.proxyFor!;
  // The members THIS caller reaches: the only ones a refusal may name. `reachableSpaceIds` and not `memberSpacesForToken`: that one is
  // called by `spaces/proxy-scoped.ts` alone (`proxy-reach.test.js`), which imports this module — a call from here would be a cycle.
  const reached = scope === null ? resolveMemberSpaces(spaceId) : reachableSpaceIds(scope.rights, resolveMemberSpaces(spaceId));

  // Proxy space — targetSpace is required (an absent value and an empty string both name none)
  const named = typeof targetSpace === 'string' ? targetSpace : '';
  if (!named) {
    // A proxy none of whose members the caller reaches names nothing it may see: it is not a space to this caller.
    if (reached.length === 0) return noSuchSpace();
    return refuseTarget(400, `This is a proxy space. Specify targetSpace (one of: ${reached.join(', ')})`);
  }
  const shown = peerText(named, { max: NAME_QUOTED });
  const target = findSpace(named);
  // Wildcard proxy — any non-proxy space is a valid target; an explicit one — its members. Either way, a space that is absent, not a
  // member, or not reached is the one answer.
  const notATarget = isWildcardProxy(space)
    ? refuseTarget(400, `Target space '${shown}' not found`)
    : refuseTarget(400, `'${shown}' is not a member of proxy space '${shownSpace}' (members: ${reached.join(', ')})`);
  if (!target || !reaches(named)) return notATarget;
  if (!isWildcardProxy(space) && !members.includes(named)) return notATarget;
  // Only the wildcard names a space nobody listed. An explicit proxy's member that is itself a proxy is a hand-edited config (the API
  // refuses to create one, `space-create-contract`), and its answer is unchanged by `Q-440`: that nesting is the config's, not a caller's.
  if (isWildcardProxy(space) && isProxy(target)) {
    return refuseTarget(400, `'${shown}' is itself a proxy space and cannot be a write target`);
  }
  return lacksRung(named) ?? { ok: true, target: named };
}

/**
 * The write target of a tool CALL, resolved by the dispatcher itself (`callTool`) — the ONE way the dispatcher resolves one.
 *
 * It exists because the unknown-write-field judge answers by the setting of the space the write LANDS in, so the dispatcher must know the
 * target before any handler runs, and a second reading of `targetSpace` out of the arguments there would be a second implementation of
 * the proxy rules. The handlers keep their own `resolveWriteTarget` call with the caller's grant, which is the check that decides
 * reach and rung: a handler that skipped it would be caught by the gate that holds every call to pass its grant.
 *
 * **WITHOUT a grant it answers MEMBERSHIP ONLY, and that is the interim state, not a design** (`Q-440`): the dispatcher is the one
 * caller that does not pass the caller's grant yet, so its pre-resolution still names members the token does not reach (the "no
 * target" refusal lists them all) and judges unknown fields by the setting of a space the token may not reach. The dispatcher passes
 * `{ rights, area, needs }` from its tool's `TOOL_RIGHTS` row (`toolWriteGrant`), forwards the refusal's `status`, and then `grant`
 * here becomes required and the membership path goes.
 *
 * `args` is the caller's own object, so `targetSpace` is read as `unknown` and the resolution refuses a non-string.
 */
export function resolveCallWriteTarget(
  callSpace: string, args: Readonly<Record<string, unknown>>, grant?: WriteGrant,
): ResolvedWriteTarget {
  const targetSpace = Object.hasOwn(args, 'targetSpace') ? args['targetSpace'] : undefined;
  return grant ? resolveWriteTarget(callSpace, targetSpace, grant) : resolveTarget(callSpace, targetSpace, null);
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
 *
 * **What it walks is the caller's to state, and never a raw proxy id** (`Q-440`): a resolved write target (`wt.target`, one real space)
 * or the members the caller reaches (`memberSpacesForRequest` / `memberSpacesForToken` / `memberSpacesWithin`, an array). Handed a
 * proxy's own id it visits EVERY member, including ones the caller cannot see, and `204` against `404` says whether a record exists
 * there. `every-proxy-write-door-resolves-its-target-with-the-callers-grant.test.js` refuses any other first argument.
 */
export async function findFirstAcrossMembers<T>(
  walk: string | readonly string[],
  fn: (memberId: string) => Promise<T>,
  accept: (result: T) => boolean = (r): boolean => r != null && r !== false,
): Promise<T | undefined> {
  for (const member of typeof walk === 'string' ? resolveMemberSpaces(walk) : walk) {
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
