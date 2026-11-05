/**
 * Does this server trust a proxy? — the one answer for every site that needs it: Express's own `trust proxy` setting (`app.ts`), the
 * startup posture check ("requireEncryptedTransport is on but trustProxy is not set") and the second-factor lockout (`auth/code-attempts.ts`,
 * which counts a source address only where a configured proxy has reported it).
 *
 * ## What it prevents
 *
 * Two files each read the setting their own way. The posture check counted `TRUST_PROXY=false` as configured (any non-empty env value was)
 * while the app turned the same value into `false`, so the check passed on an instance whose `req.secure` and `req.ip` were the proxy's. Both
 * now read the RESOLVED setting, the one `resolveTrustProxy` produces, so a value cannot mean "set" to one and "off" to the other.
 */
import { getConfig } from './loader.js';

/**
 * Resolve the Express `trust proxy` setting from the TRUST_PROXY env var (takes
 * precedence) or `config.trustProxy`. Defaults to `false` so a directly-exposed
 * deployment derives `req.ip` from the socket, not a spoofable X-Forwarded-For.
 */
export function resolveTrustProxy(): boolean | number | string {
  let raw: unknown = process.env['TRUST_PROXY'];
  if (raw === undefined) {
    try { raw = getConfig().trustProxy; } catch { raw = undefined; } // config not loaded on first run
  }
  if (raw === undefined || raw === null || raw === false || raw === '') return false;
  if (raw === true) return true;
  if (typeof raw === 'number') return raw;
  if (Array.isArray(raw)) return raw.join(',');
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === 'true') return true;
    if (s === 'false' || s === '') return false;
    if (/^\d+$/.test(s)) return Number(s);
    return s; // 'loopback' or a comma-separated CIDR/IP list — Express parses these
  }
  return false;
}

/**
 * Whether a proxy is trusted: the resolved setting is anything but off (`false`, `0` hops, nothing). With no argument the setting is resolved
 * now, from the env and the config; a running app passes the setting it holds (`req.app.settings['trust proxy']`), which is what it resolved at
 * boot, so the answer is the one Express acts on. An argument that is `undefined` is a setting the app holds as unset, so it answers false and
 * does not fall back to the env (which is why the argument is a rest tuple and not a default).
 */
export function trustProxyConfigured(...held: [] | [setting: unknown]): boolean {
  return Boolean(held.length === 0 ? resolveTrustProxy() : held[0]);
}
