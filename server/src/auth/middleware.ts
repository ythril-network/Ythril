import type { Request, Response, NextFunction } from 'express';
import { findMatchingToken, touchToken } from './tokens.js';
import { isMfaEnabled, verifyMfaCode } from './totp.js';
import type { TokenRecord } from '../config/types.js';

// Augment Express Request type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authToken?: Omit<TokenRecord, 'hash'>;
      resolvedSpaceId?: string;
    }
  }
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

/**
 * Middleware that requires a valid Bearer PAT token.
 * Sets req.authToken on success.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const record = await findMatchingToken(plaintext);
  if (!record) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const { hash: _h, ...safeRecord } = record;
  req.authToken = safeRecord;

  // Update lastUsed asynchronously — do not block request
  touchToken(record.id);

  next();
}

/**
 * Middleware that requires a valid Bearer PAT token AND that the token
 * has access to the space ID in req.params.spaceId.
 */
export async function requireSpaceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const record = await findMatchingToken(plaintext);
  if (!record) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const spaceId = req.params['spaceId'] as string | undefined;
  if (record.spaces && spaceId && !record.spaces.includes(spaceId)) {
    res.status(403).json({ error: `Token does not have access to space '${spaceId}'` });
    return;
  }

  const { hash: _h, ...safeRecord } = record;
  req.authToken = safeRecord;
  req.resolvedSpaceId = spaceId;
  touchToken(record.id);
  next();
}

/** Middleware: requires a valid PAT **with admin: true**.
 *  Must be used after (or instead of) requireAuth on admin-only routes.
 *  Non-admin tokens receive 403 even if they are otherwise valid.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const record = await findMatchingToken(plaintext);
  if (!record) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (!record.admin) {
    res.status(403).json({ error: 'Admin token required' });
    return;
  }

  const { hash: _h, ...safeRecord } = record;
  req.authToken = safeRecord;
  touchToken(record.id);
  next();
}

/**
 * Middleware: requires a valid admin PAT **and**, when MFA is enabled,
 * a valid TOTP code in the `X-TOTP-Code` header.
 *
 * When MFA is disabled (no `totpSecret` in secrets.json) this behaves
 * identically to `requireAdmin` so enabling MFA is purely additive.
 *
 * Error codes returned (distinguish from generic 403 on the client):
 *   403 { error: 'MFA_REQUIRED' } — MFA enabled, header missing
 *   403 { error: 'MFA_INVALID'  } — MFA enabled, code wrong / expired
 */
export async function requireAdminMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const record = await findMatchingToken(plaintext);
  if (!record) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (!record.admin) {
    res.status(403).json({ error: 'Admin token required' });
    return;
  }

  if (isMfaEnabled()) {
    const code = (req.headers['x-totp-code'] as string | undefined ?? '').trim();
    if (!code) {
      res.status(403).json({ error: 'MFA_REQUIRED' });
      return;
    }
    if (!verifyMfaCode(code)) {
      res.status(403).json({ error: 'MFA_INVALID' });
      return;
    }
  }

  const { hash: _h, ...safeRecord } = record;
  req.authToken = safeRecord;
  touchToken(record.id);
  next();
}
