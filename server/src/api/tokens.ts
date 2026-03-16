import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { authRateLimit, globalRateLimit } from '../rate-limit/middleware.js';
import { createToken, listTokens, revokeToken } from '../auth/tokens.js';
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
});

// GET /api/tokens — list tokens (hashes excluded)
tokensRouter.get('/', requireAuth, (_req, res) => {
  res.json({ tokens: listTokens() });
});

// POST /api/tokens — create a new PAT
tokensRouter.post('/', authRateLimit, requireAuth, async (req, res) => {
  const parsed = CreateTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name, expiresAt, spaces } = parsed.data;
  const { record, plaintext } = await createToken({ name, expiresAt: expiresAt ?? null, spaces });
  // Return plaintext only on creation — never retrievable again
  const { hash: _h, ...safeRecord } = record;
  res.status(201).json({ token: safeRecord, plaintext });
});

// DELETE /api/tokens/:id — revoke a token
tokensRouter.delete('/:id', requireAuth, async (req, res) => {
  const ok = await revokeToken(req.params['id'] as string);
  if (!ok) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  res.status(204).end();
});
