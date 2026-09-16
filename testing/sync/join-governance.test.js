/**
 * Integration tests: join-path governance (SECURITY S9)
 *
 * The documented governance model admits a new member only after the required
 * vote passes (braintree: every ancestor from the inviting node to the root;
 * closed: all members; democratic: majority). These tests verify that BOTH
 * non-admin join paths honour that model:
 *
 *   1. POST /api/networks/:id/join  (invite key)
 *      - braintree root    → immediate join (single-ancestor auto-pass)
 *      - braintree child   → 202 vote_pending, held until ancestors vote yes
 *      - ancestor veto     → never admitted, poll returns 403
 *      - club              → direct join unchanged (documented behavior)
 *      - re-presenting the consumed key polls the round outcome
 *
 *   2. POST /api/invite/finalize  (RSA handshake)
 *      - braintree root    → status 'joined' (back-compat)
 *      - braintree child   → status 'vote_pending', held; pending peer PAT is
 *                            refused on /api/sync/* until the vote passes
 *      - closed w/ members → status 'vote_pending', held
 *      - democratic w/ 2 members → status 'vote_pending', held
 *
 * Topology used for the "child" scenarios: A (root) → B (intermediate).
 * The joining leaf is simulated by this test process (no third container
 * needed — the join endpoints are driven directly).
 *
 * Run:  node --test testing/sync/join-governance.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import {
  INSTANCES, post, get, del, delWithBody, waitFor, triggerSync,
  getInstanceId, readContainerConfig, readContainerSecrets, dockerExec,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

// ── module-level state ──────────────────────────────────────────────────────

let tokenA, tokenB;
let instanceIdA, instanceIdB;
let peerTokenForA; // token B issued → A uses to authenticate inbound calls TO B
let peerTokenForB; // token A issued → B uses to authenticate inbound calls TO A
let testSpaceId;

// ── helpers ─────────────────────────────────────────────────────────────────

function injectPeerToken(container, instanceId, token) {
  const script = [
    `const fs=require('fs');`,
    `const p='/config/secrets.json';`,
    `const s=JSON.parse(fs.readFileSync(p,'utf8'));`,
    `s.peerTokens=s.peerTokens||{};`,
    `s.peerTokens['${instanceId}']='${token}';`,
    `fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600});`,
    `process.stdout.write('ok');`,
  ].join('');
  dockerExec(`docker exec ${container} node -e "${script}"`);
}

/** A (root) → B (child) braintree network, registered on both instances. */
async function setupBraintreeAB(label) {
  const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
    label: `${label} ${Date.now()}`,
    type: 'braintree',
    spaces: [testSpaceId],
    votingDeadlineHours: 1,
  });
  assert.equal(netR.status, 201, `Create net on A: ${JSON.stringify(netR.body)}`);
  const networkId = netR.body.id;

  injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
  await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
  const addBR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
    instanceId: instanceIdB,
    label: 'Instance B',
    url: 'http://ythril-b:3200',
    token: peerTokenForA,
    direction: 'push',
    parentInstanceId: instanceIdA,
  });
  assert.equal(addBR.status, 201, `Add B to A: ${JSON.stringify(addBR.body)}`);

  injectPeerToken('ythril-b', instanceIdA, peerTokenForB);
  await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});
  const regBR = await post(INSTANCES.b, tokenB, '/api/networks', {
    id: networkId,
    label,
    type: 'braintree',
    spaces: [testSpaceId],
    votingDeadlineHours: 1,
    myParentInstanceId: instanceIdA,
  });
  assert.ok(regBR.status === 201 || regBR.status === 409, `Register net on B: ${JSON.stringify(regBR.body)}`);
  return networkId;
}

/** waitFor() that re-triggers a sync run on A each poll so a lost gossip cycle
 *  cannot stall the test (a single up-front trigger races slow cycles). */
async function waitForWithSyncFromA(networkId, condition, timeout, diagnose) {
  let lastTriggerError = null;
  await waitFor(async () => {
    if (await condition()) return true;
    try {
      await triggerSync(INSTANCES.a, tokenA, networkId);
      lastTriggerError = null;
    } catch (err) {
      lastTriggerError = err;
    }
    return condition();
  }, timeout, 1_000, () => `${diagnose}${lastTriggerError ? ` (last sync trigger failed: ${lastTriggerError.message})` : ''}`);
}

/** Let A discover B's open round via gossip and cast a vote on it. */
async function castVoteFromA(networkId, roundId, vote) {
  await triggerSync(INSTANCES.a, tokenA, networkId);
  await waitForWithSyncFromA(networkId, async () => {
    const cfgA = readContainerConfig('ythril-a');
    const netA = cfgA.networks?.find(n => n.id === networkId);
    return netA?.pendingRounds?.some(r => r.roundId === roundId);
  }, 30_000, `round ${roundId} never appeared on A via gossip`);

  const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote });
  assert.equal(voteR.status, 200, `A vote ${vote}: ${JSON.stringify(voteR.body)}`);

  // Propagate A's cast back to B
  await triggerSync(INSTANCES.a, tokenA, networkId);
}

/** Drive the RSA invite handshake against `baseUrl` acting as a fake joiner. */
async function rsaHandshakeJoin(baseUrl, adminToken, networkId, joinerInstanceId, joinerLabel) {
  const gen = await post(baseUrl, adminToken, '/api/invite/generate', { networkId });
  assert.equal(gen.status, 201, `invite/generate: ${JSON.stringify(gen.body)}`);

  const { privateKey: joinerPriv, publicKey: joinerPub } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const applyR = await post(baseUrl, '', '/api/invite/apply', {
    handshakeId: gen.body.handshakeId,
    networkId,
    instanceId: joinerInstanceId,
    instanceLabel: joinerLabel,
    instanceUrl: 'https://joiner.ythril-test.example.com',
    rsaPublicKeyPem: joinerPub,
  });
  assert.equal(applyR.status, 200, `invite/apply: ${JSON.stringify(applyR.body)}`);

  // Decrypt the PAT the inviter issued for the joiner (used later to probe /api/sync/*)
  const joinerPat = crypto.privateDecrypt(
    { key: joinerPriv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(applyR.body.encryptedTokenForB, 'base64'),
  ).toString('utf8');
  assert.ok(joinerPat.startsWith('ythril_'), 'decrypted PAT should be valid');

  // Synthetic return token — finalize only validates the prefix and stores it
  const tokenForInviter = `ythril_${crypto.randomBytes(32).toString('base64url')}`;
  const encryptedTokenForA = crypto.publicEncrypt(
    { key: applyR.body.rsaPublicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(tokenForInviter, 'utf8'),
  ).toString('base64');

  const finalR = await post(baseUrl, '', '/api/invite/finalize', {
    handshakeId: gen.body.handshakeId,
    encryptedTokenForA,
  });
  assert.equal(finalR.status, 200, `invite/finalize: ${JSON.stringify(finalR.body)}`);
  return { finalize: finalR.body, joinerPat };
}

// ── outer setup ─────────────────────────────────────────────────────────────

/**
 * Mint a fresh pair of peer PATs, PER DESCRIBE BLOCK rather than once for the file.
 *
 * A token carrying `peerInstanceId` is enrolled in lifecycle revocation:
 * `revokePeerCredentialsIfOrphaned` deletes every token bound to an instance the moment that instance
 * stops being a member of any network — on vote conclusion, removal, departure, or NETWORK DELETION. The
 * blocks below create and delete a network each, so one pair minted for the whole file is revoked by the
 * first teardown and every later block runs on a dead credential. The symptom is `waitFor timed out`,
 * never a legible 401.
 *
 * These were bare until 2026-09-04, which is why the pattern worked: a token with no peer identity is not
 * enrolled in that revocation at all.
 */
async function mintPeerTokens() {
    const ptForA = await post(INSTANCES.b, tokenB, '/api/tokens', {
      name: `s9-peer-a-${Date.now()}`, peerInstanceId: instanceIdA,
    });
    assert.equal(ptForA.status, 201);
    peerTokenForA = ptForA.body.plaintext;

    const ptForB = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `s9-peer-b-${Date.now()}`, peerInstanceId: instanceIdB,
    });
    assert.equal(ptForB.status, 201);
    peerTokenForB = ptForB.body.plaintext;
}
describe('Join-path governance (S9) — invite key and RSA handshake respect voting', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();

    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    testSpaceId = `s9-join-${Date.now()}`;
    const spA = await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'S9 Join Space' });
    assert.equal(spA.status, 201, `Create space on A: ${JSON.stringify(spA.body)}`);
    const spB = await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'S9 Join Space' });
    assert.equal(spB.status, 201, `Create space on B: ${JSON.stringify(spB.body)}`);

    await mintPeerTokens();
  });

  after(async () => {
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1a. Invite-key join on braintree ROOT — single ancestor, immediate join
  // ══════════════════════════════════════════════════════════════════════════

  describe('Invite-key join — braintree root admits immediately', () => {
    let networkId;

    before(async () => {
      // Fresh credentials — the previous block deleted its network. See `mintPeerTokens`.
      await mintPeerTokens();
      const r = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `S9 BT Root ${Date.now()}`,
        type: 'braintree',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(r.status, 201);
      networkId = r.body.id;
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    });

    it('join via invite key on the root returns 200 joined (ancestor path = [root])', async () => {
      const inv = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/invite`, {});
      assert.ok(inv.body.inviteKey, 'invite key expected');

      const joinR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/join`, {
        inviteKey: inv.body.inviteKey,
        instanceId: `s9-root-leaf-${Date.now()}`,
        label: 'Root Leaf',
        url: 'http://ythril-c:3200',
        token: `ythril_${crypto.randomBytes(24).toString('base64url')}`,
      });
      assert.equal(joinR.status, 200, `Expected 200 immediate join, got ${joinR.status}: ${JSON.stringify(joinR.body)}`);
      assert.equal(joinR.body.status, 'joined');

      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks.find(n => n.id === networkId);
      const openRounds = net?.pendingRounds?.filter(r => !r.concluded) ?? [];
      assert.equal(openRounds.length, 0, 'no open rounds should remain after a root join');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1b. Invite-key join on braintree CHILD — held until ancestor votes yes
  // ══════════════════════════════════════════════════════════════════════════

  describe('Invite-key join — braintree child holds the member for the ancestor vote', () => {
    let networkId;
    let inviteKey;
    let roundId;
    const leafId = `s9-leaf-${Date.now()}`;

    before(async () => {
      // Fresh credentials — the previous block deleted its network. See `mintPeerTokens`.
      await mintPeerTokens();
      networkId = await setupBraintreeAB('S9 BT Child Join');
      const inv = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/invite`, {});
      assert.ok(inv.body.inviteKey, 'invite key expected');
      inviteKey = inv.body.inviteKey;
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    });

    it('join on the child returns 202 vote_pending and the member is NOT admitted', async () => {
      const joinR = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/join`, {
        inviteKey,
        instanceId: leafId,
        label: 'Held Leaf',
        url: 'http://ythril-c:3200',
        token: `ythril_${crypto.randomBytes(24).toString('base64url')}`,
      });
      assert.equal(joinR.status, 202, `Expected 202 vote_pending, got ${joinR.status}: ${JSON.stringify(joinR.body)}`);
      assert.equal(joinR.body.status, 'vote_pending');
      assert.ok(joinR.body.roundId, 'roundId expected');
      roundId = joinR.body.roundId;

      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks.find(n => n.id === networkId);
      assert.ok(!netB.members.some(m => m.instanceId === leafId), 'leaf must NOT be a member while the vote is open');

      const round = netB.pendingRounds.find(r => r.roundId === roundId);
      assert.ok(round, 'round must exist on B');
      assert.ok(round.requiredVoters?.includes(instanceIdB), 'requiredVoters must include B (inviting node)');
      assert.ok(round.requiredVoters?.includes(instanceIdA), 'requiredVoters must include A (root)');
      assert.ok(round.votes.some(v => v.instanceId === instanceIdB && v.vote === 'yes'),
        "B's implicit yes vote (invite key = inviter intent) must be cast");
      assert.ok(round.pendingMember, 'the member record must be held on the round');
      assert.equal(round.pendingMember.parentInstanceId, instanceIdB, 'joiner must be held as a child of the inviting node');
    });

    it('re-presenting the consumed invite key polls the pending round (202 again)', async () => {
      const pollR = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/join`, {
        inviteKey,
        instanceId: leafId,
        label: 'Held Leaf',
        url: 'http://ythril-c:3200',
        token: `ythril_${crypto.randomBytes(24).toString('base64url')}`,
      });
      assert.equal(pollR.status, 202, `Expected 202 poll, got ${pollR.status}: ${JSON.stringify(pollR.body)}`);
      assert.equal(pollR.body.roundId, roundId, 'poll must return the SAME round, not open a new one');
    });

    it("after A's yes vote propagates, the leaf is admitted on B", async () => {
      await castVoteFromA(networkId, roundId, 'yes');

      await waitForWithSyncFromA(networkId, async () => {
        const cfgB = readContainerConfig('ythril-b');
        const netB = cfgB.networks?.find(n => n.id === networkId);
        return netB?.members?.some(m => m.instanceId === leafId);
      }, 30_000, 'leaf never admitted on B after ancestor yes vote');

      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks.find(n => n.id === networkId);
      const member = netB.members.find(m => m.instanceId === leafId);
      assert.equal(member.parentInstanceId, instanceIdB, 'admitted leaf must be a child of B');
    });

    it('polling with the key after admission returns 200 joined + member list', async () => {
      const pollR = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/join`, {
        inviteKey,
        instanceId: leafId,
        label: 'Held Leaf',
        url: 'http://ythril-c:3200',
        token: `ythril_${crypto.randomBytes(24).toString('base64url')}`,
      });
      assert.equal(pollR.status, 200, `Expected 200 joined, got ${pollR.status}: ${JSON.stringify(pollR.body)}`);
      assert.equal(pollR.body.status, 'joined');
      assert.ok(Array.isArray(pollR.body.members), 'member list expected');
      assert.ok(!pollR.body.members.some(m => m.tokenHash), 'member list must not leak tokenHash');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1c. Invite-key join on braintree CHILD — ancestor veto never admits
  // ══════════════════════════════════════════════════════════════════════════

  describe('Invite-key join — ancestor veto never admits, credentials are revoked', () => {
    let networkId;
    let inviteKey;
    let roundId;
    const leafId = `s9-veto-leaf-${Date.now()}`;

    before(async () => {
      // Fresh credentials — the previous block deleted its network. See `mintPeerTokens`.
      await mintPeerTokens();
      networkId = await setupBraintreeAB('S9 BT Veto Join');
      const inv = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/invite`, {});
      inviteKey = inv.body.inviteKey;

      const joinR = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/join`, {
        inviteKey,
        instanceId: leafId,
        label: 'Vetoed Leaf',
        url: 'http://ythril-c:3200',
        token: `ythril_${crypto.randomBytes(24).toString('base64url')}`,
      });
      assert.equal(joinR.status, 202, `Expected 202, got ${joinR.status}: ${JSON.stringify(joinR.body)}`);
      roundId = joinR.body.roundId;
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    });

    it("A's veto concludes the round as failed on B and the leaf is never admitted", async () => {
      await castVoteFromA(networkId, roundId, 'veto');

      await waitForWithSyncFromA(networkId, async () => {
        const cfgB = readContainerConfig('ythril-b');
        const netB = cfgB.networks?.find(n => n.id === networkId);
        const r = netB?.pendingRounds?.find(r => r.roundId === roundId);
        return r?.concluded === true && r?.passed === false;
      }, 30_000, 'veto never concluded the round on B');

      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks.find(n => n.id === networkId);
      assert.ok(!netB.members.some(m => m.instanceId === leafId), 'vetoed leaf must never be admitted');
    });

    it("the vetoed joiner's provisioned outbound token is revoked", async () => {
      await waitFor(async () => {
        const secretsB = readContainerSecrets('ythril-b');
        return !secretsB.peerTokens?.[leafId];
      }, 15_000, 500, `secrets.peerTokens still holds an entry for rejected joiner ${leafId}`);
    });

    it('polling with the key after the veto returns 403', async () => {
      const pollR = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/join`, {
        inviteKey,
        instanceId: leafId,
        label: 'Vetoed Leaf',
        url: 'http://ythril-c:3200',
        token: `ythril_${crypto.randomBytes(24).toString('base64url')}`,
      });
      assert.equal(pollR.status, 403, `Expected 403 denied, got ${pollR.status}: ${JSON.stringify(pollR.body)}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1d. Invite-key join on club — direct join unchanged
  // ══════════════════════════════════════════════════════════════════════════

  describe('Invite-key join — club still direct-joins (documented behavior)', () => {
    let networkId;

    before(async () => {
      // Fresh credentials — the previous block deleted its network. See `mintPeerTokens`.
      await mintPeerTokens();
      const r = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `S9 Club ${Date.now()}`,
        type: 'club',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(r.status, 201);
      networkId = r.body.id;
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    });

    it('club join via invite key returns 200 joined with no vote round', async () => {
      const inv = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/invite`, {});
      const joinR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/join`, {
        inviteKey: inv.body.inviteKey,
        instanceId: `s9-club-${Date.now()}`,
        label: 'Club Member',
        url: 'http://ythril-c:3200',
        token: `ythril_${crypto.randomBytes(24).toString('base64url')}`,
      });
      assert.equal(joinR.status, 200, `Expected 200 direct join, got ${joinR.status}: ${JSON.stringify(joinR.body)}`);
      assert.equal(joinR.body.status, 'joined');

      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks.find(n => n.id === networkId);
      assert.equal((net.pendingRounds ?? []).length, 0, 'club join must not open a vote round');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2a. RSA finalize on braintree ROOT — back-compat immediate join
  // ══════════════════════════════════════════════════════════════════════════

  describe('RSA finalize — braintree root still joins immediately', () => {
    let networkId;

    before(async () => {
      // Fresh credentials — the previous block deleted its network. See `mintPeerTokens`.
      await mintPeerTokens();
      const r = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `S9 RSA BT Root ${Date.now()}`,
        type: 'braintree',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(r.status, 201);
      networkId = r.body.id;
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    });

    it("finalize on the root returns status 'joined' and the member is admitted", async () => {
      const joinerId = crypto.randomUUID();
      const { finalize } = await rsaHandshakeJoin(INSTANCES.a, tokenA, networkId, joinerId, 'RSA Root Leaf');
      assert.equal(finalize.status, 'joined', `Expected joined, got: ${JSON.stringify(finalize)}`);

      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks.find(n => n.id === networkId);
      const member = net.members.find(m => m.instanceId === joinerId);
      assert.ok(member, 'member must be admitted immediately (root = sole required voter)');
      assert.equal(member.parentInstanceId, instanceIdA, 'joiner must be a child of the root');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2b. RSA finalize on braintree CHILD — held; pending PAT refused on sync API
  // ══════════════════════════════════════════════════════════════════════════

  describe('RSA finalize — braintree child holds the member and its credentials', () => {
    let networkId;
    let roundId;
    let joinerPat;
    const joinerId = crypto.randomUUID();

    before(async () => {
      // Fresh credentials — the previous block deleted its network. See `mintPeerTokens`.
      await mintPeerTokens();
      networkId = await setupBraintreeAB('S9 RSA BT Child');
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
    });

    it("finalize on the child returns status 'vote_pending' and does NOT admit", async () => {
      const result = await rsaHandshakeJoin(INSTANCES.b, tokenB, networkId, joinerId, 'RSA Held Leaf');
      joinerPat = result.joinerPat;
      assert.equal(result.finalize.status, 'vote_pending', `Expected vote_pending, got: ${JSON.stringify(result.finalize)}`);
      assert.ok(result.finalize.roundId, 'roundId expected in finalize response');
      roundId = result.finalize.roundId;

      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks.find(n => n.id === networkId);
      assert.ok(!netB.members.some(m => m.instanceId === joinerId), 'joiner must NOT be a member while the vote is open');
      const round = netB.pendingRounds.find(r => r.roundId === roundId);
      assert.ok(round?.pendingMember, 'member record must be held on the round');
      assert.ok(round.requiredVoters?.includes(instanceIdA), 'root must be a required voter');
    });

    it('the pending joiner PAT is refused on /api/sync/* (no sync possible)', async () => {
      const probe = await get(INSTANCES.b, joinerPat,
        `/api/sync/facts?spaceId=${testSpaceId}&networkId=${networkId}`);
      assert.equal(probe.status, 403, `Expected 403 for pending joiner, got ${probe.status}: ${JSON.stringify(probe.body)}`);
    });

    it("after the root's yes vote, the joiner is admitted and its PAT works", async () => {
      await castVoteFromA(networkId, roundId, 'yes');

      await waitForWithSyncFromA(networkId, async () => {
        const cfgB = readContainerConfig('ythril-b');
        const netB = cfgB.networks?.find(n => n.id === networkId);
        return netB?.members?.some(m => m.instanceId === joinerId);
      }, 30_000, 'joiner never admitted on B after ancestor yes vote');

      const cfgB = readContainerConfig('ythril-b');
      const netB = cfgB.networks.find(n => n.id === networkId);
      const member = netB.members.find(m => m.instanceId === joinerId);
      assert.equal(member.parentInstanceId, instanceIdB, 'admitted joiner must be a child of B');

      const probe = await get(INSTANCES.b, joinerPat,
        `/api/sync/facts?spaceId=${testSpaceId}&networkId=${networkId}`);
      assert.equal(probe.status, 200, `Admitted joiner PAT must work, got ${probe.status}: ${JSON.stringify(probe.body)}`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2c. RSA finalize on a closed network with an existing member — held
  // ══════════════════════════════════════════════════════════════════════════

  describe('RSA finalize — closed network with existing members holds the join', () => {
    let networkId;

    before(async () => {
      // Fresh credentials — the previous block deleted its network. See `mintPeerTokens`.
      await mintPeerTokens();
      const r = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `S9 RSA Closed ${Date.now()}`,
        type: 'closed',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(r.status, 201);
      networkId = r.body.id;

      // Admit B as the first member (closed admin-add opens a round; A's local
      // yes concludes it — no other members exist yet).
      const addBR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
        instanceId: instanceIdB,
        label: 'Instance B',
        url: 'http://ythril-b:3200',
        token: peerTokenForA,
      });
      assert.equal(addBR.status, 202, `Add B: ${JSON.stringify(addBR.body)}`);
      const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addBR.body.roundId}`, { vote: 'yes' });
      assert.equal(voteR.status, 200);
      assert.equal(voteR.body.concluded, true, 'sole-proposer closed round should conclude on own yes');

      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks.find(n => n.id === networkId);
      assert.ok(net.members.some(m => m.instanceId === instanceIdB), 'B must be a member before the RSA join test');
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    });

    it("finalize returns status 'vote_pending' — all existing members must vote", async () => {
      const joinerId = crypto.randomUUID();
      const { finalize } = await rsaHandshakeJoin(INSTANCES.a, tokenA, networkId, joinerId, 'RSA Closed Joiner');
      assert.equal(finalize.status, 'vote_pending', `Expected vote_pending, got: ${JSON.stringify(finalize)}`);

      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks.find(n => n.id === networkId);
      assert.ok(!net.members.some(m => m.instanceId === joinerId), 'joiner must NOT be admitted before B votes');
      const round = net.pendingRounds.find(r => r.roundId === finalize.roundId);
      assert.ok(round && !round.concluded, 'round must be open');
      assert.ok(round.votes.some(v => v.instanceId === instanceIdA && v.vote === 'yes'),
        "A's implicit yes (it generated the invite) must be cast");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2d. RSA finalize on a democratic network with two members — held
  // ══════════════════════════════════════════════════════════════════════════

  describe('RSA finalize — democratic network with two members holds the join', () => {
    let networkId;

    before(async () => {
      // Fresh credentials — the previous block deleted its network. See `mintPeerTokens`.
      await mintPeerTokens();
      const r = await post(INSTANCES.a, tokenA, '/api/networks', {
        label: `S9 RSA Democratic ${Date.now()}`,
        type: 'democratic',
        spaces: [testSpaceId],
        votingDeadlineHours: 1,
      });
      assert.equal(r.status, 201);
      networkId = r.body.id;

      // Seed two dummy members (each add opens a round; A's yes concludes it
      // while it is still the only voter).
      for (const n of [1, 2]) {
        const addR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
          instanceId: `s9-dem-seed-${n}-${Date.now()}`,
          label: `Seed ${n}`,
          url: 'http://ythril-c:3200',
          token: `ythril_${crypto.randomBytes(24).toString('base64url')}`,
        });
        assert.equal(addR.status, 202, `Seed add ${n}: ${JSON.stringify(addR.body)}`);
        const voteR = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addR.body.roundId}`, { vote: 'yes' });
        assert.equal(voteR.status, 200, `Seed vote ${n}: ${JSON.stringify(voteR.body)}`);
      }
      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks.find(n => n.id === networkId);
      assert.equal(net.members.length, 2, 'two seed members expected');
    });

    after(async () => {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    });

    it("finalize returns status 'vote_pending' — a majority is required", async () => {
      const joinerId = crypto.randomUUID();
      const { finalize } = await rsaHandshakeJoin(INSTANCES.a, tokenA, networkId, joinerId, 'RSA Democratic Joiner');
      assert.equal(finalize.status, 'vote_pending', `Expected vote_pending, got: ${JSON.stringify(finalize)}`);

      const cfg = readContainerConfig('ythril-a');
      const net = cfg.networks.find(n => n.id === networkId);
      assert.ok(!net.members.some(m => m.instanceId === joinerId), 'joiner must NOT be admitted on a 1-of-2 vote');
    });
  });
});
