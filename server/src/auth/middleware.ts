import type { Request, Response, NextFunction } from 'express';
import { findMatchingToken, touchToken } from './tokens.js';
import { isMfaEnabled, verifyMfaCode } from './totp.js';
import { validateOidcJwt, getOidcConfig } from './oidc.js';
import type { TokenRecord } from '../config/types.js';
import type { OidcTokenRecord } from './oidc.js';
import { resolveMemberSpaces } from '../spaces/proxy.js';
import { authAttemptsTotal } from '../metrics/registry.js';
import { logAuthFailure } from '../audit/middleware.js';

// Augment Express Request type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authToken?: Omit<TokenRecord, 'hash'> | OidcTokenRecord;
      resolvedSpaceId?: string;
      requestId?: string;
    }
  }
}

/** Returns true when the bearer value looks like a PAT (Ythril-issued token). */
function isPat(bearer: string): boolean {
  return bearer.startsWith('ythril_');
}

/**
 * Resolve a bearer token to an auth record, trying PAT first and OIDC JWT
 * as a fallback when OIDC is enabled and the value is not a PAT.
 *
 * Returns null when validation fails.
 */
async function resolveBearer(
  bearer: string,
): Promise<Omit<TokenRecord, 'hash'> | OidcTokenRecord | null> {
  if (isPat(bearer)) {
    // PAT path — existing bcrypt verification
    const record = await findMatchingToken(bearer);
    if (!record) return null;
    const { hash: _h, ...safeRecord } = record;
    return safeRecord;
  }

  // Non-PAT bearer — attempt OIDC JWT validation when OIDC is enabled
  if (getOidcConfig()) {
    return validateOidcJwt(bearer);
  }

  return null;
}

/**
 * Middleware: rejects requests from read-only tokens.
 * Must be placed after requireAuth / requireSpaceAuth on mutating routes.
 */
export function denyReadOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.authToken?.readOnly) {
    res.status(403).json({ error: 'This token has read-only access' });
    return;
  }
  next();
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  // Fallback: query parameter (used by EventSource / SSE which cannot set headers)
  const queryToken = req.query['token'];
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();
  return null;
}

/**
 * Middleware that requires a valid Bearer PAT token.
 * Sets req.authToken on success.
 * SchemaLibrary-scoped tokens are rejected here — they are only valid on
 * GET /api/schema-library/public* via acceptSchemaLibraryToken.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const bearer = extractBearer(req);
  if (!bearer) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const record = await resolveBearer(bearer);
  if (!record) {
    authAttemptsTotal.inc({ result: 'invalid' });
    logAuthFailure(req);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // schemaLibrary tokens have no space/admin access — reject them on all other routes
  if ('schemaLibrary' in record && record.schemaLibrary) {
    res.status(403).json({ error: 'Library access tokens may only be used on the schema library public endpoint' });
    return;
  }

  authAttemptsTotal.inc({ result: 'success' });
  req.authToken = record;

  // Update lastUsed asynchronously for PAT tokens — do not block request
  if (isPat(bearer) && 'id' in record) touchToken(record.id);

  next();
}

/**
 * Middleware for GET /api/schema-library/public* routes.
 * The route is unauthenticated by default, but ALSO accepts a valid
 * schemaLibrary Bearer token so that instances behind a reverse proxy
 * that requires Bearer credentials can still browse the catalog.
 * Any other token type present in the header is rejected with 403
 * (don't silently ignore an invalid/wrong-scope credential).
 */
export async function acceptSchemaLibraryToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const bearer = extractBearer(req);
  if (!bearer) { next(); return; } // no auth header — public access

  const record = await resolveBearer(bearer);
  if (!record) {
    authAttemptsTotal.inc({ result: 'invalid' });
    logAuthFailure(req);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (!('schemaLibrary' in record) || !record.schemaLibrary) {
    res.status(403).json({ error: 'Only library access tokens may be used on this endpoint' });
    return;
  }

  authAttemptsTotal.inc({ result: 'success' });
  req.authToken = record;
  if (isPat(bearer) && 'id' in record) touchToken(record.id);
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
  const bearer = extractBearer(req);
  if (!bearer) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const record = await resolveBearer(bearer);
  if (!record) {
    authAttemptsTotal.inc({ result: 'invalid' });
    logAuthFailure(req);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const spaceId = req.params['spaceId'] as string | undefined;
  if (record.spaces && spaceId) {
    // For proxy spaces, the token must have access to all member spaces.
    // If the space doesn't exist in config, resolveMemberSpaces returns [].
    // Fall back to [spaceId] so the scope check still rejects tokens that
    // don't list this space — returning 403 instead of leaking a 404.
    const memberIds = resolveMemberSpaces(spaceId);
    const targets = memberIds.length > 0 ? memberIds : [spaceId];
    const missing = targets.filter(sid => !record.spaces!.includes(sid));
    if (missing.length > 0) {
      res.status(403).json({ error: `Token does not have access to space '${spaceId}'` });
      return;
    }
  }

  authAttemptsTotal.inc({ result: 'success' });
  req.authToken = record;
  req.resolvedSpaceId = spaceId;
  if (isPat(bearer) && 'id' in record) touchToken(record.id);
  next();
}

/**
 * Like requireAdminMfa, but also enforces the token's `spaces` allowlist
 * against the space ID found in `req.params[paramName]`.
 *
 * Use this on admin endpoints that target a specific space (e.g. schema
 * mutation, wipe, export, import) so that space-restricted admin tokens
 * cannot operate on spaces outside their allowlist.
 */
export function requireAdminMfaScoped(paramName: string) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const bearer = extractBearer(req);
    if (!bearer) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    const record = await resolveBearer(bearer);
    if (!record) {
      logAuthFailure(req);
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (!record.admin) {
      res.status(403).json({ error: 'Admin token required' });
      return;
    }

    // MFA check — same as requireAdminMfa
    if (isPat(bearer) && isMfaEnabled()) {
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

    // Space-scope enforcement for space-restricted admin tokens.
    // Tokens without a spaces allowlist (unrestricted admin) are always allowed.
    const spaceId = req.params[paramName] as string | undefined;
    if (record.spaces && spaceId) {
      const memberIds = resolveMemberSpaces(spaceId);
      const targets = memberIds.length > 0 ? memberIds : [spaceId];
      const missing = targets.filter(sid => !record.spaces!.includes(sid));
      if (missing.length > 0) {
        res.status(403).json({ error: `Token does not have access to space '${spaceId}'` });
        return;
      }
    }

    req.authToken = record;
    if (isPat(bearer) && 'id' in record) touchToken(record.id);
    next();
  };
}

/** Middleware: requires a valid PAT **with admin: true**.
 *  Must be used after (or instead of) requireAuth on admin-only routes.
 *  Non-admin tokens receive 403 even if they are otherwise valid.
 *
 *  Note: OIDC JWT tokens are also accepted when OIDC is enabled — the
 *  admin flag is derived from the configured claimMapping.admin rule.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const bearer = extractBearer(req);
  if (!bearer) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const record = await resolveBearer(bearer);
  if (!record) {
    logAuthFailure(req);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (!record.admin) {
    res.status(403).json({ error: 'Admin token required' });
    return;
  }

  req.authToken = record;
  if (isPat(bearer) && 'id' in record) touchToken(record.id);
  next();
}

/**
 * Middleware: requires a valid admin PAT **and**, when MFA is enabled,
 * a valid TOTP code in the `X-TOTP-Code` header.
 *
 * When MFA is disabled (no `totpSecret` in secrets.json) this behaves
 * identically to `requireAdmin` so enabling MFA is purely additive.
 *
 * Note: OIDC JWT tokens are also accepted when OIDC is enabled.  MFA is
 * NOT enforced for OIDC sessions (the IdP handles its own step-up auth).
 *
 * Error codes returned (distinguish from generic 403 on the client):
 *   403 { error: 'MFA_REQUIRED' } — MFA enabled, header missing
 *   403 { error: 'MFA_INVALID'  } — MFA enabled, code wrong / expired
 */
export async function requireAdminMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  const bearer = extractBearer(req);
  if (!bearer) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const record = await resolveBearer(bearer);
  if (!record) {
    logAuthFailure(req);
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (!record.admin) {
    res.status(403).json({ error: 'Admin token required' });
    return;
  }

  // MFA is only enforced for PAT sessions; OIDC sessions use IdP step-up auth.
  if (isPat(bearer) && isMfaEnabled()) {
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

  req.authToken = record;
  if (isPat(bearer) && 'id' in record) touchToken(record.id);
  next();
}
