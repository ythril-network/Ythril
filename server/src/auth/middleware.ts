import type { Request, Response, NextFunction } from 'express';
import { findMatchingToken, touchToken } from './tokens.js';
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
