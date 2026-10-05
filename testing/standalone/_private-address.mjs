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
 * Under CI (`CI` set) the absence THROWS instead, like `mongoSkipReason`: a suite skipped for want of an address
 * reports green having proven nothing, and the runner that lost its network interface is the one to say so.
 */
export function privateAddressSkipReason() {
  if (privateHostAddress()) return false;
  if (process.env['CI']) {
    throw new Error(
      'This suite needs a non-loopback IPv4 address on the host (the SSRF guards block loopback), but CI is set and ' +
      'none exists — refusing to skip and report green.',
    );
  }
  return 'no non-loopback IPv4 on this host';
}
