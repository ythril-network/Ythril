/**
 * Shared SSRF-safe peer URL validator.
 *
 * Used by both the network member add flow (networks.ts) and the invite apply
 * flow (invite.ts) to prevent server-side request forgery.
 *
 * Blocks:
 *  - Non-http(s) schemes
 *  - Embedded credentials in the URL
 *  - Loopback IPv4 (127/8) and hostname "localhost"
 *  - Loopback IPv6 (::1)
 *  - ULA IPv6 (fc00::/7)  ← addresses starting fc or fd
 *  - Link-local IPv6 (fe80::/10)
 *  - RFC-1918 private IPv4 (10/8, 172.16-31/12, 192.168/16)
 *  - Link-local IPv4 (169.254/16) — covers AWS/Azure IMDS
 *  - GCP metadata FQDN (metadata.google.internal)
 *  - 0.0.0.0
 */

// Matches private/loopback/link-local IPv4 ranges.
const PRIVATE_IP_RE =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)$/;

/**
 * Returns true only if the URL is safe to use as a sync peer target.
 * Rejects private/loopback/ULA/link-local addresses and unsafe schemes.
 */
export function isSsrfSafeUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false; // malformed URL
  }

  // Only http and https are valid transport schemes for a sync peer.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Reject embedded credentials — they belong in the token, not the URL.
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();

  // Block localhost by name.
  if (host === 'localhost') return false;

  // Block GCP metadata server (FQDN, not just IP).
  if (host === 'metadata.google.internal') return false;

  // Strip brackets from IPv6 addresses for range checks.
  const ipv6 = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1).toLowerCase()
    : host.toLowerCase();

  // Block loopback IPv6.
  if (ipv6 === '::1') return false;

  // Block ULA IPv6 (fc00::/7): addresses starting with fc or fd.
  if (/^f[cd][0-9a-f]{0,2}:/i.test(ipv6)) return false;

  // Block link-local IPv6 (fe80::/10): addresses starting with fe8, fe9, fea, feb.
  if (/^fe[89ab][0-9a-f]:/i.test(ipv6)) return false;

  // Block private/link-local/loopback IPv4 ranges.
  if (PRIVATE_IP_RE.test(host)) return false;

  return true;
}

/** Zod refinement message for SSRF-safe URL fields. */
export const SSRF_SAFE_MESSAGE =
  'Peer URL must use http(s) and must not target private IPs, loopback, ' +
  'ULA/link-local IPv6, cloud metadata endpoints, or include embedded credentials';

/**
 * Returns true if the MongoDB URI hostname is safe (not private/loopback).
 * Accepts mongodb:// and mongodb+srv:// schemes only.
 *
 * Used to validate user-supplied connection strings in the data config API
 * before the server attempts to connect.
 */
export function isSsrfSafeMongoUri(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'mongodb:' && parsed.protocol !== 'mongodb+srv:') return false;

  // For replica sets the host list lives in parsed.host, but URL only parses the first.
  // This covers the common single-host case and prevents the most obvious SSRF vectors.
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;

  if (host === 'localhost') return false;
  if (host === 'metadata.google.internal') return false;

  // Strip IPv6 brackets
  const ip6 = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (ip6 === '::1') return false;
  if (/^f[cd][0-9a-f]{0,2}:/i.test(ip6)) return false;
  if (/^fe[89ab][0-9a-f]:/i.test(ip6)) return false;

  if (PRIVATE_IP_RE.test(host)) return false;

  return true;
}
