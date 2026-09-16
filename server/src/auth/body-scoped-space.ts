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
 * - **SEVERAL were named** (a list, since 5.0) → the same rule, and one unreachable name refuses the whole
 *   call. Owner decision, 2026-09-16. Dropping the ones the token cannot reach would return a SHORTER
 *   answer, and a caller cannot tell a filtered result from a small one — so the failure would read as
 *   "there is less there" rather than as "you cannot see all of it". A 403 naming the space is cheaper
 *   than a wrong conclusion drawn from a plausible answer.
 * - **No space was named** → the caller asked for whatever they can see. Keep the spaces where the rung is
 *   held, drop the rest, and refuse only when nothing is left.
 *
 * **An EMPTY list is refused, not read as "no space named".** `[]` is the value most likely to be produced
 * by a caller's own filter returning nothing, and every falsy-ish check spells it the same as absent — so
 * treating it as the cross-space case would widen a request to every reachable space at exactly the moment
 * the caller meant none.
 *
 * The MCP door sidesteps this by skipping the rung check entirely when no space is named and relying on the
 * connection's accessible list. That is defensible for a read and would be a hole on a write, so the rung is
 * checked here in both branches rather than inferred from reach.
 */
import type { SpaceArea, TokenRights } from '../config/rights-shape.js';
import type { Rung } from './space-rights.js';
import { holdsRung } from './reachable-spaces.js';

export interface BodyScopedRequest {
  /**
   * The `space` value exactly as it arrived: one name, a list of names, or absent. Anything else — an
   * object, a number, a list with a non-string in it — is refused rather than coerced, because every
   * coercion here silently changes WHICH space is read.
   */
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

  /*
   * Parsed into ONE shape before anything is authorised. A branch per arriving shape is how a check ends
   * up applied to one of them and not the other.
   */
  let asked: string[] | undefined;
  if (typeof named === 'string') {
    asked = [named.trim()];
  } else if (Array.isArray(named)) {
    if (!named.every(v => typeof v === 'string')) {
      return { spaces: [], refusal: `The 'space' list must contain only space names as strings.` };
    }
    if (named.length === 0) {
      return {
        spaces: [],
        refusal: `The 'space' list is empty. Name at least one space, or omit 'space' entirely to search `
          + 'every space this token can reach.',
      };
    }
    // Deduplicated: the same space twice would read it twice and double every match from it.
    asked = [...new Set(named.map(v => v.trim()))];
  } else if (named !== undefined && named !== null) {
    return { spaces: [], refusal: `The 'space' field must be a space name, or a list of them.` };
  }
  if (asked?.some(v => v.length === 0)) {
    return { spaces: [], refusal: `The 'space' field must be a space name, or a list of them.` };
  }

  if (!rights) {
    return { spaces: [], refusal: `Token needs '${needs}' on ${area}, and presented no rights matrix` };
  }

  // The shared predicate, not a fifth copy of `satisfies(effectiveRung(...), needs)`.
  const holds = (sid: string): boolean => holdsRung(rights, sid, area, needs);

  if (asked) {
    /*
     * ALL OR NOTHING, and the refusal names only the space that failed.
     *
     * Listing the ones that WERE reachable would tell a caller which spaces exist and which they may read
     * — an inventory they were refused, handed over in the refusal.
     */
    for (const sid of asked) {
      if (!accessible.includes(sid)) {
        return { spaces: [], refusal: `Token does not have access to space '${sid}'` };
      }
      if (!holds(sid)) {
        return { spaces: [], refusal: `Token needs '${needs}' on ${area} in space '${sid}'` };
      }
    }
    return { spaces: asked, refusal: null };
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
