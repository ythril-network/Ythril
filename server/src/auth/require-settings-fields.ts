/**
 * The settings body's per-field authorisation, as a GUARD rather than as the first block of a handler.
 *
 * ## Why it is a guard
 *
 * `PATCH /api/spaces/:id` no longer has one requirement: each of its twenty-two fields answers to the area
 * that owns it (`space-field-rights.ts`). The check that reads that table is authorisation, and
 * authorisation belongs in the chain where a reviewer counts guards, not inside a handler where it reads as
 * the first of several validations and can be reordered behind one of them.
 *
 * It also keeps `api/spaces.ts` from absorbing it. That file is on the god-file ratchet, and the ratchet's
 * point is not the line count on any given day — it is that every change lands in the same place because
 * that is where the code already is.
 *
 * ## Where it sits in the chain
 *
 * AFTER the guard that resolves the token and the space, because it needs both, and BEFORE the handler,
 * because a refusal must happen before anything is planned or applied.
 *
 * ## Why the whole request is refused
 *
 * A body mixing a field the caller may set with one they may not is refused entire. Dropping the refused
 * fields and applying the rest is the failure where an operator sees "Saved" and half of what they typed is
 * silently gone — and they have no way to tell which half.
 */
import type { Request, Response, NextFunction } from 'express';
import type { TokenRights } from '../config/rights-shape.js';
import { isInstanceAdmin } from './middleware.js';
import { refusalsForSpaceUpdate, describeFieldRequirement } from './space-field-rights.js';

export function requireSettingsFields(paramName: string) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const spaceId = req.params[paramName] as string | undefined;
    /*
     * A missing space id CLOSES, and this is defence in depth rather than a reachable path.
     *
     * Mounted as it is today, `requireSpaceAuthMfaScoped('id')` has already refused a request with no
     * `:id`, so this cannot fire. But passing `''` onward would ask `isSpaceAdminFor(rights, '')` and
     * `effectiveRung(rights, '', area)` about a space that does not exist, and a token with an admin FLOOR
     * answers those about any id at all — so the fail-open case is a floor-admin token editing settings on
     * a route where the parameter was renamed. `requireAdminOrSpaceAdminMfaScoped` carries the same guard
     * for the same reason, and `space-admin-reaches-its-own-space-settings.test.js` pins it there.
     */
    if (!spaceId) {
      res.status(400).json({ error: 'No space in the request path, so no setting can be authorised.' });
      return;
    }
    const refused = refusalsForSpaceUpdate(
      (req.body ?? {}) as Record<string, unknown>,
      spaceId,
      !!(req.authToken && isInstanceAdmin(req.authToken)),
      (req.authToken as { rights?: TokenRights } | undefined)?.rights,
    );
    if (!refused.length) { next(); return; }
    // Every refused field at once, each with what it needs. One save should produce one conversation with
    // whoever grants rights, not one per field discovered a save at a time.
    res.status(403).json({
      error: 'Not allowed to change ' + refused.map(describeFieldRequirement).join(', ')
        + '. Each of this space\'s settings is governed by the area that field belongs to.',
    });
  };
}
