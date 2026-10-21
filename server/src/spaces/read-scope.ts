/**
 * The spaces a read touches: the one it names, or the members of the personal view it names, for THIS caller (Q-531).
 *
 * ## Two doors, one answer
 *
 * A read door that names a space reads that space when the caller reaches it. One that names the caller's own view reads the members the
 * view stands for, narrowed per member to what the caller reads in the door's area at call time - decided ONCE, at the door's guard
 * (`viewReadMembers`), and read from there: a REST path route from `req.viewRead` (`readSpacesOfRequest`), an MCP tool from the view
 * reads the dispatcher handed it (`readSpacesOfCall`). Neither recomputes the narrowing, so no handler can widen it.
 *
 * **An empty answer is meaningful and must not be read as "all"**: the caller reaches nothing it named, or the view reads nothing for it
 * now. A caller that gets `[]` answers an empty result (a view) or refuses (a space), never falls back to every space.
 */
import { reachesSpace } from '../auth/space-reach.js';
import type { TokenRights } from '../config/rights-shape.js';

/** The request half: who is asking, and the view the guard accepted for this request. */
export interface ReadRequest {
  authToken?: unknown;
  viewRead?: { id: string; spaces: readonly string[] } | undefined;
}

/** The spaces the request reads for `spaceId`: the accepted view's members, or `[spaceId]` when the caller reaches it, else `[]`. */
export function readSpacesOfRequest(req: ReadRequest, spaceId: string): string[] {
  if (req.viewRead && req.viewRead.id === spaceId) return [...req.viewRead.spaces];
  const rights = (req.authToken as { rights?: TokenRights } | undefined)?.rights;
  return rights && reachesSpace(rights, spaceId) ? [spaceId] : [];
}

/** The same for a request that names several spaces at once: the union in the caller's order, each space once. */
export function readSpacesOfRequestAcross(req: ReadRequest, spaceIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of spaceIds) for (const s of readSpacesOfRequest(req, id)) out.add(s);
  return [...out];
}

/** The tool half: what the dispatcher resolved for this call. */
export interface ReadCall {
  viewReads: ReadonlyMap<string, readonly string[]>;
  accessibleSpaceIds: readonly string[];
}

/** The spaces a tool call reads for `space`: the view's members, or `[space]` when the connection reaches it, else `[]`. */
export function readSpacesOfCall(ctx: ReadCall, space: string): string[] {
  const view = ctx.viewReads.get(space);
  if (view) return [...view];
  return ctx.accessibleSpaceIds.includes(space) ? [space] : [];
}

/** The same for the several spaces a search names: the union in the caller's order, each space once. */
export function readSpacesOfCallAcross(ctx: ReadCall, spaces: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of spaces) for (const m of readSpacesOfCall(ctx, s)) out.add(m);
  return [...out];
}
