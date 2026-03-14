/**
 * Settings UI authentication — password-based session cookie.
 *
 * Flow:
 *   POST /settings/login  { password } → sets HttpOnly cookie `ythril_settings`
 *   GET  /settings/*      → requireSettingsAuth middleware checks cookie
 *   POST /settings/logout → clears cookie
 *
 * Session token: HMAC-SHA256( instanceId + ":" + createdAt, settingsPasswordHash )
 * encoded as base64url. Binding to settingsPasswordHash means that changing the
 * settings password automatically invalidates all existing sessions.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { getSecrets, getConfig } from '../config/loader.js';

const COOKIE_NAME = 'ythril_settings';
const COOKIE_MAX_AGE = 8 * 60 * 60; // 8 hours in seconds

function makeSessionToken(): string {
  const config = getConfig();
  const secrets = getSecrets();
  const createdAt = Date.now().toString(36);
  const payload = `${config.instanceId}:${createdAt}`;
  const sig = createHmac('sha256', secrets.settingsPasswordHash)
    .update(payload)
    .digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function verifySessionToken(token: string): boolean {
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx < 1) return false;
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  try {
    const secrets = getSecrets();
    const config = getConfig();
    const payload = Buffer.from(payloadB64, 'base64url').toString();
    if (!payload.startsWith(`${config.instanceId}:`)) return false;
    const expectedSig = createHmac('sha256', secrets.settingsPasswordHash)
      .update(payload)
      .digest('base64url');
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch (err) {
    // Temporarily log to diagnose auth failures
    import('../util/log.js').then(({ log }) => log.warn(`verifySessionToken error: ${err}`));
    return false;
  }
}

export function setSettingsSessionCookie(res: Response): void {
  const token = makeSessionToken();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE * 1000,
    // secure: true is enforced by the reverse proxy in production; omitting here
    // so the dev setup (plain HTTP) also works
  });
}

export function clearSettingsSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export function requireSettingsAuth(req: Request, res: Response, next: NextFunction): void {
  // Parse cookie from raw header (no cookie-parser dependency needed)
  const raw = req.headers.cookie ?? '';
  let token: string | undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k?.trim() === COOKIE_NAME) { token = decodeURIComponent(v.join('=').trim()); break; }
  }
  if (token && verifySessionToken(token)) {
    next();
    return;
  }
  // Redirect browser requests; return 401 for fetch/XHR
  const wantsJson = req.headers.accept?.includes('application/json');
  if (wantsJson) {
    res.status(401).json({ error: 'Not authenticated' });
  } else {
    res.redirect(303, `/settings/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
}
