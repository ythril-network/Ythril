/**
 * OIDC JWT validation support for Ythril.
 *
 * When `oidc.enabled` is set in config.json this module:
 *  1. Fetches the IdP's OpenID Connect discovery document once (cached).
 *  2. Validates incoming JWTs using the JWKS endpoint (signature, iss, aud, exp).
 *  3. Maps IdP claims to a synthetic TokenRecord-like permission object so the
 *     rest of the middleware layer needs no changes.
 *
 * PAT tokens (prefix `ythril_`) are handled by the existing tokens.ts path and
 * are never routed through this module.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { OidcConfig, OidcClaimRule } from '../config/types.js';

// ── Lightweight synthetic token record ────────────────────────────────────
// This mirrors the fields of TokenRecord (minus hash/prefix/bcrypt fields)
// that the auth middleware reads from req.authToken.

export interface OidcTokenRecord {
  id: string;          // derived from JWT sub
  name: string;        // derived from JWT preferred_username or email or sub
  createdAt: string;   // JWT iat (or 'oidc')
  lastUsed: null;
  expiresAt: string | null;  // JWT exp
  admin: boolean;
  readOnly?: boolean;
  spaces?: string[];
  // Distinguish from PAT records for logging / introspection
  source: 'oidc';
}

// ── JWKS cache ─────────────────────────────────────────────────────────────
// createRemoteJWKSet() returns a live, self-refreshing handle.  One instance
// per issuer URL is sufficient; recreate if the issuer URL changes.

type JwksHandle = ReturnType<typeof createRemoteJWKSet>;

let _jwksHandle: JwksHandle | null = null;
let _cachedIssuerUrl = '';

function getJwksHandle(jwksUri: string, issuerUrl: string): JwksHandle {
  if (_jwksHandle && _cachedIssuerUrl === issuerUrl) return _jwksHandle;
  _jwksHandle = createRemoteJWKSet(new URL(jwksUri));
  _cachedIssuerUrl = issuerUrl;
  return _jwksHandle;
}

// ── Discovery document cache ───────────────────────────────────────────────

interface DiscoveryDoc {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

let _discoveryDoc: DiscoveryDoc | null = null;
let _discoveryIssuerUrl = '';
let _discoveryFetchedAt = 0;
const DISCOVERY_TTL_MS = 5 * 60 * 1000; // re-fetch every 5 minutes

export async function getDiscoveryDoc(issuerUrl: string): Promise<DiscoveryDoc> {
  const now = Date.now();
  if (
    _discoveryDoc &&
    _discoveryIssuerUrl === issuerUrl &&
    now - _discoveryFetchedAt < DISCOVERY_TTL_MS
  ) {
    return _discoveryDoc;
  }

  const url = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const doc = await res.json() as DiscoveryDoc;
  _discoveryDoc = doc;
  _discoveryIssuerUrl = issuerUrl;
  _discoveryFetchedAt = now;
  return doc;
}

/** Invalidate all in-memory OIDC caches (call on config reload). */
export function clearOidcCache(): void {
  _jwksHandle = null;
  _cachedIssuerUrl = '';
  _discoveryDoc = null;
  _discoveryIssuerUrl = '';
  _discoveryFetchedAt = 0;
}

// ── Claim resolution ───────────────────────────────────────────────────────

/**
 * Resolve a dot-notated path (e.g. "realm_access.roles") in a JWT payload.
 * Returns the value at that path, or undefined if the path does not exist.
 */
function resolveClaim(payload: JWTPayload, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = payload;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Evaluate a single OidcClaimRule against a JWT payload.
 * Returns true when the rule matches.
 */
function evaluateClaimRule(payload: JWTPayload, rule: OidcClaimRule): boolean {
  const val = resolveClaim(payload, rule.claim);
  if (val === undefined || val === null) return false;

  if (rule.value !== undefined) {
    // The claim must equal `value` OR be an array containing `value`
    if (Array.isArray(val)) return val.includes(rule.value);
    return val === rule.value;
  }

  // No `value` constraint: the claim simply needs to be truthy
  if (Array.isArray(val)) return val.length > 0;
  return Boolean(val);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Returns the active OidcConfig, or null if OIDC is disabled / unconfigured. */
export function getOidcConfig(): OidcConfig | null {
  const cfg = getConfig();
  if (!cfg.oidc || !cfg.oidc.enabled) return null;
  return cfg.oidc;
}

/**
 * Validate a JWT bearer token against the configured OIDC provider.
 *
 * Returns a synthetic OidcTokenRecord on success, or null on failure.
 * Never throws — all errors are caught and logged.
 */
export async function validateOidcJwt(bearer: string): Promise<OidcTokenRecord | null> {
  const oidcCfg = getOidcConfig();
  if (!oidcCfg) return null;

  try {
    const discovery = await getDiscoveryDoc(oidcCfg.issuerUrl);
    const jwks = getJwksHandle(discovery.jwks_uri, oidcCfg.issuerUrl);

    const audience = oidcCfg.audience ?? oidcCfg.clientId;

    const { payload } = await jwtVerify(bearer, jwks, {
      issuer: discovery.issuer,
      audience,
    });

    // ── Map claims → permissions ──────────────────────────────────────────
    const mapping = oidcCfg.claimMapping ?? {};

    const admin = mapping.admin ? evaluateClaimRule(payload, mapping.admin) : false;
    const readOnly = mapping.readOnly ? evaluateClaimRule(payload, mapping.readOnly) : undefined;

    let spaces: string[] | undefined;
    if (mapping.spaces) {
      const raw = resolveClaim(payload, mapping.spaces.claim);
      if (Array.isArray(raw)) {
        spaces = raw.filter((s): s is string => typeof s === 'string');
      }
    }

    // ── Derive display name ────────────────────────────────────────────────
    const sub = payload.sub ?? 'unknown';
    const preferredUsername =
      (payload as Record<string, unknown>)['preferred_username'] as string | undefined;
    const email = (payload as Record<string, unknown>)['email'] as string | undefined;
    const name = preferredUsername ?? email ?? sub;

    const expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
    const createdAt = payload.iat ? new Date(payload.iat * 1000).toISOString() : new Date().toISOString();

    return {
      id: `oidc:${sub}`,
      name,
      createdAt,
      lastUsed: null,
      expiresAt,
      admin,
      readOnly: readOnly === true ? true : undefined,
      spaces,
      source: 'oidc',
    };
  } catch (err) {
    log.warn(`OIDC JWT validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
