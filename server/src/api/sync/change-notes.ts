/**
 * POST /api/sync/networks/:networkId/change-notes — the upstream hands this instance the change notes queued for it
 * (`F-42`). The decision — only the upstream may send, re-delivery is a no-op, one webhook per space — lives in
 * `sync/change-notes.ts`; this route only says who is calling.
 *
 * A PEER token only: the sender is identified by the instance its token is bound to, never by anything in the body,
 * so a note cannot claim to come from somebody else. An admin or local token has no instance and is refused.
 */
import { Router } from 'express';
import { syncRateLimit } from '../../rate-limit/middleware.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { callerPeerId } from './_shared.js';
import { receiveChangeNotes } from '../../sync/change-notes.js';
import { reportServerFailure } from '../../util/report-failure.js';

export const syncChangeNotesRouter = Router();

syncChangeNotesRouter.post('/networks/:networkId/change-notes', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const r = await receiveChangeNotes(
      req.params['networkId'] as string,
      callerPeerId(req.authToken as Record<string, unknown> | undefined),
      req.body,
    );
    res.status(r.status).json(r.body);
  } catch (err) {
    reportServerFailure('sync POST /networks/:networkId/change-notes', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
