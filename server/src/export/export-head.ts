/**
 * A `HEAD` of an export route asks the rights `GET` asks (bundle-269 drive, finding 3).
 *
 * ## What it prevents
 *
 * **A `HEAD` that skips the area rung.** Express answers a `HEAD` with the route's `GET` handlers, but the rights inventory
 * (`auth/space-rights.ts`, `ROUTE_RIGHTS`) keys on the method, and it has no `HEAD` rows: the guard found none, logged the route as
 * unclassified and asked reach alone, so `HEAD /api/spaces/:id/schema-rdf` answered 200 with the document's headers to a token whose `GET`
 * answers 403. A `HEAD` asks for what a `GET` would answer, without the content (RFC 9110 §9.3.2), so it needs exactly the `GET`'s rights.
 *
 * {@link headAskedAsGet} wraps an export route's guard: for a `HEAD` the guard runs with the request's method read as `GET`, so it asks the
 * `GET` row (area, rung, a view's members), and the method is `HEAD` again before anything after the guard runs (the handler, which then
 * answers the headers alone, and the audit row, which records no export for it). Node decided at the request's arrival that the answer
 * carries no content, so the body stays suppressed whatever the method reads in between.
 *
 * This holds the two export routes whatever the product decides for `HEAD` on every other route (a decision of its own, outside this
 * bundle); it is a no-op for any other method.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** An express guard: it answers a refusal itself, or calls `next`. */
type Guard = (req: Request, res: Response, next: NextFunction) => unknown;

/** `guard`, asked for a `HEAD` exactly as for a `GET` of the same route. */
export function headAskedAsGet(guard: Guard): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'HEAD') {
      Promise.resolve(guard(req, res, next)).catch(next);
      return;
    }
    let restored = false;
    const restore = (): void => {
      if (restored) return;
      restored = true;
      req.method = 'HEAD';
    };
    req.method = 'GET';
    let asked: unknown;
    try {
      asked = guard(req, res, (err?: unknown) => { restore(); next(err); });
    } catch (err) {
      restore();
      next(err);
      return;
    }
    // A guard that refused answered without calling `next`: the method is `HEAD` again all the same.
    Promise.resolve(asked).then(restore, (err: unknown) => { restore(); next(err); });
  };
}
