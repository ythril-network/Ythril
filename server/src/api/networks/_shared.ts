/**
 * Shared vocabulary for the /api/networks sub-routers.
 *
 * Extracted when the 1196-line api/networks.ts was split by concern (A17.5). Only the pieces used by
 * more than one sub-router live here; a request schema used by exactly one route stays next to it.
 */
import { z } from 'zod';
import type { NetworkConfig } from '../../config/types.js';
import { isSsrfSafeUrl, SSRF_SAFE_MESSAGE } from '../../util/ssrf.js';
import { isPeerSchemeAllowed, PEER_SCHEME_MESSAGE } from '../../config/transport-security.js';

export const BCRYPT_ROUNDS = 12;

// ── SSRF-safe peer URL validation ────────────────────────────────────────────
// Shared validator from util/ssrf.ts covers:
//   RFC-1918 IPv4, loopback, 169.254 IMDS, IPv6 ULA (fc00::/7),
//   IPv6 link-local (fe80::/10), GCP metadata FQDN, embedded credentials.
// Keep the `.url().refine(isSsrfSafeUrl, …)` chain intact — a bare `z.string()` still compiles and
// still type-checks, but silently accepts loopback/IMDS/ULA peers. Only the red-team suite catches
// that, so treat this declaration as security-critical when refactoring.
export const SSRF_SAFE_URL = z
  .string()
  .url()
  .refine(isSsrfSafeUrl, { message: SSRF_SAFE_MESSAGE })
  .refine(isPeerSchemeAllowed, { message: PEER_SCHEME_MESSAGE });

/** Member list a joiner receives once admitted (credential fields stripped). */
export function safeMemberList(net: NetworkConfig, excludeInstanceId: string) {
  return net.members
    .filter(m => m.instanceId !== excludeInstanceId)
    .map(({ tokenHash: _th, skipTlsVerify: _sv, ...m }) => m);
}

/**
 * A network act's answer on the wire (`networks/network-acts.ts`, `networks/vote-acts.ts`). The status is the act's
 * own; a router only translates it — one copy, because the MCP door translates the same result the same way.
 */
export function sendAct(res: import('express').Response, r: import('../../networks/network-acts.js').NetworkActResult): void {
  if (r.status === 204) { res.status(204).end(); return; }
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  res.status(r.status).json(r.body);
}
