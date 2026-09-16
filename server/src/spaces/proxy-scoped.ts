/**
 * A proxy space's members, narrowed to what the CALLER may see.
 *
 * ## What this is for
 *
 * `resolveMemberSpaces(spaceId)` answers "what does this proxy contain". Every read path fans out over that answer.
 * Q-6 lets a token that reaches only SOME members use a proxy, at which point "what does it contain" and "what may
 * this caller see" stop being the same question — and a fan-out that keeps asking the first one serves records from
 * a space the caller cannot see, with a well-formed `200` and nothing to notice.
 *
 * So this is the version the read paths should call. `auth/proxy-reach.ts` holds the rule and stays pure; this adds
 * the two things it deliberately does not know — the config lookup, and where a request keeps its token.
 *
 * ## It is a NO-OP until the guard changes, on purpose
 *
 * `enforceSpaceScope` still requires a token to reach **every** member, so any caller that gets this far already
 * reaches all of them and the narrowed list equals the full one. That is what makes converting 28 call sites a
 * provable no-op, and it reduces the actual behaviour change to one line in the guard afterwards.
 *
 * The reverse order is the leak: flip the guard first and every un-narrowed site is serving another space's records
 * until it is converted.
 *
 * ## Why the request is structurally typed
 *
 * `req: { authToken?: unknown }` is the idiom already used by `accessibleSpaces` in `api/conflicts.ts`,
 * `api/contradictions.ts` and `api/duplicates.ts`. It keeps this module out of the Express type graph, and it is
 * what lets the MCP tools — which have a call context rather than a request — use `memberSpacesForToken` directly
 * instead of faking a request object.
 */

import { resolveMemberSpaces } from './proxy.js';
import { memberSpacesForToken } from '../auth/proxy-reach.js';
import type { TokenRights } from '../config/rights-shape.js';

/** The token fields that decide reach. Extracted the same way the three `accessibleSpaces` helpers do it. */
type Bearer = { rights?: TokenRights; spaces?: string[] } | undefined;

/**
 * The members of `spaceId` this request may see. For a non-proxy space this is `[spaceId]` when the caller reaches
 * it, and `[]` when it does not.
 *
 * **An empty result is meaningful and must not be treated as "all".** That inversion — reading an empty allowlist as
 * unrestricted — has been a real defect in three separate files in this repo, and here it would turn the narrowest
 * caller into the widest. A caller that gets `[]` should answer 403 or return nothing, never fall back.
 */
export function memberSpacesForRequest(req: { authToken?: unknown }, spaceId: string): string[] {
  const t = req.authToken as Bearer;
  return memberSpacesForToken(t?.rights, resolveMemberSpaces(spaceId));
}

/**
 * The same, for SEVERAL spaces at once — what a `space` list resolves to.
 *
 * Not `list.flatMap(memberSpacesForRequest)` written at each door. Two things have to happen and both are
 * easy to leave out of a hand-written copy:
 *
 * - **A proxy in the list expands to its members.** A proxy space holds no records of its own, so a list
 *   naming one and not expanding it reads an empty collection and answers "nothing found" — the caller
 *   named a space and got silence.
 * - **The result is DEDUPLICATED.** A caller may name a proxy and one of its members, and the reachable
 *   set already contains both; reading a space twice doubles every match it contributes, which looks like
 *   duplicate data rather than like a bug in the fan-out.
 *
 * Order follows the caller's list, so a response merged across spaces is stable between identical calls.
 */
export function memberSpacesForRequestAcross(req: { authToken?: unknown }, spaceIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const sid of spaceIds) for (const mid of memberSpacesForRequest(req, sid)) out.add(mid);
  return [...out];
}

/**
 * The same narrowing for a caller that holds a token record rather than a request — the MCP tools.
 *
 * Separate from the request form rather than sharing it through a fake `{ authToken }` wrapper: a synthesised
 * request object is a lie that the next reader has to unpick, and it invites someone to pass a real request where a
 * record was meant.
 */
export function memberSpacesForRecord(record: Bearer, spaceId: string): string[] {
  return memberSpacesForToken(record?.rights, resolveMemberSpaces(spaceId));
}

/**
 * The members of `spaceId` that appear in an already-narrowed accessible list.
 *
 * For the MCP tools, which hold no request and no token record — they are handed an `accessibleSpaceIds` list built
 * once per connection. Since #786 that list comes from the rights matrix, so intersecting with it gives the same
 * answer `memberSpacesForRequest` would, without threading rights down to every tool.
 *
 * **`accessible` must already be the narrowed set.** If a caller passes every space in the config, this narrows
 * nothing and the name lies. It is not defensive about that on purpose: a check here could only compare the list
 * against itself, and the honest place to be sure is the one line in `mcp/router.ts` that builds it.
 */
export function memberSpacesWithin(spaceId: string, accessible: readonly string[]): string[] {
  const allowed = new Set(accessible);
  return resolveMemberSpaces(spaceId).filter(id => allowed.has(id));
}
