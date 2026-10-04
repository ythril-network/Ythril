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
import { z } from 'zod';
import { authRateLimit, syncRateLimit } from '../../rate-limit/middleware.js';
import { requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { getConfig } from '../../config/loader.js';
import { answerPairing, confirmPairing } from '../../networks/member-introductions.js';
import { sendSyncWriteFailure } from './write-failure.js';

export const syncPairRouter = Router();

/** A peer token, as every instance mints it. Anything else is refused before a pairing is looked at. */
export const PeerToken = z.string().startsWith('ythril_').max(200);
export const PairBody = z.object({ instanceId: z.string().min(1).max(100), label: z.string().max(200).optional(), token: PeerToken });
export const ConfirmBody = z.object({ instanceId: z.string().min(1).max(100), token: PeerToken });

// The ejection guard the member routes carry, for the same reason: an instance ejected from a network pairs in nothing.
syncPairRouter.use('/networks/:networkId/pair', (req, res, next) => {
  if (getConfig().ejectedFromNetworks?.includes(req.params['networkId'] ?? '')) { res.status(401).json({ error: 'ejected' }); return; }
  next();
});

syncPairRouter.post('/networks/:networkId/pair', authRateLimit, async (req, res) => {
  const parsed = PairBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const r = await answerPairing(req.params['networkId'] as string, parsed.data);
    res.status(r.status).json(r.body);
  } catch (err) {
    sendSyncWriteFailure(res, 'sync POST /networks/:networkId/pair', err);
  }
});

syncPairRouter.post('/networks/:networkId/pair/confirm', syncRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  const parsed = ConfirmBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const r = await confirmPairing(req.params['networkId'] as string, req.authToken as { id?: string; peerInstanceId?: string }, parsed.data);
    res.status(r.status).json(r.body);
  } catch (err) {
    sendSyncWriteFailure(res, 'sync POST /networks/:networkId/pair/confirm', err);
  }
});
