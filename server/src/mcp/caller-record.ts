/**
 * The record of the token a call came in on, as the tools that are ABOUT the caller read it (Q-531).
 *
 * One reader for both doors: the MCP connection and the REST tool door each snapshot the authenticated token at their own edge, and a
 * personal view's owner key is made of fields the two must read alike (`oauthClientId` for a connector, the issuer and `sub` for an OIDC
 * session). A door that copied only `id` would key every connector's views by a token id that changes on each rotation.
 */
import type { ToolCallerRecord } from './tools/types.js';

export function callerRecordOf(token: unknown): ToolCallerRecord | undefined {
  if (!token || typeof token !== 'object') return undefined;
  const t = token as Record<string, unknown>;
  if (typeof t['id'] !== 'string') return undefined;
  const str = (k: string): string | undefined => (typeof t[k] === 'string' && t[k] ? t[k] as string : undefined);
  const mfa = t['mfa'] === 'inherit' || t['mfa'] === 'exempt' || t['mfa'] === 'required' ? t['mfa'] : undefined;
  return {
    id: t['id'],
    // The mark `isOidc` reads: a snapshot without it would turn an OIDC session into a stored token for every view rule.
    source: str('source'),
    oauthClientId: str('oauthClientId'),
    oidcIssuer: str('oidcIssuer'),
    ...(Object.hasOwn(t, 'oidcSubject') ? { oidcSubject: typeof t['oidcSubject'] === 'string' && t['oidcSubject'] ? t['oidcSubject'] as string : null } : {}),
    peerInstanceId: str('peerInstanceId'),
    mfa,
    rights: (t['rights'] as ToolCallerRecord['rights']) ?? undefined,
  };
}
