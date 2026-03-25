import { Router } from 'express';
import { requireAuth, requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { authRateLimit, globalRateLimit } from '../rate-limit/middleware.js';
import { createToken, listTokens, revokeToken, regenerateToken } from '../auth/tokens.js';
import { z } from 'zod';

export const tokensRouter = Router();

// GET /api/auth/me — returns the current token's metadata (used by the Angular SPA to verify a PAT)
tokensRouter.get('/me', globalRateLimit, requireAuth, (req, res) => {
  res.json(req.authToken);
});

const CreateTokenBody = z.object({
  name: z.string().min(1).max(200),
  expiresAt: z.string().datetime().nullish(),
  spaces: z.array(z.string().min(1)).max(1000).optional(),
  admin: z.boolean().optional(),
});

// GET /api/tokens — list tokens (hashes excluded) — admin only
tokensRouter.get('/', requireAdmin, (_req, res) => {
  res.json({ tokens: listTokens() });
});

// POST /api/tokens — create a new PAT — admin + MFA
// admin:true may only be set when the calling token is itself admin (enforced by requireAdminMfa above)
tokensRouter.post('/', authRateLimit, requireAdminMfa, async (req, res) => {
  const parsed = CreateTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name, expiresAt, spaces, admin } = parsed.data;
  const { record, plaintext } = await createToken({ name, expiresAt: expiresAt ?? null, spaces, admin });
  // Return plaintext only on creation — never retrievable again
  const { hash: _h, ...safeRecord } = record;
  res.status(201).json({ token: safeRecord, plaintext });
});

// POST /api/tokens/:id/regenerate — rotate a token's secret — admin + MFA
tokensRouter.post('/:id/regenerate', authRateLimit, requireAdminMfa, async (req, res) => {
  const plaintext = await regenerateToken(req.params['id'] as string);
  if (!plaintext) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  res.json({ plaintext });
});

// DELETE /api/tokens/:id — revoke a token — admin + MFA
tokensRouter.delete('/:id', requireAdminMfa, async (req, res) => {
  const id = req.params['id'] as string;
  const all = listTokens();
  const target = all.find(t => t.id === id);
  if (!target) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  // Prevent locking out all admin access
  if (target.admin && all.filter(t => t.admin).length === 1) {
    res.status(409).json({ error: 'Cannot revoke the last admin token' });
    return;
  }
  await revokeToken(id);
  res.status(204).end();
});
