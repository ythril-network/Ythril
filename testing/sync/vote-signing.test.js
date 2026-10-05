/**
 * Integration tests: signed governance votes + safe relay.
 *
 * Proves the end-to-end wiring of the vote-signing feature:
 *  1. A vote cast created via the API carries an Ed25519 signature, and that
 *     signature survives propagation to a peer unchanged.
 *  2. Signing public keys distribute between peers via member gossip (TOFU pin).
 *  3. A VALID signed cast from a third instance (C) is accepted even when relayed
 *     by a different peer (B) — the multi-hop relay that plain own-cast-only
 *     rejected. A TAMPERED relayed cast is rejected.
 *
 * Run:  node --test testing/sync/vote-signing.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, del, delWithBody, waitFor, makeTriggerProbe } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

let tokenA, tokenB, instanceIdA, instanceIdB, peerTokenForA, peerTokenForB, networkId, testSpaceId;

function getInstanceId(c) {
  return dockerExec(`docker exec ${c} node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/config/config.json','utf8'));process.stdout.write(j.instanceId)"`).toString().trim();
}
function injectPeerToken(c, id, tok) {
  const s = `const fs=require('fs');const p='/config/secrets.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));s.peerTokens=s.peerTokens||{};s.peerTokens['${id}']='${tok}';fs.writeFileSync(p,JSON.stringify(s,null,2),{mode:0o600});process.stdout.write('ok');`;
  dockerExec(`docker exec ${c} node -e "${s}"`);
}
function readConfig(c) {
  return JSON.parse(dockerExec(`docker exec ${c} node -e "const fs=require('fs');process.stdout.write(fs.readFileSync('/config/config.json','utf8'))"`).toString());
}
/** Mutate a container's config.json for a network via a base64-encoded JS patch fn body. */
function patchNetwork(c, netId, patchB64) {
  const s = `const fs=require('fs');const p='/config/config.json';const cfg=JSON.parse(fs.readFileSync(p,'utf8'));const n=cfg.networks.find(x=>x.id==='${netId}');const patch=new Function('n','cfg',Buffer.from('${patchB64}','base64').toString('utf8'));patch(n,cfg);fs.writeFileSync(p,JSON.stringify(cfg,null,2),{mode:0o600});process.stdout.write('ok');`;
  dockerExec(`docker exec ${c} node -e "${s}"`);
}
function patch(c, netId, fnBody) {
  patchNetwork(c, netId, Buffer.from(fnBody, 'utf8').toString('base64'));
}

/**
 * Apply an out-of-band config.json patch and make it STICK.
 *
 * Writing config.json directly races the server's own `saveConfig`: an in-flight
 * sync cycle (e.g. a fire-and-forget cycle left over from a prior test's trigger
 * loop) captured the config BEFORE our patch and, when it finishes, writes its
 * stale copy back — silently dropping whatever we injected. `reload-config`
 * cannot help if the clobber lands after it. That is the real cause of the
 * "vote-signing relay" flake: under full-suite load there are more concurrent
 * cycles, so the patched member/round is more likely to be reverted, after which
 * the relay can never converge (the third-instance key is gone) — no amount of
 * widening the assertion wait fixes an un-pinned key.
 *
 * This re-applies the patch until `verify(net)` holds across TWO consecutive
 * live reads (stability = no cycle is still clobbering), then returns. Throws a
 * descriptive error if it never stabilises.
 */
async function patchAndConfirm(container, baseUrl, token, netId, fnBody, verify, label, timeoutMs = 25_000) {
  let stable = 0;
  let lastNet = null;
  await waitFor(async () => {
    const net = readConfig(container).networks.find(n => n.id === netId);
    lastNet = net;
    if (net && verify(net)) {
      if (++stable >= 2) return true; // held across two reads → the clobber window is closed
    } else {
      stable = 0;
      patch(container, netId, fnBody);
      await post(baseUrl, token, '/api/admin/reload-config', {});
    }
    return false;
  }, timeoutMs, 700, () => `last state: ${JSON.stringify(lastNet?.members?.map(m => m.instanceId) ?? lastNet)}`,
  { what: `patchAndConfirm(${label}) to stabilise` });
}

function voteMsg({ networkId, roundId, subjectInstanceId, instanceId, vote }) {
  return ['ythril-vote:v1', networkId, roundId, subjectInstanceId, instanceId, vote].join('|');
}
function ed25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
function signCast(priv, fields) {
  return crypto.sign(null, Buffer.from(voteMsg(fields), 'utf8'), crypto.createPrivateKey(priv)).toString('base64');
}

describe('Signed governance votes and safe relay', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    instanceIdA = getInstanceId('ythril-a');
    instanceIdB = getInstanceId('ythril-b');

    testSpaceId = `vote-signing-${Date.now()}`;
    await post(INSTANCES.a, tokenA, '/api/spaces', { id: testSpaceId, label: 'Vote Signing Test Space' });
    await post(INSTANCES.b, tokenB, '/api/spaces', { id: testSpaceId, label: 'Vote Signing Test Space' });

    // Each PAT is bound to the peer that PRESENTS it, as `invite.ts` and the join flow do. Bare peer
    // credentials only worked while the two governance relays were the `/api/sync` endpoints not
    // applying `isNonPeerSyncWrite`.
    peerTokenForA = (await post(INSTANCES.b, tokenB, '/api/tokens', {
      name: `vs-a-${Date.now()}`, peerInstanceId: instanceIdA,
    })).body.plaintext;
    peerTokenForB = (await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `vs-b-${Date.now()}`, peerInstanceId: instanceIdB,
    })).body.plaintext;

    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `Vote Signing ${Date.now()}`, type: 'closed', spaces: [testSpaceId], votingDeadlineHours: 1,
    });
    assert.equal(netR.status, 201, JSON.stringify(netR.body));
    networkId = netR.body.id;

    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdB, label: 'Instance B', url: 'http://ythril-b:3200', token: peerTokenForA, direction: 'both',
    });
    if (addB.status === 202) await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });

    const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', {
      id: networkId, label: 'Vote Signing', type: 'closed', spaces: [testSpaceId], votingDeadlineHours: 1,
    });
    assert.ok(netOnB.status === 201 || netOnB.status === 409, JSON.stringify(netOnB.body));
    const addAonB = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
      instanceId: instanceIdA, label: 'Instance A', url: 'http://ythril-a:3200', token: peerTokenForB, direction: 'both',
    });
    if (addAonB.status === 202) await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${addAonB.body.roundId}`, { vote: 'yes' });

    injectPeerToken('ythril-a', instanceIdB, peerTokenForA);
    injectPeerToken('ythril-b', instanceIdA, peerTokenForB);
    await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
    await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
      await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
      await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
      await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${testSpaceId}`, { confirm: true }).catch(() => {});
    }
  });

  it('A vote cast is signed, and the signature propagates to B intact', async () => {
    // Open a join round on A and cast A's vote (now signed).
    const cand = `sig-cand-${Date.now()}`;
    const open = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: cand, label: 'Sig Candidate', url: 'http://vote-sign.internal:3200', token: `ythril_sig_${cand}`, direction: 'both',
    });
    assert.equal(open.status, 202, JSON.stringify(open.body));
    const roundId = open.body.roundId;
    const vr = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${roundId}`, { vote: 'yes' });
    assert.ok([200, 201].includes(vr.status), JSON.stringify(vr.body));

    // A's own cast must carry a signature.
    const roundOnA = readConfig('ythril-a').networks.find(n => n.id === networkId).pendingRounds.find(r => r.roundId === roundId);
    const aCast = roundOnA.votes.find(v => v.instanceId === instanceIdA);
    assert.ok(aCast?.sig, 'A\'s vote cast must be signed');

    // Propagate to B and confirm the signature survived unchanged. Re-trigger the
    // sync on each poll so a slow gossip cycle on a loaded CI runner still converges
    // (a single up-front trigger raced the injection and made this test flaky).
    // The probe records trigger failures so a persistent one is reported as itself
    // rather than as a bare timeout — see makeTriggerProbe.
    const triggerB = makeTriggerProbe(INSTANCES.b, tokenB, networkId, 'B');
    await waitFor(async () => {
      await triggerB();
      const rb = readConfig('ythril-b').networks.find(n => n.id === networkId)?.pendingRounds.find(r => r.roundId === roundId);
      const bCast = rb?.votes?.find(v => v.instanceId === instanceIdA);
      return bCast?.sig === aCast.sig;
    }, 90_000, 2_000, triggerB.diagnose);
  });

  it('peers pin each other\'s signing public keys via gossip', async () => {
    const triggerA = makeTriggerProbe(INSTANCES.a, tokenA, networkId, 'A');
    const triggerB = makeTriggerProbe(INSTANCES.b, tokenB, networkId, 'B');
    await waitFor(async () => {
      await triggerA();
      await triggerB();
      const aSeesB = readConfig('ythril-a').networks.find(n => n.id === networkId)?.members.find(m => m.instanceId === instanceIdB)?.signingPublicKey;
      const bSeesA = readConfig('ythril-b').networks.find(n => n.id === networkId)?.members.find(m => m.instanceId === instanceIdA)?.signingPublicKey;
      return !!aSeesB && !!bSeesA;
    }, 90_000, 2_000, () => `${triggerA.diagnose()} | ${triggerB.diagnose()}`);
  });

  it('a VALID signed cast from a third instance is accepted when relayed by B; a tampered one is rejected', async () => {
    // Virtual third instance C with its own keypair, pinned as a member on A.
    const C = ed25519();
    const instanceIdC = `virt-c-${Date.now()}`;
    // Pin C via patchAndConfirm: a bare patch+reload can be reverted by a
    // concurrent saveConfig, leaving C un-pinned so A rejects its relayed cast
    // forever (the real flake). Confirming the patch stuck removes that race.
    await patchAndConfirm(
      'ythril-a', INSTANCES.a, tokenA, networkId,
      // Idempotent: upsert C so a re-patch (after a clobber) never duplicates it.
      `const c=${JSON.stringify(instanceIdC)};const ex=n.members.find(m=>m.instanceId===c);const rec={instanceId:c,label:'Virtual C',url:'http://virtual-c.internal:3200',tokenHash:'x',direction:'both',signingPublicKey:${JSON.stringify(C.pub)}};if(ex){Object.assign(ex,rec);}else{n.members.push(rec);}`,
      net => net.members.some(m => m.instanceId === instanceIdC && m.signingPublicKey === C.pub),
      `pin C on A`,
    );

    // Two rounds injected on B (which A will pull): one with a VALID C-signature,
    // one where the vote value was tampered after signing. Subject is a ghost id so
    // nothing is actually removed even if a round concluded.
    const validRid = `relay-ok-${Date.now()}`;
    const tamperRid = `relay-bad-${Date.now()}`;
    const ghost = 'ghost-subject';
    const validSig = signCast(C.priv, { networkId, roundId: validRid, subjectInstanceId: ghost, instanceId: instanceIdC, vote: 'yes' });
    const tamperSig = signCast(C.priv, { networkId, roundId: tamperRid, subjectInstanceId: ghost, instanceId: instanceIdC, vote: 'yes' });
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    const mkRound = (rid, vote, sig) => ({
      roundId: rid, type: 'remove', subjectInstanceId: ghost, subjectLabel: 'Ghost', subjectUrl: 'http://ghost.internal:3200',
      deadline, openedAt: new Date().toISOString(),
      votes: [{ instanceId: instanceIdC, vote, castAt: new Date().toISOString(), sig }],
    });
    // Same race applies to B's injected rounds — confirm they stuck before A pulls.
    await patchAndConfirm(
      'ythril-b', INSTANCES.b, tokenB, networkId,
      // Idempotent: only add each round if it is not already present.
      `n.pendingRounds=n.pendingRounds||[];const add=r=>{if(!n.pendingRounds.some(x=>x.roundId===r.roundId))n.pendingRounds.push(r);};add(${JSON.stringify(mkRound(validRid, 'yes', validSig))});add(${JSON.stringify(mkRound(tamperRid, 'veto', tamperSig))});`,
      net => (net.pendingRounds ?? []).some(r => r.roundId === validRid) && (net.pendingRounds ?? []).some(r => r.roundId === tamperRid),
      `inject rounds on B`,
    );

    // A pulls from B (relay). Re-trigger each poll so the relay converges even when a
    // loaded CI runner's gossip cycle lags; the window exits as soon as the relay
    // lands (seconds, once C is reliably pinned). The diagnose reports the two
    // things that would keep it from converging — C's pin on A and the round's
    // arrival — so a genuine failure explains itself instead of timing out blind.
    const triggerA = makeTriggerProbe(INSTANCES.a, tokenA, networkId, 'A');
    const diagnose = () => {
      const netA = readConfig('ythril-a').networks.find(n => n.id === networkId);
      const cPinned = netA?.members?.some(m => m.instanceId === instanceIdC && m.signingPublicKey === C.pub);
      const roundArrived = netA?.pendingRounds?.some(r => r.roundId === validRid);
      return `${triggerA.diagnose()} | C pinned on A: ${!!cPinned} | valid round arrived on A: ${!!roundArrived}`;
    };
    await waitFor(async () => {
      await triggerA();
      const nets = readConfig('ythril-a').networks.find(n => n.id === networkId);
      const ok = nets?.pendingRounds?.find(r => r.roundId === validRid);
      return ok?.votes?.some(v => v.instanceId === instanceIdC && v.vote === 'yes');
    }, 60_000, 2_000, diagnose);

    const netA = readConfig('ythril-a').networks.find(n => n.id === networkId);
    const validRound = netA.pendingRounds.find(r => r.roundId === validRid);
    assert.ok(
      validRound?.votes?.some(v => v.instanceId === instanceIdC && v.sig === validSig),
      'A must accept C\'s validly-signed cast relayed by B (safe multi-hop relay)',
    );
    const tamperRound = netA.pendingRounds.find(r => r.roundId === tamperRid);
    if (tamperRound) {
      assert.ok(
        !tamperRound.votes?.some(v => v.instanceId === instanceIdC),
        'A must reject a tampered (vote value != signed value) relayed cast',
      );
    }
  });
});
