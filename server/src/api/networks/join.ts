/**
 * Joining a network — invite, join, join-remote, and fork.
 *
 * Split out of the api/networks.ts monolith (A17.5). join-remote, invite and fork are acts in `networks/`, shared
 * with their MCP tools (F-36); the peer-protocol `/:id/join` stays here.
 */
import { Router } from 'express';
import { requireAdmin, requireAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { log } from '../../util/log.js';
import { ForkNetworkBody, forkNetworkAct, inviteKeyAct } from '../../networks/network-acts.js';
import { JoinRemoteBody, JoinByKeyBody, joinByInviteKeyAct, joinRemoteAct } from '../../networks/join-remote-act.js';
import { JoinNetworkBody, admitByInviteKeyAct } from '../../networks/member-acts.js';
import { sendAct } from './_shared.js';

export const joinRouter = Router();

// ── POST /api/networks/join-remote ─────────────────────────────────────────
// Called by the JOINING brain's UI; the handshake is `networks/join-remote-act.ts`, which MCP `network_join_remote`
// calls too (F-36). F-34.1: the Networks column, checked between apply and finalize. `denyReadOnly` because this was
// `requireAdmin`, which a read-only token never passed.
joinRouter.post('/join-remote', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const parsed = JoinRemoteBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    sendAct(res, await joinRemoteAct(req.authToken as Parameters<typeof joinRemoteAct>[0], parsed.data));
  } catch (err) {
    log.error(`POST /api/networks/join-remote: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/join-by-key ─────────────────────────────────────────
// F-41: join a pub/sub with its publisher's URL and published key; the act redeems the key and runs the same
// handshake as join-remote, so the rights are that act's. MCP `network_join_by_key` calls it too.
joinRouter.post('/join-by-key', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const parsed = JoinByKeyBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    sendAct(res, await joinByInviteKeyAct(req.authToken as Parameters<typeof joinByInviteKeyAct>[0], parsed.data));
  } catch (err) {
    log.error(`POST /api/networks/join-by-key: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/invite — generate invite key ───────────────────

// `denyReadOnly` because this was `requireAdmin`, which a read-only token never passed (`F-37`).
// The act is shared with MCP `network_invite` (F-36 slice 3).
joinRouter.post('/:id/invite', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    sendAct(res, await inviteKeyAct(req.authToken as Parameters<typeof inviteKeyAct>[0], req.params['id'] as string));
  } catch (err) {
    log.error(`POST /api/networks/:id/invite: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/join — join via invite key ─────────────────────

// The act is `networks/member-acts.ts`, shared with MCP `network_member_admit` (F-36 slice 5).
joinRouter.post('/:id/join', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    const parsed = JoinNetworkBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    sendAct(res, await admitByInviteKeyAct(String(req.params['id']), parsed.data));
  } catch (err) {
    log.error(`POST /api/networks/:id/join: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/fork ──────────────────────────────────────────────
// Creates a new standalone/closed network seeded from the caller's copy of the
// source network's spaces. Works for:
//   • Active member  — source network still present; spaces are inherited
//   • Ejected member — source network is gone (deleted on ejection); caller must
//     supply spaces explicitly in the request body
//
// The source network is never modified. ejectedFromNetworks is never cleared.

// The act is shared with MCP `network_fork` (F-36 slice 3).
joinRouter.post('/:id/fork', globalRateLimit, requireAdmin, (req, res) => {
  try {
    // Parsed here as well as in the act: the same-parameters gate reads a route's accepted keys off this call.
    const parsed = ForkNetworkBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    sendAct(res, forkNetworkAct(String(req.params['id'] ?? ''), parsed.data));
  } catch (err) {
    log.error(`POST /api/networks/:id/fork: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
