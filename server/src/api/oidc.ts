/**
 * GET /api/auth/oidc-info
 *
 * Returns the public OIDC configuration needed by the Angular SPA to initiate
 * the Authorization Code + PKCE login flow.  Sensitive fields (clientSecret)
 * are never included in the response.
 *
 * When OIDC is disabled or not configured, returns { enabled: false }.
 */

import { Router } from 'express';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getOidcConfig } from '../auth/oidc.js';

export const oidcRouter = Router();

oidcRouter.get('/oidc-info', globalRateLimit, (_req, res) => {
  const cfg = getOidcConfig();
  if (!cfg) {
    res.json({ enabled: false });
    return;
  }

  res.json({
    enabled: true,
    issuerUrl: cfg.issuerUrl,
    clientId: cfg.clientId,
    scopes: cfg.scopes ?? ['openid', 'profile', 'email'],
  });
});
