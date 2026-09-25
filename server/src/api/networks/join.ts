/**
 * Joining a network — invite, join, join-remote, and fork.
 *
 * Split out of the api/networks.ts monolith (A17.5); handlers are unchanged.
 */
import { Router } from 'express';
import { boundedJson } from '../../util/bounded-read.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { requireAdmin } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { getConfig, saveConfig, getSecrets, saveSecrets } from '../../config/loader.js';
import { createToken, revokeToken } from '../../auth/tokens.js';
import { peerTokenSpaces, widenPeerTokensOf } from '../../auth/peer-token-scope.js';
import { inviterIsWhoItClaims, knownPeerAt } from '../../auth/peer-identity.js';
import { createSpace } from '../../spaces/lifecycle.js';
import { concludeRoundIfReady } from '../../sync/governance.js';
import { buildBraintreeAncestors } from '../../util/braintree.js';
import { makeSignedOwnCast } from '../../util/signing.js';
import { log } from '../../util/log.js';
import type { NetworkConfig, NetworkMember, VoteRound } from '../../config/types.js';
import { peerSafeFetch } from '../../sync/peer-fetch.js';
import { BCRYPT_ROUNDS, SSRF_SAFE_URL, safeMemberList } from './_shared.js';

export const joinRouter = Router();

const JoinRemoteBody = z.object({
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


// ── POST /api/networks/join-remote ─────────────────────────────────────────
// Called by the JOINING brain's UI. Executes the full RSA invite handshake
// server-side so the browser never handles raw crypto or plaintext tokens.
//
// Flow:
//   1. Brain A admin clicks "Generate invite" → calls POST /api/invite/generate
//      → gets { handshakeId, inviteUrl, rsaPublicKeyPem, networkId, expiresAt }
//   2. Brain A admin sends that bundle to Brain B admin (out-of-band)
//   3. Brain B admin pastes bundle + enters their own URL in Brain B's UI
//   4. Brain B's UI calls this endpoint
//   5. This endpoint executes the RSA handshake against Brain A on behalf of Brain B
//   6. Both sides end up with tokens for each other; network registered locally on Brain B.

joinRouter.post('/join-remote', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    const parsed = JoinRemoteBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

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

    // S-6: when the inviter is a peer this instance already knows, present the token it issued to us, so the inviter
    // can tell this is the genuine peer joining a second network and not someone claiming its id.
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
      res.status(502).json({ error: `Could not reach inviting brain: ${err}` });
      return;
    }

    if (!applyRes.ok) {
      const errBody = await boundedJson<unknown>(applyRes, 'network peer').catch(() => ({}));
      res.status(applyRes.status).json(errBody);
      return;
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

    // S-6: the inviter's id is its own claim. A peer this instance already knows must be answering from the origin it
    // is recorded at — otherwise another server is borrowing its id. Refused before anything is written.
    if (!inviterIsWhoItClaims(cfg, applyData.instanceId, inviteUrl)) {
      res.status(403).json({ error: `The inviter claims the instance id of a peer this instance reaches at another address (${applyData.instanceId}); refused` });
      return;
    }

    // Decrypt tokenForB — the PAT Brain A created on its own server for Brain B to use
    let tokenForB: string;
    try {
      tokenForB = privateDecrypt(
        { key: bPrivKeyPem, padding: C.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(applyData.encryptedTokenForB, 'base64'),
      ).toString('utf8');
    } catch {
      res.status(400).json({ error: 'Failed to decrypt token from inviting brain' });
      return;
    }
    if (!tokenForB.startsWith('ythril_')) {
      res.status(400).json({ error: 'Decrypted token has unexpected format' });
      return;
    }

    // Create a PAT in this brain's token store scoped to network spaces.
    // Brain A will present this token when calling THIS brain's sync endpoints.
    const remoteSpaceIds: string[] = applyData.spaces ?? [];
    const existingSpaces: string[] = [];
    const createdSpaces: string[] = [];
    const spaceMap: Record<string, string> = {};

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
          res.status(500).json({ error: `Failed to create space '${localId}': ${err}` });
          return;
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
      res.status(502).json({ error: `Could not finalize with inviting brain: ${err}` });
      return;
    }

    if (!finalizeRes.ok) {
      await revokeToken(tokenForARecord.id);
      const errBody = await boundedJson<unknown>(finalizeRes, 'network peer').catch(() => ({}));
      res.status(finalizeRes.status).json(errBody);
      return;
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
      };
      freshCfg.networks.push(net);
    }

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

    res.json({
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
    });
  } catch (err) {
    log.error(`POST /api/networks/join-remote: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/invite — generate invite key ───────────────────

joinRouter.post('/:id/invite', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const { randomBytes } = await import('crypto');
    const key = `ythril_invite_${randomBytes(32).toString('base64url')}`;
    const inviteKeyHash = await bcrypt.hash(key, BCRYPT_ROUNDS);
    // Re-fetch config after async bcrypt to avoid clobbering concurrent writes.
    const freshCfg = getConfig();
    const freshNet = freshCfg.networks.find(n => n.id === req.params['id']);
    if (!freshNet) { res.status(404).json({ error: 'Network not found' }); return; }
    freshNet.inviteKeyHash = inviteKeyHash;
    saveConfig(freshCfg);

    log.info(`Generated new invite key for network ${freshNet.id}${net.type === 'pubsub' ? ' (reusable)' : ' (shown once)'}`);
    res.json({
      inviteKey: key,
      networkId: net.id,
      ...(net.type === 'pubsub'
        ? { reusable: true, note: 'This key is reusable — safe to publish in docs, QR codes, or share openly. Regenerating a new key revokes this one.' }
        : { reusable: false, note: 'Store this key securely — it is single-use and will not be shown again' }),
    });
  } catch (err) {
    log.error(`POST /api/networks/:id/invite: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/join — join via invite key ─────────────────────

const JoinNetworkBody = z.object({
  inviteKey: z.string().min(1),
  instanceId: z.string().min(1),
  label: z.string().min(1).max(200),
  url: SSRF_SAFE_URL,
  token: z.string().min(1),  // plaintext token for inbound auth
  direction: z.enum(['both', 'push', 'pull']).default('both'),
  parentInstanceId: z.string().optional(),
  skipTlsVerify: z.boolean().optional(),
});


joinRouter.post('/:id/join', globalRateLimit, requireAdmin, async (req, res) => {
  try {
    const parsed = JoinNetworkBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['id']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const keyValid = net.inviteKeyHash
      ? await bcrypt.compare(parsed.data.inviteKey, net.inviteKeyHash)
      : false;

    if (!keyValid) {
      // Vote-governed joins consume the network's invite key when the round opens
      // and preserve the validated hash on the round record. Re-presenting the
      // same key lets the joiner poll the outcome of its own round.
      for (let i = net.pendingRounds.length - 1; i >= 0; i--) {
        const round = net.pendingRounds[i]!;
        if (round.type !== 'join' || !round.inviteKeyHash) continue;
        if (round.subjectInstanceId !== parsed.data.instanceId) continue;
        if (!await bcrypt.compare(parsed.data.inviteKey, round.inviteKeyHash)) continue;

        if (!round.concluded) {
          res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
          return;
        }
        if (!round.passed) {
          res.status(403).json({ error: 'Join was denied by network governance (vetoed or expired)' });
          return;
        }
        // Passed: the member is normally added when the round concludes; re-add
        // from the round's pendingMember if that side-effect was lost (crash
        // between conclusion and persistence). Re-fetch config after the async
        // bcrypt compares to avoid clobbering concurrent writes.
        const freshCfg = getConfig();
        const freshNet = freshCfg.networks.find(n => n.id === req.params['id']);
        if (!freshNet) { res.status(404).json({ error: 'Network not found' }); return; }
        if (!freshNet.members.some(m => m.instanceId === parsed.data.instanceId)) {
          if (!round.pendingMember) {
            res.status(410).json({ error: 'Join round passed but the member record was not retained — generate a new invite' });
            return;
          }
          freshNet.members.push(round.pendingMember);
          saveConfig(freshCfg);
        }
        res.status(200).json({ status: 'joined', members: safeMemberList(freshNet, parsed.data.instanceId), networkId: freshNet.id });
        return;
      }
      if (!net.inviteKeyHash) {
        res.status(400).json({ error: 'No active invite key — generate one first via POST /invite' });
        return;
      }
      res.status(403).json({ error: 'Invalid invite key' });
      return;
    }

    if (net.members.some(m => m.instanceId === parsed.data.instanceId)) {
      res.status(409).json({ error: 'Member already exists' });
      return;
    }

    const { instanceId, label, url, token, direction, parentInstanceId, skipTlsVerify } = parsed.data;
    const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
    // Re-fetch config after async bcrypt to avoid clobbering concurrent writes.
    const freshCfg = getConfig();
    const freshNet = freshCfg.networks.find(n => n.id === req.params['id']);
    if (!freshNet) { res.status(404).json({ error: 'Network not found' }); return; }
    if (freshNet.members.some(m => m.instanceId === instanceId)) {
      res.status(409).json({ error: 'Member already exists' });
      return;
    }
    const member: NetworkMember = { instanceId, label, url, tokenHash, direction, parentInstanceId, skipTlsVerify };

    if (freshNet.type === 'closed' || freshNet.type === 'democratic') {
      const round: VoteRound = {
        roundId: uuidv4(),
        type: 'join',
        subjectInstanceId: instanceId,
        subjectLabel: label,
        subjectUrl: url,
        deadline: new Date(Date.now() + freshNet.votingDeadlineHours * 3_600_000).toISOString(),
        openedAt: new Date().toISOString(),
        votes: [],
        pendingMember: member,             // held here until the vote passes
        inviteKeyHash: net.inviteKeyHash,  // preserve the original validated hash in the round record
      };
      freshNet.pendingRounds.push(round);
      // Revoke invite key after use to prevent replay
      freshNet.inviteKeyHash = undefined;
      // Save the plaintext peer token so the sync engine can use it once the vote passes
      const secrets = getSecrets();
      secrets.peerTokens[instanceId] = token;
      saveSecrets(secrets);
      saveConfig(freshCfg);
      log.info(`Join via invite key opened vote round ${round.roundId} for ${label}`);
      res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
      return;
    }

    if (freshNet.type === 'braintree') {
      // Braintree is vote-governed (S9): the joiner is admitted only after every
      // ancestor on the path from this (inviting) node to the root votes yes —
      // same round shape as the admin member-add path. The joiner always becomes
      // a child of the inviting node; topology fields from the wire are ignored.
      member.parentInstanceId = freshCfg.instanceId;
      member.direction = 'push';   // we push to our children
      const requiredVoters = buildBraintreeAncestors(freshNet, freshCfg.instanceId, freshCfg.instanceId);
      const round: VoteRound = {
        roundId: uuidv4(),
        type: 'join',
        subjectInstanceId: instanceId,
        subjectLabel: label,
        subjectUrl: url,
        deadline: new Date(Date.now() + freshNet.votingDeadlineHours * 3_600_000).toISOString(),
        openedAt: new Date().toISOString(),
        votes: [],
        pendingMember: member,
        requiredVoters,
        inviteKeyHash: net.inviteKeyHash,  // preserve the validated hash so the joiner can poll
      };
      freshNet.pendingRounds.push(round);
      // The inviting node's approval is implicit — it generated the invite key.
      round.votes.push(makeSignedOwnCast(freshNet.id, round, freshCfg.instanceId, 'yes'));
      // Consume the key (single-use) and store the peer token for post-admission sync.
      freshNet.inviteKeyHash = undefined;
      const secrets = getSecrets();
      secrets.peerTokens[instanceId] = token;
      saveSecrets(secrets);
      const immediatePassed = concludeRoundIfReady(freshNet, round);
      if (immediatePassed) {
        // Root case: the ancestor path is only [self] → admit immediately
        freshNet.members.push(member);
        saveConfig(freshCfg);
        log.info(`Braintree join via invite key immediate (root): added ${label} (${instanceId}) to network ${freshNet.id}`);
        res.status(200).json({ status: 'joined', members: safeMemberList(freshNet, instanceId), networkId: freshNet.id });
        return;
      }
      saveConfig(freshCfg);
      log.info(`Join via invite key opened braintree ancestor round ${round.roundId} for ${label} (${instanceId}) in network ${freshNet.id}`);
      res.status(202).json({ status: 'vote_pending', roundId: round.roundId });
      return;
    }

    // Club / Pubsub — direct join via invite key (documented behavior)
    // Pubsub subscribers are always push-only (publisher pushes to them).
    if (freshNet.type === 'pubsub') member.direction = 'push';
    freshNet.members.push(member);
    // Pubsub keys are reusable (publishable in docs, QR codes, etc.)
    // All other types consume the key after use to prevent replay.
    if (freshNet.type !== 'pubsub') freshNet.inviteKeyHash = undefined;
    saveConfig(freshCfg);
    log.info(`Member ${label} joined network ${freshNet.id} via invite key`);

    // Return peer the member list and network metadata (enough to start syncing)
    res.status(200).json({ status: 'joined', members: safeMemberList(freshNet, instanceId), networkId: freshNet.id });
  } catch (err) {
    log.error(`POST /api/networks/:id/join: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});


// ── POST /api/networks/:id/fork ──────────────────────────────────────────────
// Creates a new standalone/closed network seeded from the caller's copy of the
// source network's spaces. Works for:
//   • Active member  — source network still present; spaces are inherited
//   • Ejected member — source network is gone (deleted on ejection); caller must
//     supply spaces explicitly in the request body
//
// The source network is never modified. ejectedFromNetworks is never cleared.

const ForkNetworkBody = z.object({
  label: z.string().min(1).max(200),
  type: z.enum(['closed', 'club']).default('closed'),
  votingDeadlineHours: z.number().int().min(1).max(72).optional(),
  spaces: z.array(z.string().min(1)).optional(),
});

joinRouter.post('/:id/fork', globalRateLimit, requireAdmin, (req, res) => {
  try {
    const parsed = ForkNetworkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const cfg = getConfig();
    const sourceId = String(req.params['id'] ?? '');
    const sourceNet = cfg.networks.find(n => n.id === sourceId);
    const isEjected = cfg.ejectedFromNetworks?.includes(sourceId) ?? false;

    if (!sourceNet && !isEjected) {
      res.status(404).json({ error: 'Network not found' });
      return;
    }

    // Spaces: body override takes precedence; otherwise inherited from source.
    const spaces = parsed.data.spaces ?? sourceNet?.spaces;

    if (!spaces || spaces.length === 0) {
      res.status(400).json({
        error: 'spaces is required when the source network is no longer locally available',
      });
      return;
    }

    // All requested spaces must be locally known.
    const unknownSpaces = spaces.filter(s => !cfg.spaces.some(cs => cs.id === s));
    if (unknownSpaces.length > 0) {
      res.status(400).json({ error: `Unknown spaces: ${unknownSpaces.join(', ')}` });
      return;
    }

    const forkedNet: NetworkConfig = {
      id: uuidv4(),
      label: parsed.data.label,
      type: parsed.data.type,
      spaces,
      votingDeadlineHours: parsed.data.votingDeadlineHours ?? sourceNet?.votingDeadlineHours ?? 24,
      members: [],
      pendingRounds: [],
      createdAt: new Date().toISOString(),
    };

    cfg.networks.push(forkedNet);
    saveConfig(cfg);
    log.info(`Forked network ${sourceId} → new network ${forkedNet.id} ('${forkedNet.label}')`);
    res.status(201).json(forkedNet);
  } catch (err) {
    log.error(`POST /api/networks/:id/fork: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});
