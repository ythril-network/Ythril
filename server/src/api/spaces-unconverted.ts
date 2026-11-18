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
 * the guard rows (`ROUTE_RIGHTS`) say the same rung at the edge. There is no read-only middleware here on purpose: the act's refusal is the area
 * guard's own sentence, and a second sentence for the same refusal is what two doors disagreeing looks like.
 *
 * Not wired yet: `app.ts` mounts it, with the rights and audit rows (the wiring slice).
 */
import { Router } from 'express';
import { requireSpaceAuthScoped } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import {
  listUnconvertedAct, dismissUnconvertedAct, dismissShownUnconvertedAct, refusalBody, type UnconvertedCaller, type UnconvertedActResult,
} from '../spaces/unconverted-acts.js';
import type { TokenRights } from '../config/rights-shape.js';
import type { Response } from 'express';
import { sendCaughtFailure } from './send-failure.js';

export const spaceUnconvertedRouter = Router();

/** Put an act's answer on the wire: its body, or its refusal as `refusalBody` builds it (code and the numbers beside it, which `sendSpaceActAnswer` would drop). */
const sendAnswer = (res: Response, r: UnconvertedActResult): void => {
  res.status(r.status).json('error' in r ? refusalBody(r) : r.body);
};

const callerOf = (req: { authToken?: unknown }): UnconvertedCaller =>
  ({ rights: (req.authToken as { rights?: TokenRights } | undefined)?.rights, transport: 'rest' });

// GET /api/spaces/:id/schema-convert/items?kind=&type=&status=&skip=&limit= - one page of the unconverted items, newest first; `status` is `open`
// (the default) or `dismissed`. Filters are parsed by `UnconvertedListParams` inside the act.
spaceUnconvertedRouter.get('/:id/schema-convert/items', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    sendAnswer(res, await listUnconvertedAct(spaceId, {
      kind: req.query['kind'], type: req.query['type'], reason: req.query['reason'], status: req.query['status'], skip: req.query['skip'], limit: req.query['limit'],
    }, callerOf(req)));
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-convert/items', err);
  }
});

// POST /api/spaces/:id/schema-convert/items/:itemId/dismiss - keep the item as dismissed: the record is unchanged and the item is not opened
// again for the same record version and target.
spaceUnconvertedRouter.post('/:id/schema-convert/items/:itemId/dismiss', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    sendAnswer(res, await dismissUnconvertedAct(spaceId, req.params['itemId'], callerOf(req)));
  } catch (err) {
    sendCaughtFailure(res, 'POST /api/spaces/:id/schema-convert/items/:itemId/dismiss', err);
  }
});

// POST /api/spaces/:id/schema-convert/items/dismiss {kind?, type?, reason?, expect} - dismiss every OPEN item the filter lists, when the caller was
// shown exactly `expect` of them (else 409 with the current number and nothing dismissed); answers `{ dismissed }`. Validated inside the act.
spaceUnconvertedRouter.post('/:id/schema-convert/items/dismiss', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    sendAnswer(res, await dismissShownUnconvertedAct(spaceId, {
      kind: body['kind'], type: body['type'], reason: body['reason'], expect: body['expect'],
    }, callerOf(req)));
  } catch (err) {
    sendCaughtFailure(res, 'POST /api/spaces/:id/schema-convert/items/dismiss', err);
  }
});
