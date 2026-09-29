/**
 * Club members pairing with each other directly (`Q-135`). The rule is `networks/member-introductions.ts`; these
 * are its two doors on the peer protocol, and they hold nothing of it themselves.
 *
 * - `POST /api/sync/networks/:networkId/pair` carries NO credential: the caller has none here yet, which is what the
 *   pairing is for. It is answered only for an instance this instance's own peers introduced, and the caller is
 *   proven by calling back the address that introduction vouched for.
 * - `POST /api/sync/networks/:networkId/pair/confirm` is that call back. It carries the token the opener minted for
 *   the pairing, and nothing else is accepted on it.
 */
import { Router } from 'express';
import { authRateLimit, syncRateLimit } from '../../rate-limit/middleware.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { getConfig } from '../../config/loader.js';
import { answerPairing, confirmPairing } from '../../networks/member-introductions.js';
import { reportServerFailure } from '../../util/report-failure.js';

export const syncPairRouter = Router();

// The ejection guard the member routes carry, for the same reason: an instance ejected from a network pairs in nothing.
syncPairRouter.use('/networks/:networkId/pair', (req, res, next) => {
  if (getConfig().ejectedFromNetworks?.includes(req.params['networkId'] ?? '')) { res.status(401).json({ error: 'ejected' }); return; }
  next();
});

syncPairRouter.post('/networks/:networkId/pair', authRateLimit, async (req, res) => {
  try {
    const r = await answerPairing(req.params['networkId'] as string, req.body);
    res.status(r.status).json(r.body);
  } catch (err) {
    reportServerFailure('sync POST /networks/:networkId/pair', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

syncPairRouter.post('/networks/:networkId/pair/confirm', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const r = await confirmPairing(req.params['networkId'] as string, req.authToken as { id?: string; peerInstanceId?: string }, req.body);
    res.status(r.status).json(r.body);
  } catch (err) {
    reportServerFailure('sync POST /networks/:networkId/pair/confirm', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
