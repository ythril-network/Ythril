import type { TokenRights } from '../config/rights-shape.js';
import { canWriteAnywhere } from '../auth/write-anywhere.js';
import { spaceAdminSpacesFor, administersAnySpace } from '../auth/editor-scope.js';

/** The shape this needs off a tool — the two flags that decide whether it is reachable at all. */
export interface VisibilityFlags {
  mutating?: boolean;
  admin?: boolean;
  spaceAdmin?: boolean;
}

/**
 * Could this token invoke this tool at all?
 *
 * ## Why this is one function and not two identical expressions
 *
 * `router.ts` filtered `tools/list` with
 * `!(readOnly && t.mutating) && !(!isAdmin && t.admin)`, and `help.ts` filtered its own listing with the
 * same expression — under a comment reading *"the exact predicate tools/list uses (router.ts) — one source
 * of truth, so this text can never advertise a tool the dispatcher would deny."*
 *
 * It was two copies claiming to be one. The dispatcher then made the same decision a third time, in two more
 * `if` statements. Four expressions of one rule, and the comment asserting otherwise is what made it
 * invisible — this is the defect this repo produces most, and it was sitting inside the mechanism meant to
 * prevent advertising a tool that would be refused.
 *
 * ## What changed beyond the extraction
 *
 * All four read the legacy `readOnly` / `admin` booleans. They read the RIGHTS MATRIX now, which is what
 * makes `admin`/`readOnly` deletable from the token record — and it closes a narrower gap in passing: a
 * token with a write rung in one space used to be shown every mutating tool because `readOnly` was false
 * instance-wide, and the per-space rung guard then refused the call. Now the listing and the refusal come
 * from one predicate, so the list stops promising what the dispatcher will deny.
 *
 * **Coarse on purpose.** Visibility is a question about the token, not about a space — `tools/list` is
 * answered once per connection, before any space is named. `toolRightsRefusal` does the per-space, per-area
 * check at call time, and that is the one that decides whether a specific invocation is allowed.
 */
export function toolIsVisible(tool: VisibilityFlags, rights: TokenRights | undefined): boolean {
  if (tool.admin) return rights?.instanceAdmin === true;
  // A space-admin tool is LISTED to anyone who administers a space, and refused per call for the space they
  // did not administer. Coarse here for the reason stated above — `tools/list` is answered before any space is
  // named, so "administers something" is the only question that can be asked at this point. `spaceAdminRefusal`
  // asks the real one. Listing a tool the dispatcher may then refuse is the same shape as the mutating case
  // directly below, which has always been listed on "can write ANYWHERE" and refused per space.
  // Same correction as the token-routes gate: a floor of `admin` administers every space and holds no
  // per-space rows, so counting rows hid every space-admin tool from a token that fully qualifies.
  if (tool.spaceAdmin) return rights?.instanceAdmin === true || administersAnySpace({ rights });
  if (tool.mutating) return canWriteAnywhere(rights);
  return true;
}

