/**
 * MFA management routes
 *
 * Route prefix: /api/mfa
 *
 * All routes require an admin PAT. Enroll/disable do NOT require an existing
 * TOTP code (bootstrap problem — you can't provide a code before you have the
 * secret, and you must be able to disable MFA if you lose your authenticator
 * via a deliberate admin API call).
 *
 * GET  /api/mfa/status          — { enabled: boolean }
 * POST /api/mfa/setup           — generate & store secret; returns { secret, otpauth }
 * POST /api/mfa/verify          — verify a code without a state-changing side-effect
 * DELETE /api/mfa               — disable MFA (removes secret from secrets.json)
 */

import { Router } from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { authRateLimit, globalRateLimit } from '../rate-limit/middleware.js';
import { enableMfa, disableMfa, isMfaEnabled, verifyMfaCode } from '../auth/totp.js';
import { getConfig } from '../config/loader.js';
import { z } from 'zod';

export const mfaRouter = Router();

const VerifyBody = z.object({ code: z.string().min(4).max(8) });

// GET /api/mfa/status
mfaRouter.get('/status', globalRateLimit, requireAdmin, (_req, res) => {
  res.json({ enabled: isMfaEnabled() });
});

// POST /api/mfa/setup — generate and store a new TOTP secret.
// Safe to call again (rotates the secret).  Must confirm with a valid code
// from the new secret before the secret is considered active (handled client-
// side: show QR, ask user to enter code, then hit /verify).
mfaRouter.post('/setup', authRateLimit, requireAdmin, (_req, res) => {
  const cfg = getConfig();
  const issuer = 'Ythril';
  const account = cfg.instanceLabel || 'brain';
  const { secret, otpauth } = enableMfa(issuer, account);
  res.status(201).json({ secret, otpauth });
});

// POST /api/mfa/verify — verify a code (confirms enrollment; also usable as a
// health-check / "test your authenticator" call).
mfaRouter.post('/verify', authRateLimit, requireAdmin, (req, res) => {
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isMfaEnabled()) {
    res.status(409).json({ error: 'MFA is not enabled' });
    return;
  }
  const ok = verifyMfaCode(parsed.data.code);
  res.json({ valid: ok });
});

// DELETE /api/mfa — disable MFA.  Does NOT require a TOTP code on purpose:
// this is the emergency recovery path when an admin loses their authenticator.
// Physical access to the config + a valid admin PAT is sufficient proof of
// identity for the disable operation.
mfaRouter.delete('/', authRateLimit, requireAdmin, (_req, res) => {
  if (!isMfaEnabled()) {
    res.status(409).json({ error: 'MFA is not enabled' });
    return;
  }
  disableMfa();
  res.status(204).end();
});
