/**
 * Is a claimed instance id the peer it names? (`S-6`)
 *
 * An invite handshake is unauthenticated on both ends: the joiner states its `instanceId` in the apply request, the
 * inviter states its own in the apply answer. That was harmless while the token a handshake mints reached only the
 * network being joined. Since Q-47 it reaches every network the pair already shares — the union, so the one token a
 * side keeps does not cut off an earlier network — and the sync door admits a peer token to every network its peer id
 * belongs to. So a claimed id that is already a peer here reached that peer's networks: anyone handed a bundle for one
 * network could apply as a real peer C and read everything this instance shares with C, and a malicious inviter could
 * do the same to a joiner.
 *
 * The rule: an id nobody here knows has nothing to impersonate and joins as it always did. An id that is already a
 * member of some network here must be proven —
 *
 *  - on the INVITER's side, by presenting a token this instance issued to that peer (the genuine peer holds one: it
 *    is what it syncs with);
 *  - on the JOINER's side, by the invite being served from the origin this instance already records for that peer, so
 *    the TLS connection is to the same server.
 *
 * Refused rather than narrowed: an unproven join under a known id would also register a member under that id and
 * overwrite the outbound token this instance keeps for the real peer, breaking its other networks.
 */
import type { Config } from '../config/types.js';
import { findMatchingToken } from './tokens.js';

/** Is `instanceId` a member of any network on this instance? */
export function isKnownPeer(cfg: Pick<Config, 'networks'>, instanceId: string): boolean {
  return cfg.networks.some(n => n.members.some(m => m.instanceId === instanceId));
}

/** The origin this instance records for a known peer, or null. */
export function recordedOriginOf(cfg: Pick<Config, 'networks'>, instanceId: string): string | null {
  for (const n of cfg.networks) {
    const m = n.members.find(x => x.instanceId === instanceId && x.url);
    if (m) { try { return new URL(m.url).origin; } catch { /* unparseable: keep looking */ } }
  }
  return null;
}

/**
 * The inviter's check at apply: `claimedId` is unknown here, or `bearer` is a live token this instance issued to it.
 * `bearer` is the raw `Authorization` value, with or without its `Bearer ` prefix.
 */
export async function claimedPeerIsProven(cfg: Pick<Config, 'networks'>, claimedId: string, bearer: string | undefined): Promise<boolean> {
  if (!isKnownPeer(cfg, claimedId)) return true;
  const raw = bearer?.replace(/^Bearer\s+/i, '').trim();
  if (!raw) return false;
  const record = await findMatchingToken(raw);
  return !!record && record.peerInstanceId === claimedId;
}

/**
 * The joiner's check on the apply answer: the inviter's `claimedId` is unknown here, or the invite came from the
 * origin this instance records for that peer. Pure.
 */
export function inviterIsWhoItClaims(cfg: Pick<Config, 'networks'>, claimedId: string, inviteUrl: string): boolean {
  if (!isKnownPeer(cfg, claimedId)) return true;
  const recorded = recordedOriginOf(cfg, claimedId);
  try { return recorded !== null && new URL(inviteUrl).origin === recorded; } catch { return false; }
}

/** The peer this instance knows at `inviteUrl`'s origin — whose token a joiner presents as proof — or null. Pure. */
export function knownPeerAt(cfg: Pick<Config, 'networks'>, inviteUrl: string): string | null {
  let origin: string;
  try { origin = new URL(inviteUrl).origin; } catch { return null; }
  for (const n of cfg.networks) {
    const m = n.members.find(x => { try { return new URL(x.url).origin === origin; } catch { return false; } });
    if (m) return m.instanceId;
  }
  return null;
}
