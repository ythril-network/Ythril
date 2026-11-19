/**
 * The records a schema conversion could not convert, over REST (Q-919, bundle-284 design r5 sections 2.3 and 6):
 * `GET /api/spaces/:id/schema-convert/items[?kind=&type=&status=&skip=&limit=]` lists them, and
 * `POST /api/spaces/:id/schema-convert/items/:itemId/dismiss` dismisses one, and `POST /api/spaces/:id/schema-convert/items/dismiss` dismisses every open
 * item a filter lists (the body's `expect` is the number the caller was shown; the act refuses a count that moved). Mounted at `/api/spaces` beside the spaces router, in its own file as
 * `spaces-schema-versions.ts` is.
 *
 * ## What it prevents
 *
 * Both routes are thin: the decisions, the rights and every refusal's sentence and code are `spaces/unconverted-acts.ts`'s, the same acts MCP
 * `list_unconverted` and `dismiss_unconverted` run, so the doors cannot take other parameters or answer other bodies. The act asks the rung itself
 * (`knowledge: read` for the list, `knowledge: write` for the dismiss), so a mount that leaves a guard row out still refuses a caller without it;
 * the guard rows (`ROUTE_RIGHTS`) say the same rung at the edge. The two dismissals also carry `denyReadOnly`, as every mutating route does
 * (`route-guard-coverage` holds it): a token that cannot write anywhere is refused at the edge, and a token that can write elsewhere meets the act's rung.
 *
 * `app.ts` mounts it; the rights rows are `ROUTE_RIGHTS`' and the audit rules `ROUTE_RULES`'. A dismissal hands the audit entry what it did
 * (`req.auditChangesExplicit`: the item id, or the filter, `expect` and count), which the operation's allowlist cuts to scalars.
 */
import { Router } from 'express';
import { denyReadOnly, requireSpaceAuthScoped } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import {
  listUnconvertedAct, dismissUnconvertedAct, dismissShownUnconvertedAct, refusalBody, type UnconvertedCaller, type UnconvertedActResult,
} from '../spaces/unconverted-acts.js';
import type { TokenRights } from '../config/rights-shape.js';
import type { Response } from 'express';
import { sendCaughtFailure } from './send-failure.js';
import { viewReadOfRequest } from '../spaces/read-scope.js';
import { dismissChanges, dismissShownChanges } from '../audit/audit-changes.js';
import { dismissAuditGiven } from '../spaces/unconverted-terms.js';

export const spaceUnconvertedRouter = Router();

/** Put an act's answer on the wire: its body, or its refusal as `refusalBody` builds it (code and the numbers beside it, which `sendSpaceActAnswer` would drop). */
const sendAnswer = (res: Response, r: UnconvertedActResult): void => {
  res.status(r.status).json('error' in r ? refusalBody(r) : r.body);
};

const callerOf = (req: { authToken?: unknown }): UnconvertedCaller =>
  ({ rights: (req.authToken as { rights?: TokenRights } | undefined)?.rights, transport: 'rest' });

// GET /api/spaces/:id/schema-convert/items?kind=&type=&reason=&status=&skip=&limit= - one page of the unconverted items, newest first; `status` is `open`
// (the default) or `dismissed`; `reason` is one reason or several (`reason=a,b` or `reason=a&reason=b`). Filters are parsed by `UnconvertedListParams`
// inside the act.
spaceUnconvertedRouter.get('/:id/schema-convert/items', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    sendAnswer(res, await listUnconvertedAct(spaceId, {
      kind: req.query['kind'], type: req.query['type'], reason: req.query['reason'], status: req.query['status'], skip: req.query['skip'], limit: req.query['limit'],
    }, callerOf(req), viewReadOfRequest(req, spaceId)));
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-convert/items', err);
  }
});

// POST /api/spaces/:id/schema-convert/items/:itemId/dismiss - keep the item as dismissed: the record is unchanged and the item is not opened
// again for the same record version and target.
spaceUnconvertedRouter.post('/:id/schema-convert/items/:itemId/dismiss', globalRateLimit, requireSpaceAuthScoped('id'), denyReadOnly, async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    const answer = await dismissUnconvertedAct(spaceId, req.params['itemId'], callerOf(req));
    if (!('error' in answer)) req.auditChangesExplicit = dismissChanges(String(req.params['itemId']));
    sendAnswer(res, answer);
  } catch (err) {
    sendCaughtFailure(res, 'POST /api/spaces/:id/schema-convert/items/:itemId/dismiss', err);
  }
});

// POST /api/spaces/:id/schema-convert/items/dismiss {kind?, type?, reason?, expect} - dismiss every OPEN item the filter lists, when the caller was
// shown exactly `expect` of them (else 409 with the current number and nothing dismissed); answers `{ dismissed }`. `reason` is one reason or a list
// of them (an array, or one text with commas), `expect` counts over all of them. Validated inside the act.
spaceUnconvertedRouter.post('/:id/schema-convert/items/dismiss', globalRateLimit, requireSpaceAuthScoped('id'), denyReadOnly, async (req, res) => {
  const spaceId = req.params['id'] as string;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const given = { kind: body['kind'], type: body['type'], reason: body['reason'], expect: body['expect'] };
    const answer = await dismissShownUnconvertedAct(spaceId, given, callerOf(req));
    if (!('error' in answer)) req.auditChangesExplicit = dismissShownChanges(dismissAuditGiven(given), (answer.body as { dismissed: number }).dismissed);
    sendAnswer(res, answer);
  } catch (err) {
    sendCaughtFailure(res, 'POST /api/spaces/:id/schema-convert/items/dismiss', err);
  }
});
