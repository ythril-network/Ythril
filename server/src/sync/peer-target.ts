/**
 * Is this a peer this instance may sync, and is the id safe to act on?
 *
 * ## Why it is a module and not two checks
 *
 * `sync_now` has validated a `peerId` since SEC-16: the id must be a known member `instanceId`, and it is
 * never used as a URL. `POST /api/notify/trigger` gained the same parameter afterwards, and a second copy
 * of a security check is the defect this repository produces most — the two would agree on the day they
 * were written and the weaker one would win silently afterwards.
 *
 * ## What SEC-16 was actually about, and it is the forgettable half
 *
 * The danger is not a *wrong* peer id, it is a peer id that is not an id at all. An unvalidated value
 * reaches the sync engine and becomes the address it connects to, so a caller could point this instance at
 * a host of their choosing. The defence is an allowlist derived from the configured networks — never a
 * shape check, never a URL parse, and never "it looks like an instance id".
 *
 * That is why this returns a refusal for an unknown id rather than a boolean a caller can forget to read,
 * and why the allowlist is derived here from `getConfig()` rather than passed in: a caller that supplies
 * its own set is a caller that can supply the wrong one.
 */
import { getConfig } from '../config/loader.js';

/** A refusal ready to answer with, or `null` when the peer is a known member of some network. */
export function unknownPeerRefusal(peerId: string): { status: number; error: string } | null {
  const known = new Set(getConfig().networks.flatMap(n => n.members.map(m => m.instanceId)));
  if (known.has(peerId)) return null;
  return {
    status: 404,
    error: `peerId '${peerId}' is not a registered member in any network.`,
  };
}
