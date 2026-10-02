/**
 * SSRF-safe outbound fetch + URL validation for the sync engine.
 *
 * Sync connects to peer-supplied URLs. Peer URLs are validated at admission, but
 * a peer can rewrite its own stored URL post-admission (gossip / self-update), so
 * every outbound sync connection must be validated **at connection time** — DNS
 * resolved, the socket pinned to the validated IP, and each redirect re-checked.
 * `peerSafeFetch` is a drop-in for `fetch` that does exactly that (via
 * `ssrfSafeFetch`), and `isPeerUrlAllowed` is the synchronous check used before
 * persisting a peer-supplied URL.
 *
 * Policy: crown-jewel addresses (loopback, link-local/IMDS, unspecified) are
 * always blocked. Other private ranges are blocked unless `allowPrivatePeers` is
 * enabled (config key or the SYNC_ALLOW_PRIVATE_PEERS env var), for same-host /
 * LAN deployments — including the test harness, whose peers are on the Docker
 * bridge network.
 */

import { ssrfSafeFetch, isPeerUrlSafe } from '../util/ssrf.js';
import { getConfig } from '../config/loader.js';
import { log, logSafe } from '../util/log.js';
import { requireEncryptedTransport, allowInsecurePeersRaw, isPeerSchemeAllowed } from '../config/transport-security.js';

/** Whether sync peers may use private/reserved (non-crown-jewel) addresses. */
export function allowPrivatePeers(): boolean {
  if (process.env['SYNC_ALLOW_PRIVATE_PEERS'] === 'true') return true;
  try { return getConfig().allowPrivatePeers === true; } catch { return false; }
}

/** True if a peer-supplied URL may be stored/connected to under the current policy (address + scheme). */
export function isPeerUrlAllowed(url: string): boolean {
  return isPeerSchemeAllowed(url) && isPeerUrlSafe(url, allowPrivatePeers());
}

// Warn at most once per plaintext peer host, so a pre-existing `http://` peer (added before the
// https-default, without opting in) nags rather than spams every sync cycle.
const _warnedPlaintextHosts = new Set<string>();

/**
 * Default budget for a CONTROL-PLANE peer call — members, votes, tombstones, manifests, record
 * batches. All bounded payloads, so a request still running after this is not slow, it is stuck.
 *
 * Deliberately longer than a UI-facing timeout: sync runs in the background, a peer may be mid-GC or
 * behind a slow link, and killing a working transfer is worse than waiting a bit.
 */
export const PEER_TIMEOUT_MS = 30_000;

/**
 * Budget for a whole-FILE transfer.
 *
 * `AbortSignal.timeout` covers the entire operation including reading the body, so the control-plane
 * value would abort any file large enough to take 30 s — turning a missing timeout into a broken sync,
 * which is a worse bug than the one being fixed. Ten minutes still bounds a hang; it just does not
 * pretend a 2 GB file over a slow link is a stall.
 */
export const PEER_TRANSFER_TIMEOUT_MS = 10 * 60_000;

/**
 * A request init for a WHOLE-FILE transfer: the caller's headers without its control-plane deadline.
 *
 * `peerSafeFetch` resolves `init.signal ?? AbortSignal.timeout(opts.timeoutMs)`, so an explicit signal
 * WINS over the budget beside it. The engine builds one request init for the control plane, carrying a
 * ten-second signal, and passing that to a transfer call made `PEER_TRANSFER_TIMEOUT_MS` dead code —
 * every file whose body took longer than ten seconds aborted and was retried identically for ever.
 *
 * The rule lives here rather than at the call site because this file owns what each budget is FOR. A call
 * site that strips the signal by hand is a second copy of that decision, and the first one was wrong.
 */
export function transferInit(init: RequestInit): RequestInit {
  const { signal: _controlPlane, ...rest } = init;
  return rest;
}

/**
 * SSRF-safe drop-in for `fetch()` used by the sync engine. Resolves + pins + re-validates redirects
 * against the peer policy. Also enforces the transport policy: in `requireEncryptedTransport` mode a
 * plaintext `http://` peer is refused outright; otherwise a plaintext peer that wasn't explicitly
 * opted into is allowed (back-compat for peers added before the https default) but warned once.
 * Throws `SsrfBlockedError` when the target (or a redirect hop) resolves to a blocked address.
 */
export function peerSafeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<Response> {
  let scheme = '';
  let host = rawUrl;
  try { const u = new URL(rawUrl); scheme = u.protocol; host = u.host; } catch { /* ssrfSafeFetch will reject */ }
  if (scheme === 'http:') {
    if (requireEncryptedTransport()) {
      return Promise.reject(new Error(`Refusing plaintext sync to ${host}: requireEncryptedTransport is enabled`));
    }
    if (!allowInsecurePeersRaw() && !_warnedPlaintextHosts.has(host)) {
      _warnedPlaintextHosts.add(host);
      log.warn(`Syncing to plaintext peer ${logSafe(host)} over http:// — data and tokens are unencrypted in transit. Use https:// or set allowInsecurePeers to acknowledge.`);
    }
  }
  // A timeout the CALLER does not have to remember. `fetch` has none by default, and a peer that
  // accepts the connection and then says nothing would otherwise hang this sync cycle forever — the
  // failure mode a remote you do not control is most likely to hand you. Applied here rather than at
  // each call site because 18 of the 21 sites had forgotten it, which is what a default is for.
  // An explicit `signal` from the caller always wins; this only fills the gap.
  const signal = init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? PEER_TIMEOUT_MS);
  return ssrfSafeFetch(rawUrl, { ...init, signal }, { allowPrivate: allowPrivatePeers() });
}
