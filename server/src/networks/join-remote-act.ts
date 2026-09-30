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
import { createToken, revokeToken, adoptPeerToken } from '../auth/tokens.js';
import { peerTokenSpaces } from '../auth/peer-token-scope.js';
import { createSpace } from '../spaces/lifecycle.js';
import { log } from '../util/log.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { mergePeerRoster } from './member-introductions.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { BCRYPT_ROUNDS, SSRF_SAFE_URL } from '../api/networks/_shared.js';
import type { NetworkActResult } from './network-acts.js';
import { widenPeerTokensOf } from './network-spaces.js';
import { inviterIsWhoItClaims, knownPeerAt } from '../auth/peer-identity.js';
import { resolveJoinSpaces } from './join-spaces.js';
import { recordSpaceAlias } from '../sync/space-map.js';
import { joinedSyncSchedule, syncScheduleRefusal } from '../sync/schedule.js';
import { scheduleSyncForNetwork } from '../sync/scheduler.js';
import { MAX_SPACE_IDS } from '../util/request-bounds.js';

/** How long the token minted for the inviter lives before the handshake completes and `adoptPeerToken` lifts it. */
const JOIN_TOKEN_TTL_MS = 10 * 60_000;

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
  /**
   * The rest of the invite bundle, informational only, so it can be passed whole on either door (Q-133). The join
   * reads the inviter's own apply answer for the spaces, never these — a bundle is not signed.
   */
  spaces: z.array(z.string()).max(MAX_SPACE_IDS).optional(),
  networkSpaces: z.array(z.string()).max(MAX_SPACE_IDS).optional(),
  inviteCode: z.string().max(8192).optional(),
  /**
   * The schedule this instance syncs the joined network on (Q-137). Wins over the inviter's; `''` is manual on purpose;
   * absent adopts the inviter's, or `DEFAULT_JOIN_SYNC_SCHEDULE`. Checked by `syncScheduleRefusal` like create's.
   */
  syncSchedule: z.string().max(200).optional(),
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
  const { handshakeId, inviteUrl, networkId, myUrl, spaceMap: requestedSpaceMap, syncSchedule: statedSchedule } = parsed.data;
  // Before any call to the inviter: a schedule the scheduler cannot run is refused with the sentence create and update
  // give, so a refused join leaves nothing behind (Q-137).
  const scheduleRefusal = syncScheduleRefusal(statedSchedule);
  if (scheduleRefusal) return { status: 400, error: scheduleRefusal };
  const cfg = getConfig();

  // ── Step A: apply — call Brain A's /api/invite/apply ──────────────────────
  const { generateKeyPairSync, privateDecrypt, publicEncrypt, constants: C } =
    await import('node:crypto');

  const { privateKey: bPrivKeyPem, publicKey: bPubKeyPem } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // S-6: when the inviter is a peer this instance already knows, present the token it issued to us, so the inviter can
  // tell this is the genuine peer joining a second network and not someone claiming its id.
  const knownInviter = knownPeerAt(cfg, inviteUrl);
  const proof = knownInviter ? getSecrets().peerTokens[knownInviter] : undefined;
  let applyRes: Response;
  try {
    applyRes = await peerSafeFetch(inviteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(proof ? { Authorization: `Bearer ${proof}` } : {}) },
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
    /** Q-133: the network's id for each of `spaces`, index-aligned. Absent from an older inviter. */
    networkSpaces?: unknown;
    /** Q-137: the inviter's own schedule, an offer validated by `joinedSyncSchedule`. Absent when it syncs manually. */
    syncSchedule?: unknown;
  }>(applyRes, 'network peer');

  // S-6: the inviter's id is its own claim. A peer this instance already knows must be answering from the origin it
  // is recorded at — otherwise another server is borrowing its id, and a token scoped by it would reach that peer's
  // networks here and overwrite the one this instance keeps for it. Refused before anything is written.
  if (!inviterIsWhoItClaims(cfg, applyData.instanceId, inviteUrl)) {
    return { status: 403, error: `The inviter claims the instance id of a peer this instance reaches at another address (${applyData.instanceId}); refused` };
  }

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
  /*
   * Q-133: which local space each network space lands on, decided ONCE (`join-spaces.ts`), before any write. The
   * network id and this instance's name for the space are two things once a publisher has renamed it; the rights
   * check below and the creation loop both read these entries, so they cannot check one set and create another.
   */
  const existingNet = cfg.networks.find(n => n.id === networkId);
  const resolved = resolveJoinSpaces(applyData, requestedSpaceMap, existingNet, cfg.spaces.map(s => s.id));
  if (!resolved.ok) return { status: 400, error: resolved.error, code: resolved.code };
  // A network this instance already carries merges the new spaces only when the answer names them by the network's
  // ids; an older inviter's local names would add the wrong ids, so that path keeps its old behaviour (adds nothing).
  // A space the operator dismissed stays out.
  const entries = resolved.entries.filter(e => !existingNet
    || (resolved.networkIdsTrusted && !existingNet.dismissedSpaces?.includes(e.networkId)));
  const existingSpaces: string[] = [];
  const createdSpaces: string[] = [];
  // Through the one alias writer, before anything is written: the resolver already refused every pair it could not
  // record, so a refusal here is a disagreement between the two, and the join stops rather than guessing.
  const aliases: { spaceMap?: Record<string, string> } = {};
  for (const { networkId: remoteId, localId } of entries) {
    const why = localId === remoteId ? null : recordSpaceAlias(aliases, remoteId, localId);
    if (why) return { status: 400, error: `The join could not record the space mapping: ${why}.`, code: 'join_mapping_collision' };
  }
  const spaceMap = aliases.spaceMap ?? {};

  // F-34.1: which local spaces this join would touch — before ANY local write. Refused here, nothing was created
  // and finalize is never called, so the inviter's token for us expires with the handshake.
  const joinRefusal = networkJoinRefusal(caller, {
    existing: entries.map(e => e.localId).filter(id => cfg.spaces.some(cs => cs.id === id)),
    toCreate: entries.map(e => e.localId).filter(id => !cfg.spaces.some(cs => cs.id === id)),
  });
  if (joinRefusal) return { status: 403, error: joinRefusal };

  for (const { networkId: remoteId, localId } of entries) {
    if (cfg.spaces.some(cs => cs.id === localId)) {
      existingSpaces.push(localId);
    } else {
      // Auto-create missing spaces so sync has valid targets.
      // Label is capitalised version of the slug (e.g. "test" → "Test").
      try {
        // Credited to the joining token, which then administers what the join created (Q-134).
        await createSpace({ id: localId, label: localId.charAt(0).toUpperCase() + localId.slice(1) }, { tokenId: caller.id ?? null });
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
    // Expires until the handshake completes, when `adoptPeerToken` lifts it (Q-163): a token in flight must be told
    // apart from a live one, or adopting a second join's token would revoke this one before the inviter holds it.
    expiresAt: new Date(Date.now() + JOIN_TOKEN_TTL_MS).toISOString(),
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

  const finalizeData = await boundedJson<{ status: string; members?: Partial<NetworkMember>[] }>(finalizeRes, 'network peer');

  // ── Register network and peer locally ────────────────────────────────────
  // Store tokenForB so this brain can call Brain A's sync endpoints.
  const secrets = getSecrets();
  secrets.peerTokens[applyData.instanceId] = tokenForB;
  saveSecrets(secrets);
  // The inviter holds this token now, and it replaces every one an earlier join gave the same instance (Q-163).
  await adoptPeerToken(tokenForARecord.id);

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
  // Only a network this join CREATES gets a schedule here; one this instance already carries keeps its own.
  let armSchedule: string | undefined;
  if (!net) {
    const schedule = joinedSyncSchedule(statedSchedule, applyData.syncSchedule);
    // Stored even when `''`: manual chosen at the join must not read as never stated at the next boot.
    armSchedule = schedule;
    net = {
      syncSchedule: schedule,
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
  } else {
    // Q-133: a join into a network this instance already carries MERGES the spaces it resolved, through the one alias
    // writer, instead of leaving them created but outside the network. `entries` is empty for an older inviter.
    for (const s of allNetworkSpaces) if (!net.spaces.includes(s)) net.spaces.push(s);
    for (const [remote, local] of Object.entries(spaceMap)) {
      const why = recordSpaceAlias(net, remote, local);
      if (why) log.warn(`join-remote: network ${networkId}: alias '${remote}' -> '${local}' not recorded: ${why}`);
    }
  }
  // Who established each membership, so the leave rule can tell this token's own from another's.
  const joiner = caller.id;
  if (joiner) for (const s of allNetworkSpaces) if (!net.spaceOrigins?.[s]) net.spaceOrigins = recordOrigin(net.spaceOrigins, s, joiner);
  // And who joined the network itself (S-9): the authority for what a later announcement may add here.
  if (joiner) net.joinedBy ??= joiner;

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
  // Q-154: who admitted this instance, so a voted network trusts that member's roster and no other one's.
  net.admittedVia ??= applyData.instanceId;
  // Q-135: on a club the inviter's roster introduces every other member, so pairing starts on the first cycle.
  if (Array.isArray(finalizeData.members)) {
    mergePeerRoster(net, freshCfg.instanceId, applyData.instanceId, finalizeData.members, []);
  }

  // Q-53, the joiner's half: every token kept for the inviter reaches this network's spaces, so a second handshake
  // with the same inviter racing this one cannot leave the token the inviter keeps without them.
  widenPeerTokensOf(freshCfg, [applyData.instanceId], allNetworkSpaces);
  saveConfig(freshCfg);
  if (armSchedule) scheduleSyncForNetwork(networkId, armSchedule);
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

export const JoinByKeyBody = z.object({
  /** The publisher's base URL, as the invite gives it (e.g. `https://ythril.example.com`). */
  publisherUrl: SSRF_SAFE_URL,
  /** The pub/sub network's published invite key (`ythril_invite_…`). */
  inviteKey: z.string().min(20).max(200),
  /** This brain's externally reachable base URL, as for `join-remote`. */
  myUrl: SSRF_SAFE_URL,
  /** Optional space aliasing, as for `join-remote`. */
  spaceMap: z.record(z.string(), z.string().min(1).max(40).regex(/^[a-z0-9-]+$/)).optional(),
  /** The joiner's schedule, as for `join-remote` (Q-137). */
  syncSchedule: z.string().max(200).optional(),
}).strict();

/**
 * Join a pub/sub network with nothing but its publisher's URL and its published invite key (F-41).
 *
 * Owner, 2026-09-26: *"the invite by the publisher must be there ready to paste in join network. no admission in
 * pubsub necessary."* The publisher's `POST /api/invite/redeem` turns the key into a handshake session, and the rest
 * is `joinRemoteAct` — so the joining token's rights decide which spaces the join maps or creates (S-9), exactly as
 * for an invite an admin generated.
 */
export async function joinByInviteKeyAct(caller: Caller, input: unknown): Promise<NetworkActResult> {
  const parsed = JoinByKeyBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const { publisherUrl, inviteKey, myUrl, spaceMap, syncSchedule } = parsed.data;
  // Refused before the key is redeemed, so a bad schedule does not spend a handshake (Q-137).
  const scheduleRefusal = syncScheduleRefusal(syncSchedule);
  if (scheduleRefusal) return { status: 400, error: scheduleRefusal };
  const redeemUrl = `${new URL(publisherUrl).origin}/api/invite/redeem`;
  let r: Response;
  try {
    r = await peerSafeFetch(redeemUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteKey }), signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    log.warn(`join-by-key: could not reach ${redeemUrl}: ${err}`);
    return { status: 502, error: `Could not reach the publisher: ${err}` };
  }
  if (!r.ok) return relay(r);
  const bundle = await boundedJson<{ handshakeId?: string; inviteUrl?: string; rsaPublicKeyPem?: string; networkId?: string }>(r, 'invite redeem')
    .catch(() => ({} as Record<string, never>));
  if (!bundle.handshakeId || !bundle.inviteUrl || !bundle.rsaPublicKeyPem || !bundle.networkId) {
    return { status: 502, error: 'The publisher answered the key without a usable handshake.' };
  }
  return joinRemoteAct(caller, {
    handshakeId: bundle.handshakeId, inviteUrl: bundle.inviteUrl, rsaPublicKeyPem: bundle.rsaPublicKeyPem,
    networkId: bundle.networkId, myUrl, ...(spaceMap ? { spaceMap } : {}),
    ...(syncSchedule !== undefined ? { syncSchedule } : {}),
  });
}
