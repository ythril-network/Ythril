/**
 * Network membership — add, remove, and rotate a member signing key.
 *
 * Split out of the api/networks.ts monolith (A17.5). Add and remove are `networks/member-acts.ts`, shared with MCP
 * `network_member_add` / `network_member_remove` (F-36).
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { getConfig, saveConfig } from '../../config/loader.js';
import { forceSetMemberSigningKey } from '../../util/signing.js';
import { log } from '../../util/log.js';
import { AddMemberBody, addMemberAct, removeMemberAct } from '../../networks/member-acts.js';
import { sendAct } from './_shared.js';

export const membersRouter = Router();

// ── PUT /api/networks/:id/members/:instanceId/signing-key ──────────────────
// Break-glass: force-pin a member's governance signing key WITHOUT a rotation
// proof. Use when a peer lost its old private key (so it cannot produce a
// continuity proof) and must re-establish trust. Normal rotations propagate
// automatically via a signed proof over gossip.
const SigningKeyBody = z.object({ signingPublicKey: z.string().min(100).max(4000) });

membersRouter.put('/:id/members/:instanceId/signing-key', globalRateLimit, requireAdmin, (req, res) => {
  const parsed = SigningKeyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === req.params['id']);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }
  const member = net.members.find(m => m.instanceId === req.params['instanceId']);
  if (!member) { res.status(404).json({ error: 'Member not found' }); return; }
  forceSetMemberSigningKey(member, parsed.data.signingPublicKey);
  saveConfig(cfg);
  res.json({ ok: true, instanceId: member.instanceId });
});


// ── POST /api/networks/:id/members — add a peer member ────────────────────
// ── DELETE /api/networks/:id/members/:instanceId — remove a member ─────────
// Both are `networks/member-acts.ts`, which MCP `network_member_add` / `network_member_remove` call too (F-36).

membersRouter.post('/:id/members', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    const parsed = AddMemberBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    sendAct(res, await addMemberAct(String(req.params['id']), parsed.data));
  } catch (err) {
    log.error(`POST /api/networks/:id/members: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

membersRouter.delete('/:id/members/:instanceId', globalRateLimit, requireAdmin, (req, res) => {
  sendAct(res, removeMemberAct(String(req.params['id']), String(req.params['instanceId'])));
});
