/**
 * Network topology — reparent-self, adopt a member, revert a member's parent.
 *
 * Split out of the api/networks.ts monolith (A17.5). The three are acts in `networks/topology-acts.ts`, shared with
 * MCP `network_reparent_self`, `network_member_adopt` and `network_member_revert_parent` (F-36 slice 5).
 */
import { Router } from 'express';
import { requireAdmin } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { ReparentSelfBody, adoptMemberAct, reparentSelfAct, revertParentAct } from '../../networks/topology-acts.js';
import { sendAct } from './_shared.js';

export const topologyRouter = Router();

// ── POST /api/networks/:id/reparent-self ────────────────────────────────────
// Called by a node on ITSELF after completing the invite apply step.
// Records the new parent in the local config so this node knows it is
// temporarily connected to a grandparent rather than its original parent.

topologyRouter.post('/:id/reparent-self', globalRateLimit, requireAdmin, (req, res) => {
  const parsed = ReparentSelfBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  sendAct(res, reparentSelfAct(String(req.params['id']), parsed.data));
});


// ── POST /api/networks/:id/members/:instanceId/adopt ───────────────────────
// Called on the GRANDPARENT side. Makes a temporary reparent permanent by clearing
// originalParentInstanceId from the grandchild's member record.

topologyRouter.post('/:id/members/:instanceId/adopt', globalRateLimit, requireAdmin, (req, res) => {
  sendAct(res, adoptMemberAct(String(req.params['id']), String(req.params['instanceId'])));
});


// ── POST /api/networks/:id/members/:instanceId/revert-parent ───────────────
// Called on the GRANDPARENT side when the original parent is back online.
// Restores the topology: grandchild re-parents to its original parent.

topologyRouter.post('/:id/members/:instanceId/revert-parent', globalRateLimit, requireAdmin, (req, res) => {
  sendAct(res, revertParentAct(String(req.params['id']), String(req.params['instanceId'])));
});
