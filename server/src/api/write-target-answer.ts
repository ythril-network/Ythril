/**
 * How a REST route resolves and answers a proxy WRITE target (`Q-440`) — the two things every site that calls `resolveWriteTarget`
 * needs and used to spell for itself.
 *
 * - {@link restWriteGrant}: the caller's grant, read from the request, with the area and rung the route needs in the member a
 *   write lands in. The matrix is passed as the request holds it, absent or not: the resolver refuses an absent one, so no site
 *   writes `!` to get past the type.
 * - {@link answerWriteTarget}: the refusal, with the status the resolver chose. Thirteen routes answered `wt.error` as a hard-coded
 *   400, so a refusal the resolver could say as a 403 (a rung not held on the member) had nowhere to go, and a reach refusal could
 *   be a different status on one route than on another. `every-proxy-write-door-resolves-its-target-with-the-callers-grant.test.js`
 *   refuses a site that answers the sentence itself.
 */
import type { Request, Response } from 'express';
import type { Rung, SpaceArea } from '../config/rights-shape.js';
import type { ResolvedWriteTarget, WriteGrant } from '../spaces/proxy.js';

/**
 * The grant of the route that is answering this request: its matrix and the `area` / `needs` of the route's own `ROUTE_RIGHTS` row.
 *
 * The row is named at the call, not looked up from the request's route: a route is a handler that may be invoked without its
 * mount (a test drives it with a request that has no `baseUrl`), and a lookup that found nothing would have to either refuse the
 * write or default a rung, which is the ungoverned write this exists to end. **The literal must be the route's `ROUTE_RIGHTS` row** (its
 * area and lowest rung): that inventory is what the area guard enforces on the space the route was addressed through, and this is the
 * same question asked of the member the write lands in.
 */
export function restWriteGrant(req: Request, area: SpaceArea, needs: Rung): WriteGrant {
  return { rights: req.authToken?.rights, area, needs };
}

/**
 * Answers a refused resolution with its own status and sentence, and says whether it did — a type predicate, so the route's
 * next line reads the resolved target without a second check: `if (answerWriteTarget(res, wt)) return;`.
 */
export function answerWriteTarget(res: Response, wt: ResolvedWriteTarget): wt is Extract<ResolvedWriteTarget, { ok: false }> {
  if (wt.ok) return false;
  res.status(wt.status).json({ error: wt.error });
  return true;
}
