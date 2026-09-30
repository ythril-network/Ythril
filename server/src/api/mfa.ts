/**
 * MFA management routes
 *
 * Route prefix: /api/mfa
 *
 * All routes require an admin PAT. When MFA is ALREADY enabled, `setup` (rotate)
 * and `disable` additionally require a current TOTP code (via requireAdminMfa) —
 * otherwise a stolen admin PAT could silently overwrite or remove the second
 * factor it is meant to be protected by. When MFA is not yet enabled,
 * requireAdminMfa is equivalent to requireAdmin (no code needed), so first-time
 * enrolment works without a code. Break-glass recovery when the authenticator is
 * lost is an operator action: remove `totpSecret` from secrets.json on disk.
 *
 * GET  /api/mfa/status          — { enabled: boolean }
 * POST /api/mfa/setup           — generate & store secret; returns { secret, otpauth }
 * POST /api/mfa/verify          — verify a code without a state-changing side-effect
 * DELETE /api/mfa               — disable MFA (removes secret from secrets.json)
 */

import { Router } from 'express';
import { requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { authRateLimit, globalRateLimit } from '../rate-limit/middleware.js';
import { enableMfa, disableMfa, isMfaEnabled, verifyMfaCode } from '../auth/totp.js';
import { getConfig } from '../config/loader.js';
import { z } from 'zod';

export const mfaRouter = Router();

export const VerifyBody = z.object({ code: z.string().min(4).max(8) });

// GET /api/mfa/status
mfaRouter.get('/status', globalRateLimit, requireAdmin, (_req, res) => {
  res.json({ enabled: isMfaEnabled() });
});

// POST /api/mfa/setup — generate and store a new TOTP secret.
// Rotating an already-enabled secret requires a current TOTP code (requireAdminMfa),
// so a stolen admin PAT cannot silently replace the second factor. Must confirm
// with a valid code from the new secret before it is considered active (handled
// client-side: show QR, ask user to enter code, then hit /verify).
mfaRouter.post('/setup', authRateLimit, requireAdminMfa, (_req, res) => {
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

// DELETE /api/mfa — disable MFA. Requires a current TOTP code (requireAdminMfa)
// so a stolen admin PAT cannot turn the second factor off. If the authenticator
// is lost, recover by removing `totpSecret` from secrets.json on the host.
mfaRouter.delete('/', authRateLimit, requireAdminMfa, (_req, res) => {
  if (!isMfaEnabled()) {
    res.status(409).json({ error: 'MFA is not enabled' });
    return;
  }
  disableMfa();
  res.status(204).end();
});
