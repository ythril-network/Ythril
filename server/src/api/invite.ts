/**
 * Invite handshake API — zero-copy token exchange via RSA.
 *
 * Problem solved: adding a peer to a network currently requires manually copying
 * a PAT token out-of-band. This is error-prone and leaks plaintext credentials.
 *
 * Solution: an ephemeral RSA-OAEP handshake where each side encrypts the token
 * it generates for the other party using that party's public key. No token ever
 * travels in plaintext; the only things shared out-of-band are URLs and ephemeral
 * RSA public keys (neither is secret).
 *
 * Flow
 * ────
 * 1. Inviting instance A  POST /api/invite/generate   (authenticated)
 *    → Returns { handshakeId, inviteUrl, rsaPublicKeyPem, expiresAt }
 *    A's user shares (inviteUrl + rsaPublicKeyPem) with B's user however they like
 *    (Signal, email, a readable QR code — nothing sensitive).
 *
 * 2. Joining instance B   POST /api/invite/apply       (unauthenticated; handshakeId is the credential)
 *    → Body: { handshakeId, networkId, instanceId, instanceLabel, instanceUrl, rsaPublicKeyPem }
 *    A validates handshakeId, creates a PAT for B, encrypts with B's public key.
 *    Returns { encryptedTokenForB, rsaPublicKeyPem: A's pub key, instanceId: A's instanceId }
 *
 * 3. Joining instance B   POST /api/invite/finalize    (unauthenticated; handshakeId is the credential)
 *    → Body: { handshakeId, encryptedTokenForA }
 *    A decrypts B's token using A's private key, stores in secrets.peerTokens.
 *    Handshake complete — both sides can now sync.
 *
 * Security properties
 * ───────────────────
 * - RSA-4096-OAEP-SHA256: token payload is ~44 bytes, well within RSA-OAEP limits.
 * - Private keys are held in-memory only for ≤ 1 hour and discarded immediately after finalize.
 * - handshakeId is a random UUID; stored bcrypt-hashed to prevent timing attacks.
 * - Rate-limited to 5 req/min on apply/finalize (invite key validation attempts).
 * - A handshake session expires after 1 hour; any attempt after expiry is rejected.
 * - The PAT A creates for B is a standard scoped token — it can be revoked at any time.
 *
 * Route prefix: /api/invite
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { authRateLimit, globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { createToken } from '../auth/tokens.js';
import { log } from '../util/log.js';
import { isSsrfSafeUrl, SSRF_SAFE_MESSAGE } from '../util/ssrf.js';
import type { NetworkMember } from '../config/types.js';

export const inviteRouter = Router();

const BCRYPT_ROUNDS = 12;
const HANDSHAKE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── In-memory handshake store ────────────────────────────────────────────────
// Sessions are ephemeral: private keys must never be persisted to disk.

interface HandshakeSession {
  /** bcrypt hash of the plaintext handshakeId */
  idHash: string;
  networkId: string;
  /** A's ephemeral RSA private key (PEM) — held only for finalize step */
  privateKeyPem: string;
  /** A's ephemeral RSA public key (PEM) — sent to B in the apply response */
  publicKeyPem: string;
  /** B's RSA public key — received during apply, used to encrypt the token for B */
  peerPublicKeyPem?: string;
  /** The PAT id A created for B — needed to link pending token to member record */
  tokenForPeerId?: string;
  /** B's instance info — stored at apply time, committed to config at finalize */
  pendingMember?: {
    instanceId: string;
    instanceLabel: string;
    instanceUrl: string;
  };
  expiresAt: number; // epoch ms
  /** When set, this session is a braintree reparent, not a new join.
   *  The instanceId of the grandchild being temporarily re-parented. */
  reparentInstanceId?: string;
}

const _sessions = new Map<string, HandshakeSession>();

/** Purge expired sessions (run periodically) */
function purgeExpired(): void {
  const now = Date.now();
  for (const [key, session] of _sessions) {
    if (session.expiresAt < now) {
      _sessions.delete(key);
    }
  }
}
setInterval(purgeExpired, 5 * 60 * 1000).unref();

// ── Schemas ──────────────────────────────────────────────────────────────────

const GenerateBody = z.object({
  networkId: z.string().uuid(),
  /** When set, this invite is a braintree reparent — not a new join.
   *  The target must already be a member whose parent is offline. */
  reparentInstanceId: z.string().uuid().optional(),
});

const INVITE_SSRF_SAFE_URL = z.string().url().refine(isSsrfSafeUrl, { message: SSRF_SAFE_MESSAGE });

const ApplyBody = z.object({
  handshakeId: z.string().uuid(),
  networkId: z.string().uuid(),
  instanceId: z.string().uuid(),
  instanceLabel: z.string().min(1).max(200),
  instanceUrl: INVITE_SSRF_SAFE_URL,
  rsaPublicKeyPem: z.string().min(100),
});

const FinalizeBody = z.object({
  handshakeId: z.string().uuid(),
  /** B's PAT for A, RSA-OAEP encrypted with A's public key, base64-encoded */
  encryptedTokenForA: z.string().min(1),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encrypt a short string (token) with an RSA public key using OAEP-SHA256 */
function rsaEncrypt(plaintext: string, publicKeyPem: string): string {
  const buf = Buffer.from(plaintext, 'utf8');
  const encrypted = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    buf,
  );
  return encrypted.toString('base64');
}

/** Decrypt with an RSA private key using OAEP-SHA256 */
function rsaDecrypt(cipherBase64: string, privateKeyPem: string): string {
  const buf = Buffer.from(cipherBase64, 'base64');
  const decrypted = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    buf,
  );
  return decrypted.toString('utf8');
}

/** Look up a session by plaintext handshakeId (constant-time bcrypt compare) */
async function findSession(handshakeId: string): Promise<[string, HandshakeSession] | null> {
  for (const [key, session] of _sessions) {
    if (session.expiresAt < Date.now()) continue;
    const match = await bcrypt.compare(handshakeId, session.idHash);
    if (match) return [key, session];
  }
  return null;
}

// ── POST /api/invite/generate ─────────────────────────────────────────────────
// Authenticated members generate an invite handshake session for a network.

// Restricted to admin tokens: generating an invite auto-creates a full-access
// peer PAT for the joining instance (scoped to the network's spaces). Allowing
// non-admin or read-only tokens to trigger this would be a privilege escalation.
inviteRouter.post('/generate', globalRateLimit, requireAdmin, async (req, res) => {
  const parsed = GenerateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { networkId, reparentInstanceId } = parsed.data;
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

  if (reparentInstanceId) {
    if (net.type !== 'braintree') {
      res.status(400).json({ error: 'reparentInstanceId is only valid for braintree networks' });
      return;
    }
    const target = net.members.find(m => m.instanceId === reparentInstanceId);
    if (!target) {
      res.status(404).json({ error: 'reparentInstanceId is not a member of this network' });
      return;
    }
    if ((target.consecutiveFailures ?? 0) < 10) {
      // Warn but don't block — admin may want to reparent proactively
      log.warn(`Reparent invite generated for '${target.label}' whose parent does not yet appear offline (${target.consecutiveFailures ?? 0} consecutive failures)`);
    }
  }

  // Generate ephemeral RSA-4096 key pair (OAEP safe for ~470-byte payloads; our PATs are ~44 bytes)
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const handshakeId = uuidv4();
  const idHash = await bcrypt.hash(handshakeId, BCRYPT_ROUNDS);
  const sessionKey = uuidv4(); // internal map key
  const expiresAt = Date.now() + HANDSHAKE_TTL_MS;

  _sessions.set(sessionKey, {
    idHash,
    networkId,
    privateKeyPem: privateKey as string,
    publicKeyPem: publicKey as string,
    expiresAt,
    reparentInstanceId,
  });

  log.info(`Invite handshake generated for network ${networkId} (session ${sessionKey})${
    reparentInstanceId ? ` [reparent target: ${reparentInstanceId}]` : ''
  }`);

  // Use the operator-configured publicUrl when available to prevent Host header
  // injection (a crafted Host header could point the inviteUrl at an attacker's server).
  const baseUrl = (cfg.publicUrl ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.status(201).json({
    handshakeId,
    networkId,
    inviteUrl: `${baseUrl}/api/invite/apply`,
    rsaPublicKeyPem: publicKey,
    expiresAt: new Date(expiresAt).toISOString(),
    spaces: net.spaces,
  });
});

// ── POST /api/invite/apply ─────────────────────────────────────────────────────
// Called by the joining instance. Not authenticated — handshakeId is the credential.

inviteRouter.post('/apply', authRateLimit, async (req, res) => {
  const parsed = ApplyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { handshakeId, networkId, instanceId, instanceLabel, instanceUrl, rsaPublicKeyPem } = parsed.data;

  const found = await findSession(handshakeId);
  if (!found) { res.status(401).json({ error: 'Invalid or expired handshake ID' }); return; }
  const [sessionKey, session] = found;

  // Prevent replay: each handshake session can only be applied once
  if (session.peerPublicKeyPem) {
    res.status(409).json({ error: 'Handshake already applied — each invite link is single-use' });
    return;
  }

  if (session.networkId !== networkId) {
    res.status(400).json({ error: 'Network ID does not match invite' });
    return;
  }

  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

  // Ensure the joining instance is not already a member — unless this is a reparent session
  // targeting exactly that instance (the grandchild re-applying under a new parent).
  if (net.members.some(m => m.instanceId === instanceId)) {
    if (!session.reparentInstanceId || session.reparentInstanceId !== instanceId) {
      res.status(409).json({ error: 'Instance is already a member of this network' });
      return;
    }
  }

  // Validate the peer's RSA public key is parseable and exactly 4096-bit
  let peerKey: crypto.KeyObject;
  try {
    peerKey = crypto.createPublicKey(rsaPublicKeyPem);
  } catch {
    res.status(400).json({ error: 'Invalid rsaPublicKeyPem' });
    return;
  }
  if (peerKey.asymmetricKeyType !== 'rsa' || (peerKey.asymmetricKeyDetails as { modulusLength?: number })?.modulusLength !== 4096) {
    res.status(400).json({ error: 'RSA public key must be exactly 4096-bit' });
    return;
  }

  // Create a PAT that B will use to authenticate inbound requests to A
  const { record, plaintext: tokenForB } = await createToken({
    name: `peer:${instanceLabel} (handshake)`,
    expiresAt: null,
    spaces: net.spaces, // scoped to only the network's spaces
    peerInstanceId: instanceId, // link this PAT to the peer that will present it
  });

  // Encrypt the token with B's public key — only B can decrypt it
  const encryptedTokenForB = rsaEncrypt(tokenForB, rsaPublicKeyPem);

  // Store B's public key and pending member data so finalize can complete the registration
  session.peerPublicKeyPem = rsaPublicKeyPem;
  session.tokenForPeerId = record.id;
  session.pendingMember = { instanceId, instanceLabel, instanceUrl };
  _sessions.set(sessionKey, session);

  log.info(`Invite apply from ${instanceLabel} (${instanceId}) for network ${networkId}`);

  res.json({
    encryptedTokenForB,
    rsaPublicKeyPem: session.publicKeyPem,
    instanceId: cfg.instanceId,
    instanceLabel: cfg.instanceLabel,
    networkId,
    networkLabel: net.label,
    networkType: net.type,
    spaces: net.spaces,
  });
});

// ── POST /api/invite/finalize ─────────────────────────────────────────────────
// Called by the joining instance after it has decrypted its token and generated one for A.

inviteRouter.post('/finalize', authRateLimit, async (req, res) => {
  const parsed = FinalizeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { handshakeId, encryptedTokenForA } = parsed.data;

  const found = await findSession(handshakeId);
  if (!found) { res.status(401).json({ error: 'Invalid or expired handshake ID' }); return; }
  const [sessionKey, session] = found;

  if (!session.pendingMember || !session.peerPublicKeyPem || !session.tokenForPeerId) {
    res.status(400).json({ error: 'Handshake not in apply state — call /apply first' });
    return;
  }

  // Decrypt B's token using A's private key
  let peerToken: string;
  try {
    peerToken = rsaDecrypt(encryptedTokenForA, session.privateKeyPem);
  } catch {
    res.status(400).json({ error: 'Failed to decrypt encryptedTokenForA — wrong key or corrupt payload' });
    return;
  }

  if (!peerToken.startsWith('ythril_')) {
    res.status(400).json({ error: 'Decrypted token has unexpected format' });
    return;
  }

  const { instanceId, instanceLabel, instanceUrl } = session.pendingMember;

  // Commit to config
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === session.networkId);
  if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

  // Hash B's token for inbound validation (stored in member record)
  const tokenHash = await bcrypt.hash(peerToken, BCRYPT_ROUNDS);

  // Store A's outbound token for B (the one B generated for A to use)
  const secrets = getSecrets();
  secrets.peerTokens[instanceId] = peerToken;
  saveSecrets(secrets);

  let responseStatus: 'joined' | 'reparented';

  if (session.reparentInstanceId) {
    // ── Reparent path ───────────────────────────────────────────────────────
    // Update the existing member record instead of creating a new one.
    const target = net.members.find(m => m.instanceId === session.reparentInstanceId);
    if (!target) {
      res.status(400).json({ error: 'Reparent target member not found — was it removed?' });
      return;
    }

    // Remove from old parent's children array
    if (target.parentInstanceId) {
      const oldParent = net.members.find(m => m.instanceId === target.parentInstanceId);
      if (oldParent?.children) {
        oldParent.children = oldParent.children.filter(c => c !== session.reparentInstanceId);
      }
    }

    // Save old parent before overwriting, set new parent to this instance
    target.originalParentInstanceId = target.parentInstanceId;
    target.parentInstanceId = cfg.instanceId;
    target.tokenHash = tokenHash;
    target.consecutiveFailures = 0;
    target.lastSeqReceived ??= {};

    // Add to this instance's children array
    const selfInNet = net.members.find(m => m.instanceId === cfg.instanceId);
    if (selfInNet?.children && !selfInNet.children.includes(session.reparentInstanceId)) {
      selfInNet.children.push(session.reparentInstanceId);
    }

    log.info(`Reparent handshake complete: '${instanceLabel}' (${instanceId}) temporarily re-parented to this instance in network ${session.networkId}`);
    responseStatus = 'reparented';
  } else {
    // ── Normal join path ────────────────────────────────────────────────────
    const newMember: NetworkMember = {
      instanceId,
      label: instanceLabel,
      url: instanceUrl,
      tokenHash,
      direction: (net.type === 'braintree' || net.type === 'pubsub') ? 'push' : 'both',
      lastSyncAt: undefined,
      lastSeqReceived: {},
      children: net.type === 'braintree' ? [] : undefined,
    };
    net.members.push(newMember);
    log.info(`Invite handshake complete: ${instanceLabel} (${instanceId}) joined network ${session.networkId}`);
    responseStatus = 'joined';
  }

  saveConfig(cfg);

  // Discard the session — private key is no longer needed
  _sessions.delete(sessionKey);

  res.json({ status: responseStatus, instanceId, networkId: session.networkId, temporary: session.reparentInstanceId != null });
});

// ── GET /api/invite/status/:handshakeId ───────────────────────────────────────
// Allows the joining side to poll whether the handshake was completed.

inviteRouter.get('/status/:handshakeId', authRateLimit, async (req, res) => {
  const handshakeId = req.params['handshakeId'] as string;
  if (!handshakeId || handshakeId.length < 10) {
    res.status(400).json({ error: 'Invalid handshakeId' });
    return;
  }

  const found = await findSession(handshakeId);
  if (!found) {
    // Could be expired, completed (deleted), or never existed — all map to 404
    res.status(404).json({ status: 'not_found' });
    return;
  }
  const [, session] = found;

  res.json({
    status: session.pendingMember ? 'applied' : 'pending',
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
});
