/**
 * The invite handshake's session store — in memory only, because a session holds an ephemeral RSA private key that
 * must never reach disk.
 *
 * ## Why this is its own module
 *
 * `POST /api/invite/redeem` (F-41) made the store reachable WITHOUT a token: anyone holding a pub/sub's published key
 * opens a session. Three things that were harmless while only an admin could open one stopped being harmless, and
 * each is enforced here, where no route can leave it out:
 *
 * - **A lookup costs one bcrypt compare, not one per session.** `find` used to bcrypt-compare the presented id
 *   against every open session, so N open sessions made every unauthenticated apply, finalize and status call cost N
 *   compares. Each session now also carries a SHA-256 digest of its id: the digest picks the one candidate and bcrypt
 *   confirms it. A handshake id is a random UUID (122 bits), so a fast digest reveals nothing a guess could use.
 * - **A redeemed session is short and counted per caller.** Ten minutes rather than an hour, and `redeemedOpen`
 *   answers per network AND per caller address, so one caller cannot hold a network's whole allowance.
 * - **A redeemed session dies with the key that opened it.** It records the invite-key hash it was redeemed under,
 *   and `find` refuses it once the network holds a different one — so regenerating a leaked key closes the doors the
 *   old key already opened, rather than leaving them open for the rest of their life.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

const BCRYPT_ROUNDS = 12;
export const HANDSHAKE_TTL_MS = 60 * 60 * 1000;
/** A session opened by a published key: long enough to finish a join, short enough that a flood drains itself. */
export const REDEEMED_TTL_MS = 10 * 60 * 1000;

export interface HandshakeSession {
  /** bcrypt hash of the plaintext handshakeId */
  idHash: string;
  /** SHA-256 of the plaintext handshakeId: selects the one session `find` then confirms with bcrypt. */
  idDigest: string;
  networkId: string;
  /** A's ephemeral RSA private key (PEM) — held only for finalize step */
  privateKeyPem: string;
  /** A's ephemeral RSA public key (PEM) — sent to B in the apply response */
  publicKeyPem: string;
  /**
   * Opened by `POST /api/invite/redeem` (F-41) rather than by an admin: counted against the caps, and valid only while
   * the network still holds `under`, the invite-key hash it was redeemed with; `by` is the caller address.
   */
  redeemed?: { under: string; by: string };
  /** B's RSA public key — received during apply, used to encrypt the token for B */
  peerPublicKeyPem?: string;
  /** The PAT id A created for B — needed to link pending token to member record */
  tokenForPeerId?: string;
  /** B's instance info — stored at apply time, committed to config at finalize */
  pendingMember?: { instanceId: string; instanceLabel: string; instanceUrl: string };
  expiresAt: number; // epoch ms
  /** When set, this session is a braintree reparent, not a new join. The instanceId of the grandchild being re-parented. */
  reparentInstanceId?: string;
  /** When set, only this instanceId may apply the invite (optional pinning). */
  expectedInstanceId?: string;
}

const sessions = new Map<string, HandshakeSession>();

const digest = (id: string): string => crypto.createHash('sha256').update(id).digest('hex');

function purgeExpired(now = Date.now()): void {
  for (const [key, s] of sessions) if (s.expiresAt < now) sessions.delete(key);
}
setInterval(purgeExpired, 60 * 1000).unref();

/** Open a session for a fresh handshake id. Returns the internal key and the expiry. */
export async function openSession(
  handshakeId: string,
  fields: Omit<HandshakeSession, 'idHash' | 'idDigest' | 'expiresAt'>,
): Promise<{ sessionKey: string; expiresAt: number }> {
  const idHash = await bcrypt.hash(handshakeId, BCRYPT_ROUNDS);
  const sessionKey = uuidv4();
  const expiresAt = Date.now() + (fields.redeemed ? REDEEMED_TTL_MS : HANDSHAKE_TTL_MS);
  sessions.set(sessionKey, { ...fields, idHash, idDigest: digest(handshakeId), expiresAt });
  return { sessionKey, expiresAt };
}

/**
 * The live session for a plaintext handshake id, or null. `inviteKeyHashOf` answers the network's CURRENT invite-key
 * hash: a redeemed session whose key has since changed is dropped rather than answered. Required, so no caller can
 * look a session up without that check.
 */
export async function findSession(
  handshakeId: string,
  inviteKeyHashOf: (networkId: string) => string | undefined,
): Promise<[string, HandshakeSession] | null> {
  const want = digest(handshakeId);
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (s.idDigest !== want) continue;
    if (s.expiresAt < now) return null;
    if (!await bcrypt.compare(handshakeId, s.idHash)) return null;
    if (s.redeemed && inviteKeyHashOf(s.networkId) !== s.redeemed.under) { sessions.delete(key); return null; }
    return [key, s];
  }
  return null;
}

export function updateSession(sessionKey: string, s: HandshakeSession): void { sessions.set(sessionKey, s); }
export function dropSession(sessionKey: string): void { sessions.delete(sessionKey); }

/** Live redeemed sessions for `networkId`: all of them, and those opened by caller address `by`. */
export function redeemedOpen(networkId: string, by: string): { network: number; caller: number } {
  const now = Date.now();
  let network = 0, caller = 0;
  for (const s of sessions.values()) {
    if (!s.redeemed || s.networkId !== networkId || s.expiresAt <= now) continue;
    network += 1;
    if (s.redeemed.by === by) caller += 1;
  }
  return { network, caller };
}
