/**
 * Shared SSRF-safe URL validation and fetch helpers.
 *
 * Used by the network member add flow (networks.ts), invite apply (invite.ts),
 * webhook delivery (webhooks/dispatcher.ts), media-config, schema-library and
 * the Mongo URI config API to prevent server-side request forgery.
 *
 * Two layers of defence:
 *
 *  1. `isSsrfSafeUrl` — a synchronous, allocation-free string check used inside
 *     Zod refinements at config time. It rejects unsafe schemes, embedded
 *     credentials, and any host that is *literally* a blocked address — in ALL
 *     of its encodings: dotted-decimal, decimal/hex/octal integers, short forms
 *     (`127.1`), IPv4-mapped/compatible IPv6 (`[::ffff:127.0.0.1]`), ULA,
 *     link-local, loopback and the unspecified address. It does NOT resolve DNS.
 *
 *  2. `assertUrlSafeResolved` / `ssrfSafeFetch` — the authoritative, async,
 *     use-time check. It resolves the hostname via DNS and validates EVERY
 *     returned A/AAAA record against the block ranges, then (for fetch) follows
 *     redirects manually, re-validating each hop. This defeats DNS names that
 *     point at internal addresses and DNS-rebinding / redirect-to-internal
 *     pivots that a config-time string check can never catch.
 *
 * Blocked address ranges (IPv4): 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8,
 * 169.254/16 (incl. cloud IMDS 169.254.169.254), 172.16/12, 192.168/16, and
 * 255.255.255.255. IPv6: ::/128 (unspecified), ::1 (loopback), fc00::/7 (ULA),
 * fe80::/10 (link-local), plus any IPv4-mapped/compatible address embedding a
 * blocked IPv4. Hostnames `localhost` and `metadata.google.internal` are also
 * blocked by name.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { fetch as undiciFetch, Agent } from 'undici';
import { log, redactSecrets } from './log.js';

/** Thrown by the async SSRF guards when a target resolves to a blocked address. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * What an operator should change if this refusal was not the intended outcome.
 *
 * Named flags, not "adjust your configuration": the whole failure mode this guard produces is an
 * endpoint that looks correct and is refused anyway, and the one fact the operator is missing at that
 * moment is *which setting governs it*.
 */
const PRIVATE_ADDRESS_REMEDY =
  'if this address is meant to be reachable, set allowPrivateModelEndpoints ' +
  '(YTHRIL_ALLOW_PRIVATE_MODEL_ENDPOINTS=true) for a self-hosted model endpoint, or allowPrivatePeers ' +
  'for a sync peer';

const CROWN_JEWEL_REMEDY =
  'this address stays blocked even with the private-address opt-in on (loopback, link-local / cloud ' +
  'metadata, or unspecified) — point the endpoint at a routable service address instead';

/**
 * Refuse a target, and leave a trace.
 *
 * The guard used to throw and nothing else. The rejection travelled to the browser as an API payload
 * while the server side stayed completely silent, so an operator debugging a blocked endpoint was left
 * with the least correlatable evidence there is: a string in a dialog, with no timestamp, no host, and
 * no record of which rule fired or what would relax it. Nothing reached the container log at all.
 *
 * Every refusal now emits one `warn` naming the target, what it resolved to, and the remedy. Redacted,
 * because the unsafe-URL branch quotes the raw URL and a model endpoint's query string can carry a key.
 */
function refuse(message: string, remedy: string): SsrfBlockedError {
  log.warn(redactSecrets(`${message} — ${remedy}`));
  return new SsrfBlockedError(message);
}

// ── IPv4 helpers ─────────────────────────────────────────────────────────────

/** Blocked IPv4 CIDRs as [base, mask] pairs (unsigned 32-bit). */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8      "this network"
  [0x0a000000, 0xff000000], // 10.0.0.0/8     RFC-1918
  [0x64400000, 0xffc00000], // 100.64.0.0/10  CGNAT (RFC-6598)
  [0x7f000000, 0xff000000], // 127.0.0.0/8    loopback
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local incl. cloud IMDS
  [0xac100000, 0xfff00000], // 172.16.0.0/12  RFC-1918
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16 RFC-1918
  [0xffffffff, 0xffffffff], // 255.255.255.255 broadcast
];

/** Parse a standard dotted-decimal IPv4 string to an unsigned 32-bit int, or null. */
function dottedIpv4ToInt(dotted: string): number | null {
  const parts = dotted.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = parseInt(part, 10);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/**
 * Canonicalise a non-standard IPv4 host encoding to a dotted-decimal string.
 * Handles decimal/hex/octal integers and short forms following inet_aton
 * semantics (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `127.0.1`).
 * Returns null when `host` is not an inet_aton-parseable IPv4 (e.g. a hostname).
 */
function canonicalizeIpv4(host: string): string | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let v: number;
    if (/^0x[0-9a-f]+$/i.test(part)) v = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) v = parseInt(part, 8);
    else if (/^0$/.test(part)) v = 0;
    else if (/^[1-9][0-9]*$/.test(part)) v = parseInt(part, 10);
    else return null; // non-numeric part → this is a hostname, not a numeric IP
    if (!Number.isFinite(v) || v < 0) return null;
    nums.push(v);
  }
  // Leading parts are 8 bits each; the final part absorbs the remaining bits.
  let acc = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i]! > 255) return null;
    acc = acc * 256 + nums[i]!;
  }
  const remainderBits = 8 * (5 - nums.length); // 1→32, 2→24, 3→16, 4→8
  const maxLast = 2 ** remainderBits;
  const last = nums[nums.length - 1]!;
  if (last >= maxLast) return null;
  const n = (acc * maxLast + last) >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

function isBlockedIpv4Int(n: number): boolean {
  const u = n >>> 0;
  return BLOCKED_IPV4_CIDRS.some(([base, mask]) => ((u & mask) >>> 0) === (base >>> 0));
}

/**
 * "Crown-jewel" IPv4 ranges, blocked even when private addresses are permitted
 * (`allowPrivatePeers`, `allowPrivateModelEndpoints`): loopback, link-local incl.
 * cloud IMDS, the unspecified address, broadcast, and Alibaba Cloud metadata.
 *
 * The distinction matters: "RFC-1918 private" and "cloud metadata endpoint" are
 * DIFFERENT RISK CLASSES. An operator opting into private addresses wants their
 * 10.x cluster service reachable; nobody wants 169.254.169.254 or 100.100.100.200
 * reachable. Metadata endpoints that happen to live inside an otherwise-private
 * range therefore need an explicit carve-out, or the opt-in silently re-exposes
 * the single highest-value SSRF target on that host (→ cloud credentials).
 */
const ALWAYS_BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8      unspecified
  [0x7f000000, 0xff000000], // 127.0.0.0/8    loopback
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local incl. IMDS (AWS/GCP/Azure/Oracle/DO/Hetzner)
  [0xffffffff, 0xffffffff], // 255.255.255.255 broadcast
  // Alibaba Cloud's metadata endpoint. It sits in 100.64.0.0/10 (CGNAT), which "allow private" opens —
  // so without this carve-out, opting into private addresses would hand back the one target that
  // matters most on an Alibaba host. "RFC-1918 private" and "cloud metadata" are different risk
  // classes and must not share a switch.
  [0x646464c8, 0xffffffff], // 100.100.100.200 Alibaba Cloud IMDS
];

function isCrownJewelIpv4Int(n: number): boolean {
  const u = n >>> 0;
  return ALWAYS_BLOCKED_IPV4_CIDRS.some(([base, mask]) => ((u & mask) >>> 0) === (base >>> 0));
}

// ── IPv6 helpers ─────────────────────────────────────────────────────────────

/**
 * Expand an IPv6 literal (with optional `::` compression, embedded IPv4, or a
 * `%zone` suffix) to its 8 hextets as integers. Returns null when not a valid
 * IPv6 literal.
 */
function expandIpv6(input: string): number[] | null {
  let s = input.toLowerCase().split('%')[0]!; // drop zone id
  // Convert a trailing embedded IPv4 (`::ffff:127.0.0.1`) into two hextets.
  if (s.includes('.')) {
    const colon = s.lastIndexOf(':');
    if (colon === -1) return null;
    const v4 = s.slice(colon + 1);
    const n = dottedIpv4ToInt(v4);
    if (n === null) return null;
    s = s.slice(0, colon + 1) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0]!.length ? halves[0]!.split(':') : [];
  let hextets: string[];
  if (halves.length === 1) {
    hextets = head;
    if (hextets.length !== 8) return null;
  } else {
    const tail = halves[1]!.length ? halves[1]!.split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    hextets = [...head, ...Array(missing).fill('0'), ...tail];
    if (hextets.length !== 8) return null;
  }
  const out: number[] = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    out.push(parseInt(h, 16));
  }
  return out;
}

function isBlockedIpv6Expanded(h: number[]): boolean {
  // Unspecified :: and loopback ::1
  if (h.every(x => x === 0)) return true;
  if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return true;
  // ULA fc00::/7 and link-local fe80::/10
  if ((h[0]! & 0xfe00) === 0xfc00) return true;
  if ((h[0]! & 0xffc0) === 0xfe80) return true;
  // IPv4-mapped ::ffff:a.b.c.d  (h[0..4]=0, h[5]=0xffff)
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isBlockedIpv4Int((((h[6]! << 16) >>> 0) | h[7]!) >>> 0);
  }
  // IPv4-compatible ::a.b.c.d (deprecated, h[0..5]=0), excluding ::1 handled above
  if (h.slice(0, 6).every(x => x === 0) && (h[6] !== 0 || h[7] !== 0)) {
    return isBlockedIpv4Int((((h[6]! << 16) >>> 0) | h[7]!) >>> 0);
  }
  return false;
}

/** Crown-jewel IPv6: loopback ::1, unspecified ::, link-local fe80::/10, and any
 *  embedded IPv4 that is itself a crown jewel. ULA (fc00::/7) is NOT a crown jewel
 *  — it is a private range, allowable under `allowPrivatePeers`. */
function isCrownJewelIpv6Expanded(h: number[]): boolean {
  if (h.every(x => x === 0)) return true;                             // ::
  if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return true;   // ::1 loopback
  if ((h[0]! & 0xffc0) === 0xfe80) return true;                       // fe80::/10 link-local
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isCrownJewelIpv4Int((((h[6]! << 16) >>> 0) | h[7]!) >>> 0);
  }
  if (h.slice(0, 6).every(x => x === 0) && (h[6] !== 0 || h[7] !== 0)) {
    return isCrownJewelIpv4Int((((h[6]! << 16) >>> 0) | h[7]!) >>> 0);
  }
  // AWS's IPv6 instance-metadata endpoint, fd00:ec2::254. It lives in fd00::/8 (unique-local) — a range
  // "allow private" deliberately opens — so it needs the same explicit carve-out as 169.254.169.254 and
  // 100.100.100.200, or enabling private endpoints on an IPv6 EC2 host would quietly re-expose IMDS.
  if (h[0] === 0xfd00 && h[1] === 0x0ec2) return true;                // fd00:ec2::/32 AWS IMDS (IPv6)
  return false;
}

// ── Host classification ──────────────────────────────────────────────────────

/**
 * Returns true if `host` (an IP literal in any encoding, brackets optional) is a
 * blocked address. Returns false for plain hostnames — those must be resolved
 * via `assertUrlSafeResolved` before use.
 */
function checkBlockedIp(host: string, ipv4: (n: number) => boolean, ipv6: (h: number[]) => boolean): boolean {
  let stripped = host.trim().toLowerCase();
  if (stripped.startsWith('[') && stripped.endsWith(']')) stripped = stripped.slice(1, -1);
  stripped = stripped.replace(/\.$/, ''); // tolerate a single trailing dot
  if (stripped.includes(':')) {
    const h = expandIpv6(stripped);
    return h ? ipv6(h) : false;
  }
  if (net.isIPv4(stripped)) return ipv4(dottedIpv4ToInt(stripped)!);
  const canon = canonicalizeIpv4(stripped);
  if (canon) return ipv4(dottedIpv4ToInt(canon)!);
  return false;
}

export function isBlockedIp(host: string): boolean {
  return checkBlockedIp(host, isBlockedIpv4Int, isBlockedIpv6Expanded);
}

/**
 * Block check for a peer target. Crown-jewel ranges (loopback, link-local/IMDS,
 * unspecified) are always blocked; other private ranges (RFC-1918, CGNAT, ULA)
 * are blocked unless `allowPrivate` is set (opt-in for same-host / LAN sync).
 */
export function isPeerBlockedIp(host: string, allowPrivate: boolean): boolean {
  return allowPrivate ? checkBlockedIp(host, isCrownJewelIpv4Int, isCrownJewelIpv6Expanded) : isBlockedIp(host);
}

/** Normalise a URL hostname: lowercase, strip IPv6 brackets and a trailing dot. */
function normaliseHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h.replace(/\.$/, '');
}

/** True when the host is a literal IP address in any recognised encoding. */
function isIpLiteral(host: string): boolean {
  if (host.includes(':')) return expandIpv6(host) !== null;
  return net.isIPv4(host) || canonicalizeIpv4(host) !== null;
}

// ── Public synchronous validator (config-time, no DNS) ───────────────────────

/**
 * Returns true only if the URL is safe to use as an outbound target based on a
 * literal inspection of the host. Rejects unsafe schemes, embedded credentials,
 * and any host that is literally a blocked address in any encoding.
 *
 * NOTE: this does NOT resolve DNS. A hostname that resolves to an internal
 * address will pass here — call `assertUrlSafeResolved` / `ssrfSafeFetch` before
 * actually making the request.
 */
/**
 * @param allowPrivate permit private/reserved ranges (RFC-1918, CGNAT, IPv6 ULA) — for an
 *   operator-declared self-hosted endpoint on a cluster address. Crown-jewel addresses (loopback,
 *   link-local / cloud IMDS, unspecified) and the `localhost` / metadata hostnames stay blocked
 *   regardless, exactly as for sync peers. Default false keeps every existing caller unchanged.
 */
export function isSsrfSafeUrl(raw: string, allowPrivate = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;

  const host = normaliseHost(parsed.hostname);
  if (host === 'localhost' || host === 'metadata.google.internal') return false;
  if (isPeerBlockedIp(host, allowPrivate)) return false;
  return true;
}

/**
 * Peer-aware synchronous validator (config-time, no DNS). Like `isSsrfSafeUrl`
 * but honours `allowPrivate`. `localhost` and the cloud-metadata hostname are
 * rejected regardless (they always resolve to crown-jewel addresses).
 */
export function isPeerUrlSafe(raw: string, allowPrivate: boolean): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = normaliseHost(parsed.hostname);
  if (host === 'localhost' || host === 'metadata.google.internal') return false;
  if (isPeerBlockedIp(host, allowPrivate)) return false;
  return true;
}

/** Zod refinement message for SSRF-safe URL fields. */
export const SSRF_SAFE_MESSAGE =
  'Peer URL must use http(s) and must not target private IPs, loopback, ' +
  'ULA/link-local IPv6, cloud metadata endpoints, or include embedded credentials';

// ── Authoritative async check (resolves DNS) ─────────────────────────────────

export interface LookupAddress {
  address: string;
  family?: number;
}

/** Injectable resolver signature (defaults to `dns.lookup(host, { all: true })`). */
export type DnsLookup = (hostname: string) => Promise<LookupAddress[]>;

const defaultLookup: DnsLookup = async (hostname) => {
  const res = await dns.lookup(hostname, { all: true });
  return res as LookupAddress[];
};

/**
 * Assert that a URL is safe to fetch, resolving DNS and validating every
 * resolved address against the block ranges. Throws `SsrfBlockedError` when the
 * URL is unsafe or resolves to a blocked address.
 *
 * @param opts.lookup  Injectable DNS resolver (for testing / custom resolvers).
 * @returns the parsed URL and the resolved addresses (empty for IP literals).
 */
export async function assertUrlSafeResolved(
  raw: string,
  opts: { lookup?: DnsLookup; allowPrivate?: boolean } = {},
): Promise<{ url: URL; addresses: string[] }> {
  const allowPrivate = opts.allowPrivate ?? false;
  if (!isPeerUrlSafe(raw, allowPrivate)) {
    // Rejected on the literal URL, before any DNS. With the opt-in already on, the only things left that
    // can fail here are a bad scheme, embedded credentials, or a crown-jewel address written literally.
    throw refuse(`Blocked SSRF target (unsafe URL): ${raw}`,
      allowPrivate ? CROWN_JEWEL_REMEDY : PRIVATE_ADDRESS_REMEDY);
  }
  const url = new URL(raw);
  const host = normaliseHost(url.hostname);

  // IP literals were already validated above — no DNS needed.
  if (isIpLiteral(host)) return { url, addresses: [host] };

  const lookup = opts.lookup ?? defaultLookup;
  const results = await lookup(host);
  if (!results || results.length === 0) {
    throw refuse(`Blocked SSRF target (DNS returned no records): ${host}`,
      'the hostname did not resolve — this is a DNS failure, not a policy decision');
  }
  for (const a of results) {
    if (isPeerBlockedIp(a.address, allowPrivate)) {
      throw refuse(`Blocked SSRF target (${host} resolves to blocked address ${a.address})`,
        allowPrivate ? CROWN_JEWEL_REMEDY : PRIVATE_ADDRESS_REMEDY);
    }
  }
  return { url, addresses: results.map(a => a.address) };
}

/**
 * Build an undici dispatcher that pins every connection to `ip`. The socket
 * therefore connects to the exact address we validated, closing the TOCTOU
 * window where DNS could rebind to an internal address between validation and
 * connect. TLS SNI / certificate validation still use the URL hostname (undici
 * derives `servername` from the request URL, not from `lookup`), so HTTPS
 * targets keep working normally.
 */
export function pinnedAgent(ip: string): Agent {
  const family = net.isIP(ip) === 6 ? 6 : 4;
  return new Agent({
    connect: {
      lookup: (
        _hostname: string,
        options: { all?: boolean } | undefined,
        cb: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
      ) => {
        if (options && options.all) cb(null, [{ address: ip, family }]);
        else cb(null, ip, family);
      },
    },
  });
}

/**
 * Serialise a `FormData` body ourselves, because undici will not recognise this one.
 *
 * ## The bug
 *
 * External speech-to-text had never worked. The provider builds `new FormData()` — the **global**, which
 * in Node is the built-in undici — and hands it to this module, which imports `fetch` from the **undici
 * npm package**. Two different undici realms, so undici's internal `instanceof FormData` check fails, the
 * body falls through to the generic branch, and `String(body)` puts the literal text
 *
 *     [object FormData]
 *
 * on the wire under `Content-Type: text/plain;charset=UTF-8`. Reproduced directly against a local
 * listener. The receiving adapter saw `req.file` undefined WITHOUT `LIMIT_UNEXPECTED_FILE` — the
 * signature of a request that was not multipart at all rather than multipart under another field name.
 * Two copies of undici are installed (7.22.0 hoisted, 7.29.0 nested), so the realms were never going to
 * line up.
 *
 * ## Why the fix lives here and not in the provider
 *
 * Importing undici's own `FormData` in the provider would fix today's caller and leave the landmine for
 * the next one, in a file that has no reason to know which fetch implementation its transport uses. This
 * is the choke point every guarded egress passes through, so normalising here means no caller can step on
 * it — and a `Buffer` body is understood by every implementation, in any realm.
 *
 * Detection uses `Object.prototype.toString` rather than `instanceof`. Being precise about why, because
 * mutation testing showed the two are currently **equivalent**: the `FormData` binding visible here is
 * the global one, which is also what the providers construct, so `instanceof` would match today. It is
 * kept as the defensive form for the case this module already proves is possible — a body built in
 * another realm, e.g. by a caller importing `FormData` from the undici package directly, or by a nested
 * copy of a dependency. No test distinguishes them, and inventing one that appeared to would be worse
 * than saying so here.
 */
function isFormDataLike(v: unknown): boolean {
  return Object.prototype.toString.call(v) === '[object FormData]';
}

function isBlobLike(v: unknown): v is Blob {
  const tag = Object.prototype.toString.call(v);
  return tag === '[object Blob]' || tag === '[object File]';
}

async function serialiseMultipart(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const boundary = `----ythril${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of form.entries() as Iterable<[string, unknown]>) {
    parts.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if (isBlobLike(value)) {
      // `File` carries a name; a bare `Blob` does not, and the field name is the best available label.
      const filename = (value as File).name ?? name;
      const type = value.type || 'application/octet-stream';
      parts.push(Buffer.from(
        `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
        + `Content-Type: ${type}\r\n\r\n`, 'utf8'));
      parts.push(Buffer.from(await value.arrayBuffer()));
    } else {
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`, 'utf8'));
      parts.push(Buffer.from(String(value), 'utf8'));
    }
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Replace a cross-realm FormData body with bytes plus an explicit Content-Type. Other bodies pass through. */
async function normaliseBody(init: RequestInit): Promise<RequestInit> {
  if (!isFormDataLike(init.body)) return init;
  const { body, contentType } = await serialiseMultipart(init.body as FormData);
  const headers = new Headers((init.headers ?? {}) as HeadersInit);
  // Set, not append: a stale Content-Type without our boundary is unparseable.
  headers.set('Content-Type', contentType);
  // Bytes, deliberately — NOT a Blob. A Blob would be branded by whichever realm constructed it and we
  // would be back where we started. A plain typed array has no realm identity, so every implementation
  // accepts it. The cast is only because this project's `BodyInit` predates ArrayBufferView bodies;
  // undici and the platform both take one at runtime.
  const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return { ...init, body: bytes as unknown as BodyInit, headers };
}

/**
 * SSRF-safe replacement for `fetch`. Before each request it resolves and
 * validates the target (via `assertUrlSafeResolved`), then **pins the connection
 * to the validated IP** so a DNS rebind cannot redirect the socket to an internal
 * address after the check. Redirects are followed manually and every hop is
 * re-validated and re-pinned.
 *
 * A custom `opts.fetchImpl` (used in tests) bypasses IP pinning — the injected
 * implementation owns transport.
 *
 * Uses `redirect: 'manual'` internally regardless of any `init.redirect`.
 */
export async function ssrfSafeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; lookup?: DnsLookup; fetchImpl?: typeof fetch; allowPrivate?: boolean } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const injected = opts.fetchImpl;
  let current = rawUrl;
  // Once, before the redirect loop: a body may only be read a single time, and every hop resends it.
  const safeInit = await normaliseBody(init);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { addresses } = await assertUrlSafeResolved(current, { lookup: opts.lookup, allowPrivate: opts.allowPrivate });

    let resp: Response;
    let agent: Agent | undefined;
    if (injected) {
      resp = await injected(current, { ...safeInit, redirect: 'manual' });
    } else {
      agent = pinnedAgent(addresses[0]!);
      resp = await (undiciFetch as any)(current, { ...safeInit, redirect: 'manual', dispatcher: agent }) as Response;
    }

    const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null;
    if (!location) {
      if (!agent) return resp;
      // Detach from the pinned connection: buffer the (small) body and close the
      // agent so no socket lingers past return. Webhook callers read only status.
      const buf = await resp.arrayBuffer().catch(() => new ArrayBuffer(0));
      await agent.close().catch(() => { /* best-effort */ });
      // 204/205/304 are null-body statuses — the Response constructor throws if given ANY body
      // (even an empty buffer). A peer's `/api/notify` returns 204, so reconstruct with a null body
      // for those statuses. (The injected-fetchImpl test path returns `resp` directly above, which is
      // why unit tests never exercised this branch.)
      const nullBody = resp.status === 204 || resp.status === 205 || resp.status === 304;
      return new Response(nullBody ? null : buf, { status: resp.status, statusText: resp.statusText, headers: resp.headers as unknown as HeadersInit });
    }
    // Redirect: drain the body, close this hop's agent, then follow + re-validate.
    if (agent) {
      await resp.arrayBuffer().catch(() => { /* ignore */ });
      await agent.close().catch(() => { /* best-effort */ });
    }
    current = new URL(location, current).toString();
  }
  throw refuse(`Blocked SSRF target (too many redirects, > ${maxRedirects})`,
    'every hop is re-validated, so a redirect chain this long is refused on principle');
}

// ── MongoDB URI variant ──────────────────────────────────────────────────────

/**
 * Returns true if the MongoDB URI hostname is safe (not private/loopback).
 * Accepts mongodb:// and mongodb+srv:// schemes only.
 *
 * Covers the common single-host case. Replica-set host lists beyond the first
 * host are not parsed by the URL class; the async guards above should be used
 * for authoritative validation where a connection is actually opened.
 */
export function isSsrfSafeMongoUri(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'mongodb:' && parsed.protocol !== 'mongodb+srv:') return false;

  const host = normaliseHost(parsed.hostname);
  if (!host) return false;
  if (host === 'localhost' || host === 'metadata.google.internal') return false;
  if (isBlockedIp(host)) return false;
  return true;
}
