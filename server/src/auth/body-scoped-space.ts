/**
 * Which spaces a request may act on when the space arrives in the BODY rather than in the path.
 *
 * ## Why this is a module and not four lines in a route
 *
 * Owner ruling, 2026-09-15: the search family must read across spaces, and *"in that case the route has to
 * change and space moved to parameter."* So `POST /api/brain/spaces/:spaceId/recall` becomes
 * `POST /api/brain/recall` with an optional `space` in the body.
 *
 * Every row in `ROUTE_RIGHTS` is `scope: 'path'` or `scope: 'iterates'`. Nothing in this server has ever
 * authorised on a space read out of a body, and **authorising one reading of a field while acting on
 * another is a vulnerability rather than a refactor detail** — the two readings are spelled identically, so
 * no reviewer sees the difference in a diff. This function exists so the resolution happens ONCE, returns
 * the list, and the handler acts on what came back instead of reading the body again.
 *
 * ## The guard a hand-written copy would drop
 *
 * **An absent space is not "nothing to check, therefore allowed".** It is the cross-space case, and it has
 * to resolve to a concrete set that is then checked. A route that treated absence as a pass would be an
 * unauthenticated read of every space on the instance, reachable by omitting one JSON key.
 *
 * ## Refusing versus filtering, and this is the part that differs from the path guard
 *
 * The path guard refuses unless the token holds the rung in EVERY target — right, when the caller named one
 * space and meant it. Applied to a fan-out it would refuse an entire cross-space search because some space
 * the caller never asked about exists on the instance.
 *
 * So the rule splits on intent, which is exactly what naming a space expresses:
 *
 * - **A space was named** → the caller asked for THAT one. Not holding the rung there is a refusal, with
 *   the space in the message, because silently searching nothing would answer "no results" to a question
 *   that was really "you may not".
 * - **No space was named** → the caller asked for whatever they can see. Keep the spaces where the rung is
 *   held, drop the rest, and refuse only when nothing is left.
 *
 * The MCP door sidesteps this by skipping the rung check entirely when no space is named and relying on the
 * connection's accessible list. That is defensible for a read and would be a hole on a write, so the rung is
 * checked here in both branches rather than inferred from reach.
 */
import type { SpaceArea, TokenRights } from '../config/rights-shape.js';
import type { Rung } from './space-rights.js';
import { effectiveRung } from './mint-cap.js';
import { satisfies } from './required-rung.js';

export interface BodyScopedRequest {
  /** The `space` value exactly as it arrived. Anything but a non-empty string is refused, never coerced. */
  named: unknown;
  /** The ceiling: every space this connection could reach at all. The matrix cannot raise it. */
  accessible: readonly string[];
  /** The token's matrix. Absent means it presented none, which reaches nothing. */
  rights: TokenRights | undefined;
  area: SpaceArea;
  needs: Exclude<Rung, 'none'>;
}

export interface BodyScopedVerdict {
  /** The spaces the handler may act on. Empty exactly when `refusal` is set. */
  spaces: string[];
  /** The 403 text, or `null` when the call may proceed. */
  refusal: string | null;
}

/**
 * Resolve and authorise in one step.
 *
 * Returns the spaces rather than a boolean on purpose: a boolean would leave the handler to work out the
 * set a second time, which is the two-readings defect this module exists to prevent.
 */
export function spacesForBodyScopedRequest(req: BodyScopedRequest): BodyScopedVerdict {
  const { named, accessible, rights, area, needs } = req;

  const namedSpace = typeof named === 'string' ? named.trim() : undefined;
  if (named !== undefined && named !== null && namedSpace === undefined) {
    return { spaces: [], refusal: `The 'space' field must be a string naming one space.` };
  }

  if (!rights) {
    return { spaces: [], refusal: `Token needs '${needs}' on ${area}, and presented no rights matrix` };
  }

  const holds = (sid: string): boolean => satisfies(effectiveRung(rights, sid, area), needs);

  if (namedSpace) {
    if (!accessible.includes(namedSpace)) {
      return { spaces: [], refusal: `Token does not have access to space '${namedSpace}'` };
    }
    if (!holds(namedSpace)) {
      return {
        spaces: [],
        refusal: `Token needs '${needs}' on ${area} in space '${namedSpace}'`,
      };
    }
    return { spaces: [namedSpace], refusal: null };
  }

  // No space named: every space this connection can reach, kept only where the rung is actually held.
  const spaces = accessible.filter(holds);
  if (spaces.length === 0) {
    return {
      spaces: [],
      refusal: `Token holds '${needs}' on ${area} in no space it can reach, so there is no space to search.`,
    };
  }
  return { spaces, refusal: null };
}
