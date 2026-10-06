/**
 * The host's own non-loopback IPv4 — a PRIVATE address the SSRF guards permit under an opt-in.
 *
 * Why tests need this: since the OIDC issuer guard (SSRF part 2b), loopback is a crown-jewel address
 * that stays blocked even with `oidc.allowPrivateIssuer` on. Any test that stands up a mock IdP and
 * expects the server to actually fetch it therefore cannot bind to `127.0.0.1` — the request is
 * refused before a socket opens, and the test proves nothing about the behaviour it names.
 *
 * Binding to the machine's LAN address instead keeps the mock reachable and, as a side effect, makes
 * those tests a live proof that the private-issuer opt-in works — which is the half of that change
 * that turns into an upgrade outage if it ever breaks.
 *
 * Returns null on a host with no non-loopback IPv4 (rare; callers should skip with a clear reason).
 */
import os from 'node:os';
import { absentInputReason } from '../_shared/absent-input.mjs';

export function privateHostAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/**
 * Skip reason for a suite that needs a reachable non-loopback address, or false when one exists.
 *
 * It SKIPS on a laptop and THROWS on CI, the way `mongoSkipReason()` does: a runner with no private address
 * cannot run any test that stands up a mock IdP or a peer the SSRF guards will fetch, and a skip there reads
 * as a pass for the whole family. Every test asks this question through here (a gate holds it), so the CI half
 * cannot be forgotten by a copy.
 */
export function privateAddressSkipReason() {
  if (privateHostAddress()) return false;
  return absentInputReason(
    'no non-loopback IPv4 on this host',
    'The tests that stand up a mock IdP or a peer the SSRF guards will fetch must bind a private address '
    + '(loopback is a blocked range even under the opt-in), so this runner cannot run any of them.',
  );
}
