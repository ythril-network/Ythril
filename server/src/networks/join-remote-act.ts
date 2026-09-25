/**
 * Joining a REMOTE network — the invite handshake, run server-side for the joining instance — once, for both doors
 * (`F-36`, slice 4). `POST /api/networks/join-remote` and MCP `network_join_remote` both call it, so the Networks
 * rung checked between apply and finalize (`networkJoinRefusal`, F-34.1) is one check and not two.
 *
 * Flow:
 *   1. Brain A admin clicks "Generate invite" → calls POST /api/invite/generate
 *      → gets { handshakeId, inviteUrl, rsaPublicKeyPem, networkId, expiresAt }
 *   2. Brain A admin sends that bundle to Brain B admin (out-of-band)
 *   3. Brain B's operator — or an agent over MCP — hands the bundle and B's own URL to this act
 *   4. This act executes the RSA handshake against Brain A on behalf of Brain B
 *   5. Both sides end up with tokens for each other; network registered locally on Brain B.
 *
 * No plaintext token reaches the caller on either door: the one A made for B arrives RSA-wrapped and goes to
 * secrets, and the one B makes for A leaves RSA-wrapped.
 */
import { boundedJson } from '../util/bounded-read.js';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { networkJoinRefusal } from '../auth/network-rights.js';
import { recordOrigin } from '../auth/network-membership.js';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../config/loader.js';
import { createToken, revokeToken } from '../auth/tokens.js';
import { peerTokenSpaces } from '../auth/peer-token-scope.js';
import { createSpace } from '../spaces/lifecycle.js';
import { log } from '../util/log.js';
import type { NetworkConfig } from '../config/types.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { BCRYPT_ROUNDS, SSRF_SAFE_URL } from '../api/networks/_shared.js';
import type { NetworkActResult } from './network-acts.js';
import { widenPeerTokensOf } from './network-spaces.js';

type Caller = Parameters<typeof networkJoinRefusal>[0] & { id?: string };

export const JoinRemoteBody = z.object({
  /** handshakeId returned by Brain A's POST /api/invite/generate */
  handshakeId: z.string().uuid(),
  /**
   * inviteUrl returned by Brain A's POST /api/invite/generate (= Brain A's /api/invite/apply URL).
   *
   * `SSRF_SAFE_URL`, not a local chain. It had its own — parse + SSRF, no SCHEME check — which meant an
   * instance with `allowInsecurePeers` off would still open a plaintext handshake to an `http://` inviter,
   * against a setting documented as *"peer URLs must be `https://`, regardless of address"*. The token comes
   * back RSA-wrapped, so nothing secret crossed in the clear, but the instance ids, labels, network id and
   * public key did — and the operator heard about it from a once-per-host log line after the fact instead of
   * a refusal before it.
   */
  inviteUrl: SSRF_SAFE_URL,
  /** RSA public key PEM returned by Brain A's POST /api/invite/generate */
  rsaPublicKeyPem: z.string().min(100),
  /** Network ID from Brain A's invite bundle */
  networkId: z.string().uuid(),
  /**
   * This brain's externally reachable base URL (e.g. https://brain-b.example.com).
   *
   * Also `SSRF_SAFE_URL`. It used to be a bare `.url()` — no SSRF check and no scheme check — and the
   * inviter validates it with the full chain, so a plaintext or loopback value surfaced as a remote `400`
   * where a local one belonged.
   */
  myUrl: SSRF_SAFE_URL,
  /** expiresAt from invite bundle — informational only */
  expiresAt: z.string().optional(),
  /** Optional space aliasing: maps remote space IDs to desired local space IDs.
   *  When the UI detects a collision, the user can choose a different local ID.
   *  Any remote IDs not present in this map will keep their original ID. */
  spaceMap: z.record(z.string(), z.string().min(1).max(40).regex(/^[a-z0-9-]+$/)).optional(),
});

/** The inviter refused a step: relay its status and body as they came, with its own sentence for MCP. */
async function relay(r: Response): Promise<NetworkActResult> {
  const upstream = await boundedJson<unknown>(r, 'network peer').catch(() => ({}));
  const said = (upstream as { error?: unknown } | null)?.error;
  return { status: r.status, error: typeof said === 'string' ? said : `the inviting instance answered ${r.status}`, upstream };
}

export async function joinRemoteAct(caller: Caller, input: unknown): Promise<NetworkActResult> {
  const parsed = JoinRemoteBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };

  // `rsaPublicKeyPem` is validated by JoinRemoteBody but not needed here — Brain A's key is read
  // back from the apply response below, so it is deliberately not destructured.
  const { handshakeId, inviteUrl, networkId, myUrl, spaceMap: requestedSpaceMap } = parsed.data;
  const cfg = getConfig();

  // ── Step A: apply — call Brain A's /api/invite/apply ──────────────────────
  const { generateKeyPairSync, privateDecrypt, publicEncrypt, constants: C } =
    await import('node:crypto');

  const { privateKey: bPrivKeyPem, publicKey: bPubKeyPem } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  let applyRes: Response;
  try {
    applyRes = await peerSafeFetch(inviteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handshakeId,
        networkId,
        instanceId: cfg.instanceId,
        instanceLabel: cfg.instanceLabel,
        instanceUrl: myUrl,
        rsaPublicKeyPem: bPubKeyPem,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.warn(`join-remote: could not reach ${inviteUrl}: ${err}`);
    return { status: 502, error: `Could not reach inviting brain: ${err}` };
  }

  if (!applyRes.ok) {
    return relay(applyRes);
  }

  const applyData = await boundedJson<{
    encryptedTokenForB: string;
    rsaPublicKeyPem: string;
    instanceId: string;
    instanceLabel: string;
    networkId: string;
    networkLabel: string;
    networkType: string;
    spaces: string[];
  }>(applyRes, 'network peer');

  // Decrypt tokenForB — the PAT Brain A created on its own server for Brain B to use
  let tokenForB: string;
  try {
    tokenForB = privateDecrypt(
      { key: bPrivKeyPem, padding: C.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(applyData.encryptedTokenForB, 'base64'),
    ).toString('utf8');
  } catch {
    return { status: 400, error: 'Failed to decrypt token from inviting brain' };
  }
  if (!tokenForB.startsWith('ythril_')) {
    return { status: 400, error: 'Decrypted token has unexpected format' };
  }

  // Create a PAT in this brain's token store scoped to network spaces.
  // Brain A will present this token when calling THIS brain's sync endpoints.
  const remoteSpaceIds: string[] = applyData.spaces ?? [];
  const existingSpaces: string[] = [];
  const createdSpaces: string[] = [];
  const spaceMap: Record<string, string> = {};

  // F-34.1: which local spaces this join would touch — before ANY local write. Refused here, nothing was created
  // and finalize is never called, so the inviter's token for us expires with the handshake.
  const localOf = (remoteId: string) => requestedSpaceMap?.[remoteId] ?? remoteId;
  const joinRefusal = networkJoinRefusal(caller, {
    existing: remoteSpaceIds.map(localOf).filter(id => cfg.spaces.some(cs => cs.id === id)),
    toCreate: remoteSpaceIds.map(localOf).filter(id => !cfg.spaces.some(cs => cs.id === id)),
  });
  if (joinRefusal) return { status: 403, error: joinRefusal };

  for (const remoteId of remoteSpaceIds) {
    // Check if the user chose a different local ID for this remote space
    const localId = requestedSpaceMap?.[remoteId] ?? remoteId;

    if (localId !== remoteId) {
      // Record the alias — sync engine will use this to translate peer space IDs
      spaceMap[remoteId] = localId;
    }

    if (cfg.spaces.some(cs => cs.id === localId)) {
      existingSpaces.push(localId);
    } else {
      // Auto-create missing spaces so sync has valid targets.
      // Label is capitalised version of the slug (e.g. "test" → "Test").
      try {
        await createSpace({ id: localId, label: localId.charAt(0).toUpperCase() + localId.slice(1) });
        createdSpaces.push(localId);
        log.info(`join-remote: auto-created space '${localId}'${localId !== remoteId ? ` (alias for remote '${remoteId}')` : ''} for network ${networkId}`);
      } catch (err) {
        return { status: 500, error: `Failed to create space '${localId}': ${err}` };
      }
    }
  }

  // All remote spaces now have local counterparts — scope token to local IDs.
  const allNetworkSpaces = [...existingSpaces, ...createdSpaces];
  const { record: tokenForARecord, plaintext: tokenForAPlaintext } = await createToken({
    name: `peer:${applyData.instanceLabel ?? 'remote'}`,
    expiresAt: null,
    // Every network the pair shares, not this one alone: the inviter keeps one token for us and this one replaces it.
    spaces: peerTokenSpaces(applyData.instanceId, allNetworkSpaces),
    peerInstanceId: applyData.instanceId, // link this PAT to the peer that will present it
  });

  // ── Step B: finalize — send Brain A an encrypted token for it to call us ──
  const encryptedTokenForA = publicEncrypt(
    { key: applyData.rsaPublicKeyPem, padding: C.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(tokenForAPlaintext, 'utf8'),
  ).toString('base64');

  const finalizeUrl = inviteUrl.replace(/\/apply$/, '/finalize');
  let finalizeRes: Response;
  try {
    finalizeRes = await peerSafeFetch(finalizeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handshakeId, encryptedTokenForA }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    await revokeToken(tokenForARecord.id);
    return { status: 502, error: `Could not finalize with inviting brain: ${err}` };
  }

  if (!finalizeRes.ok) {
    await revokeToken(tokenForARecord.id);
    return relay(finalizeRes);
  }

  const finalizeData = await boundedJson<{ status: string }>(finalizeRes, 'network peer');

  // ── Register network and peer locally ────────────────────────────────────
  // Store tokenForB so this brain can call Brain A's sync endpoints.
  const secrets = getSecrets();
  secrets.peerTokens[applyData.instanceId] = tokenForB;
  saveSecrets(secrets);

  // Hashed BEFORE the network is looked up, and that order is the point.
  //
  // It used to happen inside the `if` below, between binding `net` out of `freshCfg.networks` and pushing
  // the member onto it. `getConfig()` survives a reload — the loader mutates the top-level object in
  // place — but a NESTED reference does not: the arrays are replaced wholesale, so `net` would be left
  // pointing at the previous array's object. The push would land on that detached object and
  // `saveConfig(freshCfg)` would write the CURRENT config, which does not contain it.
  //
  // The result was a join that answered success while the peer was never recorded as a member. The window
  // is a bcrypt hash, and two sync routes a peer can call (`/sync/members`, `/sync/votes`) reload the
  // config on every request — so a peer casting a vote during another peer's join could erase it.
  //
  // No mutateConfig here on purpose: the branch below may CREATE the network and push it onto `freshCfg`,
  // and a re-read would discard that. Removing the await from the window is the smaller, safer fix.
  const tokenForAHash = await bcrypt.hash(tokenForAPlaintext, BCRYPT_ROUNDS);

  // Reload config to get fresh state (apply may have taken a few seconds)
  const freshCfg = getConfig();
  let net = freshCfg.networks.find(n => n.id === networkId);
  if (!net) {
    net = {
      id: networkId,
      label: applyData.networkLabel ?? 'Remote network',
      type: (applyData.networkType as NetworkConfig['type']) ?? 'closed',
      spaces: allNetworkSpaces,
      ...(Object.keys(spaceMap).length > 0 ? { spaceMap } : {}),
      votingDeadlineHours: 24,
      members: [],
      pendingRounds: [],
      createdAt: new Date().toISOString(),
      myParentInstanceId: applyData.networkType === 'braintree' ? applyData.instanceId : undefined,
      origin: 'joined',
    };
    freshCfg.networks.push(net);
  }
  // Who established each membership, so the leave rule can tell this token's own from another's.
  const joiner = caller.id;
  if (joiner) for (const s of allNetworkSpaces) if (!net.spaceOrigins?.[s]) net.spaceOrigins = recordOrigin(net.spaceOrigins, s, joiner);

  if (!net.members.some(m => m.instanceId === applyData.instanceId)) {
    net.members.push({
      instanceId: applyData.instanceId,
      label: applyData.instanceLabel ?? 'remote',
      url: new URL(inviteUrl).origin,
      tokenHash: tokenForAHash,
      direction: applyData.networkType === 'pubsub' ? 'pull'
               : applyData.networkType === 'braintree' ? 'pull'
               : 'both',
      lastSeqReceived: {},
    });
  }

  // Q-53, the joiner's half: every token kept for the inviter reaches this network's spaces, so a second handshake
  // with the same inviter racing this one cannot leave the token the inviter keeps without them.
  widenPeerTokensOf(freshCfg, [applyData.instanceId], allNetworkSpaces);
  saveConfig(freshCfg);
  log.info(`join-remote: joined '${applyData.networkLabel}' (${networkId}) via RSA handshake`);

  return { status: 200, body: {
    status: finalizeData.status ?? 'joined',
    networkId,
    networkLabel: applyData.networkLabel,
    networkType: applyData.networkType,
    spaces: allNetworkSpaces,
    existingSpaces,
    createdSpaces,
    ...(Object.keys(spaceMap).length > 0 ? { spaceMap } : {}),
    instanceId: applyData.instanceId,
    instanceLabel: applyData.instanceLabel,
  } };
}
