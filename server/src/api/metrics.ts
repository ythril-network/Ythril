import { Router } from 'express';
import crypto from 'node:crypto';
import { register } from '../metrics/registry.js';
import { requireAdmin } from '../auth/middleware.js';

export const metricsRouter = Router();

/**
 * GET /metrics
 *
 * Prometheus text-format metrics endpoint.
 *
 * Authentication (in priority order):
 *  1. METRICS_TOKEN env var set → require `Authorization: Bearer <METRICS_TOKEN>`.
 *     This is the recommended production path: configure Prometheus with
 *     `bearer_token: <METRICS_TOKEN>` in its scrape config.
 *  2. METRICS_TOKEN not set → fall back to requiring a valid admin PAT.
 *     Useful during initial setup or when the scraper is trusted at the
 *     network layer and uses the existing admin token.
 *
 * In both cases, an unauthenticated request receives 401.
 * Returns: text/plain; version=0.0.4; charset=utf-8
 */

const METRICS_TOKEN = process.env['METRICS_TOKEN']?.trim() || null;

/**
 * Constant-time comparison of two strings to prevent timing oracle on the token.
 * Returns true only when both strings are identical.
 */
function safeTokenEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
      // Perform a dummy compare to consume constant time even on length mismatch.
      crypto.timingSafeEqual(ba, ba);
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function metricsTokenAuth(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  if (!bearer || !safeTokenEqual(bearer, METRICS_TOKEN!)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="ythril-metrics"');
    res.status(401).send('# Unauthorized: provide METRICS_TOKEN as Bearer token\n');
    return;
  }
  next();
}

// Choose the auth middleware based on configuration at startup.
// This avoids per-request branching and makes the auth path statically clear.
const metricsAuth = METRICS_TOKEN ? metricsTokenAuth : requireAdmin;

metricsRouter.get('/', metricsAuth, async (_req, res) => {
  try {
    const metrics = await register.metrics();
    res.setHeader('Content-Type', register.contentType);
    res.send(metrics);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`# Error collecting metrics: ${msg}\n`);
  }
});
