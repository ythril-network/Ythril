/**
 * Whether a caller authenticated as an OIDC session: the ONE test (Q-531, bundle-100 row 8).
 *
 * An OIDC session is the record `validateOidcJwt` builds, marked `source: 'oidc'`. The audit trail asked that (`auditAuthMethod`), while
 * the view owner key, the MCP view acts and the view stream's liveness check asked `oidcIssuer !== undefined` - a second test that agrees
 * only while every record that carries an issuer is a session and every session carries one. A record that broke either half (a copied
 * record that kept the issuer, a session built without it) would be audited as one kind and owned as the other.
 *
 * A leaf (it imports nothing), so the config-side view shape and the audit middleware can both ask it. A door that snapshots a token at
 * its edge must carry `source` (`callerRecordOf`), or this answers "not a session" for one.
 */

/** What this reads off a caller: the mark `validateOidcJwt` sets. */
export interface OidcMark {
  source?: string | undefined;
}

/** Whether `token` is an OIDC session (`source: 'oidc'`). */
export function isOidc<T>(token: T): token is T & { source: 'oidc'; id: string } {
  return !!token && typeof token === 'object' && (token as OidcMark).source === 'oidc';
}
