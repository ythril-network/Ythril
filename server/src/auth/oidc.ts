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

import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { boundedJson } from '../util/bounded-read.js';
import type { JWTPayload } from 'jose';
import { getConfig } from '../config/loader.js';
import { allowPrivateOidcIssuer } from '../config/oidc-egress-policy.js';
import { log } from '../util/log.js';
import { isSsrfSafeUrl, ssrfSafeFetch, SsrfBlockedError } from '../util/ssrf.js';
import type { OidcConfig, OidcClaimRule, OidcClaimMapping } from '../config/types.js';
import { migrateToken } from './rights-migration.js';
import { withInstanceAdminGrants } from './instance-admin-grants.js';
import type { TokenRights } from '../config/rights-shape.js';

/**
 * JWS algorithms accepted for OIDC ID tokens unless `oidc.allowedAlgorithms`
 * narrows them. Asymmetric only: an IdP signs with its private key and publishes
 * the public half via JWKS.
 *
 * Note on the threat model: jose's JWKS resolver already refuses symmetric keys
 * ("Unsupported alg value for a JSON Web Key Set"), so the classic HS/RS
 * confusion attack was NOT reachable here even without this option. What pinning
 * buys is (a) the accepted set becomes explicit policy rather than a side effect
 * of the resolver's behaviour — it cannot silently widen if that behaviour
 * changes — and (b) operators can narrow it to exactly what their IdP signs with
 * (`allowedAlgorithms: ["RS256"]`), so an alg the IdP never uses is rejected
 * outright.
 */
export const DEFAULT_OIDC_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
];

// ── OIDC URL validation ───────────────────────────────────────────────────

/** Hint appended to every rejection that `oidc.allowPrivateIssuer` would have permitted. */
export const OIDC_PRIVATE_ISSUER_HINT =
  'set oidc.allowPrivateIssuer (or YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER=true) to permit an internal IdP on a private address';

/**
 * Validate a URL this module is about to fetch (or hand to the browser).
 *
 * Shape checks first, so the operator gets a specific message; then the address class is delegated
 * to `isSsrfSafeUrl`, which is the single place that knows every encoding of every blocked range.
 * This module used to carry its own two-line approximation (`169.254.*`, `metadata.google.internal`,
 * `0.0.0.0`) that let `10.*`, `192.168.*`, `172.16-31.*`, `127.*` and `::1` straight through.
 *
 * @param allowPrivate permit private/reserved ranges. Crown jewels (loopback, link-local / cloud
 *   IMDS, unspecified) are refused regardless — the flag widens where an IdP may live, it does not
 *   hand out the one address class SSRF is actually after.
 */
export function validateOidcUrl(raw: string, label: string, allowPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`OIDC ${label} is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OIDC ${label} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`OIDC ${label} must not contain embedded credentials`);
  }
  if (!isSsrfSafeUrl(raw, allowPrivate)) {
    throw new Error(allowPrivate
      ? `OIDC ${label} targets an always-blocked address (${parsed.hostname}): loopback, link-local / cloud metadata, or unspecified. allowPrivateIssuer permits private addresses, never these.`
      : `OIDC ${label} must be a public http(s) URL — ${parsed.hostname} is a private, loopback or cloud-metadata address. If this is an internal IdP, ${OIDC_PRIVATE_ISSUER_HINT}.`);
  }
}

/**
 * True when `issuerUrl` is reachable ONLY because the opt-in is on — i.e. it is a private address
 * rather than a public one.
 *
 * This is what scopes the allowance for the discovered endpoints. A private issuer may name private
 * endpoints (an internal Keycloak's `jwks_uri` is on the same internal network, naturally); a
 * PUBLIC issuer may not, flag or no flag. That asymmetry is the actual guard: the attack worth
 * stopping is a public — or spoofed — discovery document steering the server at `http://10.0.0.5/`,
 * and a global "private is fine now" flag would otherwise hand that over as a side effect of an
 * operator wanting their own Keycloak to work.
 */
export function issuerIsPrivate(issuerUrl: string): boolean {
  return !isSsrfSafeUrl(issuerUrl, false) && isSsrfSafeUrl(issuerUrl, true);
}

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
  /**
   * The same rights matrix a PAT carries, derived from the three fields above by `migrateToken` — the very
   * function the boot migration uses, so an OIDC identity and a PAT with the same claims are governed by
   * one mapping rather than two.
   *
   * It was absent until 3.0, and that absence was a hole rather than a gap: the MCP rights guard skips a
   * token with no matrix, so every OIDC connection fell back to the old `readOnly`/`admin` booleans while
   * PATs were enforced per space and per area. The whole point of S-1 was that one policy should not have
   * two implementations, and this was the third.
   *
   * Built per request, like the rest of this record — nothing is stored, so there is nothing to migrate.
   */
  rights: TokenRights;
  // Distinguish from PAT records for logging / introspection
  source: 'oidc';
}

// ── JWKS cache ─────────────────────────────────────────────────────────────
// createRemoteJWKSet() returns a live, self-refreshing handle.  One instance
// per issuer URL is sufficient; recreate if the issuer URL changes.

type JwksHandle = ReturnType<typeof createRemoteJWKSet>;

let _jwksHandle: JwksHandle | null = null;
let _cachedIssuerUrl = '';

/**
 * Ceiling for every outbound call this module makes to the IdP (discovery + JWKS).
 *
 * This sits on the AUTHENTICATION path: an IdP that accepts the TCP connection and then never
 * answers would otherwise hold the request until the OS socket timeout — minutes — and because the
 * discovery document is cached with a TTL, the stall recurs rather than happening once. Ten seconds
 * is well beyond any healthy IdP's response time and well below anything a user would wait out.
 */
export const OIDC_HTTP_TIMEOUT_MS = 10_000;

function getJwksHandle(jwksUri: string, issuerUrl: string, allowPrivate: boolean): JwksHandle {
  if (_jwksHandle && _cachedIssuerUrl === issuerUrl) return _jwksHandle;
  // jose defaults to 5s; pin it so the budget is explicit policy rather than a library default that
  // could change under us — the same reasoning as DEFAULT_OIDC_ALGORITHMS above.
  //
  // The JWKS fetch goes through `ssrfSafeFetch` for the same reason discovery does, and more so:
  // `jwks_uri` is a URL that arrived in a document, so it is the one target here an attacker gets to
  // choose. Validating the string is half a guard — jose would otherwise resolve and connect on its
  // own, with no DNS pinning and no redirect re-validation, so a name that passes the string check
  // and then resolves inward would sail through.
  _jwksHandle = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: OIDC_HTTP_TIMEOUT_MS,
    [customFetch]: (url, options) => ssrfSafeFetch(url, options as RequestInit, { allowPrivate }),
  });
  _cachedIssuerUrl = issuerUrl;
  return _jwksHandle;
}

// ── Discovery document cache ───────────────────────────────────────────────

export interface DiscoveryDoc {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

let _discoveryDoc: DiscoveryDoc | null = null;
let _discoveryIssuerUrl = '';
let _discoveryFetchedAt = 0;
const DISCOVERY_TTL_MS = 5 * 60 * 1000; // re-fetch every 5 minutes

/**
 * Validate a fetched discovery document against the configured issuer.
 *
 * Two separate rules, and it is worth being precise about which one does what:
 *
 *  1. **OIDC Discovery §4.3** — the document's own `issuer` MUST equal the configured URL. This is
 *     the one thing standing between a compromised document and a full takeover, and it predates
 *     this guard. Keep it first.
 *  2. **Every endpoint the document names is no more private than the issuer itself.** A discovery
 *     document is attacker-influenced input the moment the issuer is, and §4.3 constrains only the
 *     `issuer` field, not the endpoints beside it. So `jwks_uri` and friends go back through
 *     `validateOidcUrl` with the allowance derived from the *issuer's* address class — never from
 *     the global flag (see `issuerIsPrivate`).
 *
 * **Why not "the endpoints must share the issuer's host":** because that rule is wrong about real
 * IdPs, not merely strict. Google publishes `issuer: https://accounts.google.com` with
 * `jwks_uri: https://www.googleapis.com/oauth2/v3/certs` and
 * `token_endpoint: https://oauth2.googleapis.com/token` — three different origins, and not even a
 * shared registrable domain (`google.com` vs `googleapis.com`). Same-origin would break Google
 * Sign-In outright, which is the same class of upgrade outage this whole change exists to avoid.
 * The address-class rule above stops the attack that host-matching was reaching for — a public
 * document steering the server at an internal address — without asserting something false about how
 * IdPs deploy.
 *
 * @param allowPrivate whether the ISSUER is private (from `issuerIsPrivate`), not the global flag.
 */
export function validateDiscoveryDocument(
  doc: DiscoveryDoc,
  issuerUrl: string,
  allowPrivate: boolean,
): void {
  // OIDC Discovery §4.3: issuer in the document MUST match the configured URL.
  const normCfg = issuerUrl.replace(/\/$/, '');
  const normDoc = String(doc.issuer ?? '').replace(/\/$/, '');
  if (normDoc !== normCfg) {
    throw new Error(
      `OIDC discovery issuer (${doc.issuer}) does not match configured issuerUrl (${issuerUrl})`,
    );
  }

  // `jwks_uri` is REQUIRED by the spec and the server fetches it directly — no document without it
  // is usable, and an absent value must not fall through the checks below as `undefined`.
  if (!doc.jwks_uri) {
    throw new Error(`OIDC discovery document for ${issuerUrl} has no jwks_uri`);
  }

  // The endpoints the server fetches, plus the two the browser is sent to. All four are read out of
  // the same attacker-influenceable document, so all four are validated; the optional ones only when
  // present (omitting one breaks the flow, it does not evade anything).
  validateOidcUrl(doc.jwks_uri, 'jwks_uri', allowPrivate);
  if (doc.authorization_endpoint) validateOidcUrl(doc.authorization_endpoint, 'authorization_endpoint', allowPrivate);
  if (doc.token_endpoint) validateOidcUrl(doc.token_endpoint, 'token_endpoint', allowPrivate);
  if (doc.end_session_endpoint) validateOidcUrl(doc.end_session_endpoint, 'end_session_endpoint', allowPrivate);
}

export async function getDiscoveryDoc(issuerUrl: string): Promise<DiscoveryDoc> {
  const now = Date.now();
  if (
    _discoveryDoc &&
    _discoveryIssuerUrl === issuerUrl &&
    now - _discoveryFetchedAt < DISCOVERY_TTL_MS
  ) {
    return _discoveryDoc;
  }

  const allowPrivate = allowPrivateOidcIssuer();
  validateOidcUrl(issuerUrl, 'issuerUrl', allowPrivate);
  // Scope what the DOCUMENT may name to the issuer's own address class, not to the flag.
  const endpointsMayBePrivate = issuerIsPrivate(issuerUrl);

  const url = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  let res: Response;
  try {
    // `ssrfSafeFetch`, not `fetch`: the string check above cannot see where a hostname resolves, and
    // this call sits on the authentication path where a rebind would be repeated every TTL.
    res = await ssrfSafeFetch(url, { signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS) }, { allowPrivate });
  } catch (err) {
    // A blocked target is not "the IdP is down" — say which it was, and name the flag that would
    // permit it, so an operator whose Keycloak just stopped answering knows why in one line.
    if (err instanceof SsrfBlockedError) {
      throw new Error(`OIDC discovery blocked: ${err.message}${allowPrivate ? '' : ` — if this is an internal IdP, ${OIDC_PRIVATE_ISSUER_HINT}`}`);
    }
    // An unreachable IdP and one that hangs are the same failure to the caller, and both must be
    // reported as such rather than surfacing an opaque AbortError from deep in the auth path.
    const reason = err instanceof Error && err.name === 'TimeoutError'
      ? `no response within ${OIDC_HTTP_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    throw new Error(`OIDC discovery failed: ${reason} for ${url}`);
  }
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText} for ${url}`);
  }
  const doc = await boundedJson<DiscoveryDoc>(res, 'OIDC discovery');

  validateDiscoveryDocument(doc, issuerUrl, endpointsMayBePrivate);

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

export interface OidcPermissions {
  admin: boolean;
  readOnly: boolean | undefined;
  spaces: string[] | undefined;
  /** True when the token matched the admin or readOnly claim rule. */
  matched: boolean;
}

/**
 * Map OIDC JWT claims to Ythril permissions — **fail closed**.
 *
 * A token that matches NEITHER the admin nor the readOnly rule receives
 * read-only access to NO spaces. Previously such a token was granted
 * `readOnly: undefined` (i.e. read-write) and `spaces: undefined` (i.e. ALL
 * spaces), so any principal able to obtain an audience-matching JWT from a
 * shared realm got full read-write access to every space. Access must now be
 * granted explicitly via claim rules.
 *
 * When a `spaces` mapping is configured but the claim is missing or not an
 * array, the allow-list is empty (deny) rather than undefined (all spaces).
 */
export function mapOidcClaims(payload: JWTPayload, mapping: OidcClaimMapping): OidcPermissions {
  const admin = mapping.admin ? evaluateClaimRule(payload, mapping.admin) : false;
  const readOnlyMatched = mapping.readOnly ? evaluateClaimRule(payload, mapping.readOnly) : false;
  const matched = admin || readOnlyMatched;

  let spaces: string[] | undefined;
  if (mapping.spaces) {
    const raw = resolveClaim(payload, mapping.spaces.claim);
    spaces = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
  }

  if (!matched) {
    return { admin: false, readOnly: true, spaces: [], matched: false };
  }

  return {
    admin,
    readOnly: readOnlyMatched ? true : undefined,
    spaces,
    matched: true,
  };
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
    // Same allowance as the discovery fetch: the issuer's own class, not the global flag.
    const jwks = getJwksHandle(discovery.jwks_uri, oidcCfg.issuerUrl, issuerIsPrivate(oidcCfg.issuerUrl));

    const audience = oidcCfg.audience ?? oidcCfg.clientId;

    // Pin the accepted signature algorithms (see DEFAULT_OIDC_ALGORITHMS).
    const { payload } = await jwtVerify(bearer, jwks, {
      issuer: discovery.issuer,
      audience,
      algorithms: oidcCfg.allowedAlgorithms ?? DEFAULT_OIDC_ALGORITHMS,
    });

    // ── Map claims → permissions (fail-closed) ────────────────────────────
    const mapping = oidcCfg.claimMapping ?? {};
    const perms = mapOidcClaims(payload, mapping);

    // ── requireMatch guard ────────────────────────────────────────────────
    // When requireMatch is true, reject any token that matches neither the
    // admin nor the readOnly rule.  This prevents KC-authenticated users
    // who hold a valid audience-matched token (e.g. via SSO from a shared
    // realm) from accessing the instance without an explicit role assignment.
    if (mapping.requireMatch && !perms.matched) {
      log.warn('OIDC JWT rejected: requireMatch is enabled and no claim rule matched');
      return null;
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
      admin: perms.admin,
      readOnly: perms.readOnly,
      spaces: perms.spaces,
      // Derived, never hand-rolled. `migrateToken` already encodes the decisions this mapping needs —
      // `spaces` ABSENT means every space (a floor) while `spaces: []` reaches nothing, and that
      // distinction is the one that granted whole instances when it was got wrong before.
      // Through `withInstanceAdminGrants` like every stored token (S-11): an identity mapped to instance admin
      // holds the space-admin floor, so it reaches every space rather than only the ones its claim named.
      rights: withInstanceAdminGrants(migrateToken({
        admin: perms.admin,
        readOnly: perms.readOnly ?? false,
        ...(perms.spaces ? { spaces: perms.spaces } : {}),
      }) as unknown as TokenRights),
      source: 'oidc',
    };
  } catch (err) {
    log.warn(`OIDC JWT validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
