import { Router } from 'express';
import { requireAuth, requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig, saveConfig, getSecrets } from '../config/loader.js';
import { createSpace, removeSpace, slugify } from '../spaces/spaces.js';
import { measureUsage } from '../quota/quota.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { log } from '../util/log.js';

export const spacesRouter = Router();

const CreateSpaceBody = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  folders: z.array(z.string()).optional(),
  minGiB: z.number().positive().optional(),
  proxyFor: z.array(z.string().min(1).max(40)).min(1).optional(),
});

const DeleteSpaceBody = z.object({
  confirm: z.literal(true),
});

// GET /api/spaces
spacesRouter.get('/', globalRateLimit, requireAuth, async (_req, res) => {
  const cfg = getConfig();
  const spaces = cfg.spaces.map(({ id, label, builtIn, folders, minGiB, flex, description, proxyFor }) => ({
    id, label, builtIn, folders, minGiB, flex, description, ...(proxyFor ? { proxyFor } : {}),
  }));
  // Include storage usage summary when quota is configured
  let storage: { usageGiB?: { files: number; brain: number; total: number }; limits?: typeof cfg.storage } | undefined;
  if (cfg.storage) {
    try {
      const usage = await measureUsage();
      storage = { usageGiB: usage, limits: cfg.storage };
    } catch {
      // Non-fatal: storage summary omitted on measurement error
    }
  }
  res.json({ spaces, ...(storage ? { storage } : {}) });
});

// POST /api/spaces
spacesRouter.post('/', globalRateLimit, requireAdminMfa, async (req, res) => {
  const parsed = CreateSpaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { id: rawId, label, description, folders, minGiB, proxyFor } = parsed.data;
  const id = rawId ?? slugify(label);

  // Validate proxy members exist and are not themselves proxies
  if (proxyFor) {
    const cfg = getConfig();
    for (const memberId of proxyFor) {
      const member = cfg.spaces.find(s => s.id === memberId);
      if (!member) {
        res.status(400).json({ error: `Proxy member space '${memberId}' not found` });
        return;
      }
      if (member.proxyFor) {
        res.status(400).json({ error: `Proxy member '${memberId}' is itself a proxy space (nesting not allowed)` });
        return;
      }
    }
  }

  try {
    const space = await createSpace({ id, label, description, folders, minGiB, proxyFor });
    res.status(201).json({ space });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      res.status(409).json({ error: msg });
    } else {
      res.status(500).json({ error: 'Failed to create space' });
    }
  }
});

// DELETE /api/spaces/:id
//
// Solo space (not in any network): requires { "confirm": true } body to guard against accidents.
// Networked space: opens a space_deletion vote round on every network that includes this space,
// casts this instance's own yes vote immediately, notifies all peers, and returns 202.
// The space is only deleted once the vote passes on each network.
spacesRouter.delete('/:id', globalRateLimit, requireAdminMfa, async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();

  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  if (space.builtIn) {
    res.status(400).json({ error: `Space '${id}' is a built-in space and cannot be deleted` });
    return;
  }

  const networkedIn = cfg.networks.filter(n => n.spaces.includes(id));

  // ── Solo path ─────────────────────────────────────────────────────────────
  if (networkedIn.length === 0) {
    const body = DeleteSpaceBody.safeParse(req.body);
    if (!body.success || !body.data.confirm) {
      res.status(400).json({
        error: 'This space is not in any network. Send { "confirm": true } to delete it permanently.',
      });
      return;
    }
    const ok = await removeSpace(id);
    if (!ok) { res.status(404).json({ error: `Space '${id}' not found` }); return; }
    res.status(204).end();
    return;
  }

  // ── Networked path ────────────────────────────────────────────────────────
  // Open a space_deletion vote round on every network that contains this space.
  // This instance votes yes immediately; deletion happens once each round passes.
  const rounds: { networkId: string; networkLabel: string; roundId: string }[] = [];
  const now = new Date().toISOString();

  for (const net of networkedIn) {
    const roundId = uuidv4();
    const deadline = new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString();
    net.pendingRounds.push({
      roundId,
      type: 'space_deletion',
      subjectInstanceId: cfg.instanceId,
      subjectLabel: cfg.instanceLabel,
      subjectUrl: '',       // not meaningful for space deletion
      deadline,
      openedAt: now,
      votes: [{ instanceId: cfg.instanceId, vote: 'yes', castAt: now }],
      spaceId: id,
    });
    rounds.push({ networkId: net.id, networkLabel: net.label, roundId });
  }
  saveConfig(cfg);

  // Notify all peers (best-effort — failures are logged but don't abort the response)
  const secrets = getSecrets();
  for (const net of networkedIn) {
    for (const member of net.members) {
      const peerToken = secrets.peerTokens[member.instanceId];
      if (!peerToken) continue;
      fetch(`${member.url}/api/notify`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          networkId: net.id,
          instanceId: cfg.instanceId,
          event: 'space_deletion_pending',
          data: { spaceId: id, spaceLabel: space.label },
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch(err => log.warn(`notify ${member.label} of space_deletion_pending: ${err}`));
    }
  }

  res.status(202).json({ status: 'vote_pending', rounds });
});
