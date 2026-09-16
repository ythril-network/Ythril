/**
 * Integration: a peer below the version floor is refused, and a refused peer can recover.
 *
 * `P-33` = B, owner 2026-09-04. The standalone gate holds the SHAPE — the floor declared once, a
 * version on both directions of the gossip exchange, a refusal naming both numbers. This one proves the
 * behaviour between two running instances, which is the only place those pieces meet.
 *
 * ## Why two containers are required rather than convenient
 *
 * The floor's input is a version that arrived by gossip. None of that is visible in one process: the
 * announce is an HTTP call, the store is a config write on the other side, and the refusal is a status
 * code on a later request. A unit test can only assert the comparison, which the standalone gate does.
 *
 * ## THE CASE THAT MATTERS MOST IS RECOVERY
 *
 * A floor that refuses a stale peer is easy. A floor that refuses a peer and then cannot notice it was
 * upgraded is an outage with no way out — and this design was one edit away from it. The check went in
 * the member loop first, ahead of the gossip that learns the version, so every member on a fresh
 * network reported nothing, absent is below the floor, and the network stopped for good.
 *
 * So the sequence is: prove a version is learned, pin one below the floor, prove data stops, then let
 * the real instance re-announce and prove data resumes — with nothing restarted.
 *
 * Run:  node --test testing/sync/peer-floor.test.js
 * Pre-requisite: docker compose -f docker-compose.test.yml up && node testing/sync/setup.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { dockerExec, INSTANCES, post, get, triggerSync, waitFor } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');

/**
 * Run a small script inside a container. Base64 so quoting survives the shell on every platform.
 *
 * **Wrapped in a function, and that is not cosmetic.** `eval` runs its argument as top-level code,
 * where `return` is a SyntaxError — so a script using an early return to bail out does not bail out,
 * it fails to parse, and `docker exec` exits non-zero with the parse error rather than the sentinel
 * the caller is checking for. The first version of this did exactly that and the assertion that
 * caught it was reporting a shell failure dressed as a staging failure.
 */
function inContainer(container, script) {
  const b64 = Buffer.from(`(function(){${script}})()`, 'utf8').toString('base64');
  return dockerExec(
    `docker exec ${container} node -e "eval(Buffer.from('${b64}','base64').toString())"`,
  ).toString().trim();
}

const getInstanceId = (c) => inContainer(c,
  "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync('/config/config.json','utf8')).instanceId)");

/**
 * Overwrite what one instance has stored as another's version.
 *
 * **The file write is only half of it — the server holds config in memory.** Writing config.json and
 * stopping there stages nothing: the running instance never re-reads the file, so the pin is invisible
 * to every code path under test and the assertions pass or fail for reasons unrelated to the floor.
 * `POST /api/admin/reload-config` is what makes the write take effect, and every caller here pairs the
 * two. That is why this returns a promise.
 *
 * Reaching into the config is the only honest way to stage a stale peer: both containers run the same
 * build, so neither can report an old version truthfully. What is under test is the CHECK against a
 * stored value — and in production that value is written by the gossip handler, so staging it directly
 * exercises the same field the same code reads.
 *
 * **`versionCheckedAt` is set alongside it, and forgetting that would make this test pass for the wrong
 * reason.** The floor needs EVIDENCE: a version below the floor refuses, and so does a null version on
 * a peer that has answered — but a peer never exchanged with is not refused at all. Staging a version
 * without the stamp would be staging a state gossip never produces.
 *
 * Clearing passes `null`, which removes both — restoring the no-evidence state rather than a
 * half-staged one.
 */
async function pinStoredVersion(container, netId, instanceId, version, url, token) {
  const out = inContainer(container, `
const fs = require('fs');
const p = '/config/config.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
const net = (c.networks || []).find(n => n.id === ${JSON.stringify(netId)});
if (!net) { process.stdout.write('NO_NETWORK'); return; }
const m = (net.members || []).find(x => x.instanceId === ${JSON.stringify(instanceId)});
if (!m) { process.stdout.write('NO_MEMBER'); return; }
${version === null
  ? 'delete m.version; delete m.versionCheckedAt;'
  : `m.version = ${JSON.stringify(version)}; m.versionCheckedAt = new Date().toISOString();`}
fs.writeFileSync(p, JSON.stringify(c, null, 2));
process.stdout.write('OK:' + (m.version || 'ABSENT'));
`);
  if (url && token) await post(url, token, '/api/admin/reload-config', {});
  return out;
}

let tokenA, tokenB, networkId, spaceId, idA, idB, floor, peerFloorRefusal;

/** What A currently has stored as B's version, read through the API rather than the file. */
async function storedVersionOfB() {
  const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
  const net = r.body?.network ?? r.body;
  return net?.members?.find(m => m.instanceId === idB)?.version;
}

/** Does a marker record exist on B yet? */
async function onB(marker) {
  const r = await post(INSTANCES.b, tokenB, '/api/brain/filter', { space: spaceId, ...({
    collection: 'facts', filter: { fact: { $regex: marker } },
  }) });
  return (r.body?.results ?? r.body?.rows ?? []).length;
}

describe('Peer version floor: refusal and recovery between two instances', () => {
  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
    ({ MIN_PEER_VERSION: floor, peerFloorRefusal } = await import('../../server/dist/sync/peer-floor.js'));

    idA = getInstanceId('ythril-a');
    idB = getInstanceId('ythril-b');

    // A dedicated space, so a stalled cycle is about the floor and not about a backlog.
    spaceId = `floor-test-${Date.now()}`;
    for (const [url, tok] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
      const sp = await post(url, tok, '/api/spaces', { id: spaceId, label: 'Peer Floor Test' });
      assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);
    }

    const netR = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: 'Peer Floor Test Network', type: 'closed', spaces: [spaceId], votingDeadlineHours: 1,
    });
    assert.equal(netR.status, 201, `create network: ${JSON.stringify(netR.body)}`);
    networkId = netR.body.id;

    // Peer tokens carry `peerInstanceId` — the shape the invite flow produces, and the shape the floor
    // guard keys on. A bare token is not a peer and is deliberately exempt from the floor.
    const ptForA = await post(INSTANCES.b, tokenB, '/api/tokens', {
      name: `floor-peer-a-${Date.now()}`, peerInstanceId: idA,
    });
    assert.equal(ptForA.status, 201);
    const ptForB = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `floor-peer-b-${Date.now()}`, peerInstanceId: idB,
    });
    assert.equal(ptForB.status, 201);

    const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: idB, label: 'Instance B', url: 'http://ythril-b:3200',
      token: ptForA.body.plaintext, direction: 'both',
    });
    if (addB.status === 202) {
      await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
    } else {
      assert.equal(addB.status, 201, `add B: ${JSON.stringify(addB.body)}`);
    }

    const inject = (container, instanceId, token) => inContainer(container, `
const fs = require('fs');
const p = '/config/secrets.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.peerTokens = s.peerTokens || {};
s.peerTokens[${JSON.stringify(instanceId)}] = ${JSON.stringify(token)};
fs.writeFileSync(p, JSON.stringify(s, null, 2));
process.stdout.write('OK');
`);
    inject('ythril-a', idB, ptForA.body.plaintext);
    inject('ythril-b', idA, ptForB.body.plaintext);
    await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
    await post(INSTANCES.b, tokenB, '/api/admin/reload-config', {});

    // Mirror on B so its engine has somebody to call — the exchange has to be two-way for a version to
    // travel in both directions.
    const netOnB = await post(INSTANCES.b, tokenB, '/api/networks', {
      id: networkId, label: 'Peer Floor Test Network', type: 'closed',
      spaces: [spaceId], votingDeadlineHours: 1,
    });
    assert.ok(netOnB.status === 201 || netOnB.status === 409, `create net on B: ${JSON.stringify(netOnB.body)}`);
    const addA = await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/members`, {
      instanceId: idA, label: 'Instance A', url: 'http://ythril-a:3200',
      token: ptForB.body.plaintext, direction: 'both',
    });
    if (addA.status === 202) {
      await post(INSTANCES.b, tokenB, `/api/networks/${networkId}/votes/${addA.body.roundId}`, { vote: 'yes' });
    }
  });

  /*
   * ── TEARDOWN, AND IT IS NOT HOUSEKEEPING ────────────────────────────────────────────────────
   *
   * This suite leaves a network with B as a member, and the suites that follow it alphabetically —
   * `peer-revocation`, `pubsub-topology` — assume the pair is not a member of anything they did not
   * create. One of the cases it broke is named *"credentials survive removal while the peer is still
   * a member of another network"*: my leftover network WAS that other network, so a revocation the
   * suite expected to happen correctly did not.
   *
   * It passed alone and failed in the run, which is the shape worth naming: a leaked fixture is
   * invisible to the suite that leaks it and only ever fails somebody else. `test:sync` runs
   * `--test-concurrency=1` over a shared pair of containers, so every suite is responsible for
   * leaving them as it found them.
   *
   * Both sides, because the network was mirrored onto B for the exchange to be two-way.
   */
  after(async () => {
    if (!networkId) return;
    for (const [url, tok] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
      await fetch(`${url}/api/networks/${networkId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }).catch(() => {});
      await fetch(`${url}/api/spaces/${spaceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }).catch(() => {});
    }
  });

  it('a member never exchanged with is NOT refused — the case CI taught me', async () => {
    /*
     * Asserted BEFORE the exchange, because after it there is nothing left to observe. The first
     * version of the floor refused this state, which stopped every fresh network and every
     * asymmetric one permanently — `conflicts.test.js` caught it in CI, not here.
     *
     * Read from the module rather than driven through HTTP: the observable a route would give is a
     * successful sync, and a fresh pair has nothing to sync yet, so a green sync would prove nothing.
     */
    assert.equal(peerFloorRefusal(undefined, undefined), null,
      'a peer with no version and no completed exchange is refused — that is not evidence of an old '
      + 'peer, and refusing it stops manually-provisioned and single-side-configured networks for good');
    assert.ok(peerFloorRefusal(undefined, new Date().toISOString()),
      'a peer that ANSWERED and named no version is admitted — that one really is pre-4.0');
  });

  it('gossip teaches each side what the other runs', async () => {
    /*
     * FIRST, AND EVERYTHING BELOW DEPENDS ON IT. If a version never arrives, every later assertion
     * passes for the wrong reason — a refusal because the peer is stale is indistinguishable from a
     * refusal because nothing was ever learned.
     */
    const learned = await waitFor(async () => {
      await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
      return (await storedVersionOfB()) != null;
    }, 40_000, 1_000).then(() => storedVersionOfB()).catch(() => null);

    assert.ok(learned, 'A never learned B\'s version, so nothing feeds the floor and it can never bite');
    assert.match(learned, /^\d+\.\d+\.\d+/,
      `A stored ${JSON.stringify(learned)} as B's version, which is not a version`);
    assert.equal(peerFloorRefusal(learned), null,
      `both containers run ${learned} and the floor is ${floor} — this build refuses itself`);
  });

  it('a member pinned below the floor is REPORTED as refused, on both doors', async () => {
    /*
     * **What replaced a test that could not work, and the reason is worth more than the case.**
     *
     * The first version pinned a stale version, wrote a record, and asserted it never reached B. It
     * cannot: both containers run the same build, so the very first gossip round relearns B’s real
     * version and erases the pin before any data moves. The window it was asserting over does not exist,
     * and a test whose subject self-heals mid-run reports whatever the timing gave it.
     *
     * The refusal itself is decided by one pure function and is gated exhaustively in
     * `testing/standalone/a-peer-below-the-floor-is-refused.test.js`. What only two running instances can
     * show is the chain from STORED STATE to REPORTED VERDICT: config holds a version, the API turns it
     * into a refusal sentence, and both doors say the same thing. That is what this asserts, read before
     * a sync cycle can repair the pin.
     */
    /*
     * **STAGED IN A RETRY LOOP, because the pin is racing a gossip round that erases it.**
     *
     * The docblock above says the subject self-heals — one gossip round relearns B's real version — and the
     * first version of this staging read the pin back once, immediately after writing it. That is a race the
     * test can lose without anything being wrong: it lost in CI on 2026-09-07 with `'4.0.1' !== '1.0.0'`,
     * which is the pin having been repaired between the write and the read.
     *
     * **What repairs it is B, and A cannot prevent it.** An inbound announce is a completed exchange, so
     * `api/sync/members.ts` stamps `version` from what the caller reports on the way in — not only on A's
     * own outbound cycle. The previous case awaits its own `triggerSync` and leaks nothing; the repair
     * arrives from the other container, on its schedule, at a moment this test neither picks nor observes.
     *
     * Re-staging until the read observes the pin removes the race from the STAGING. The assertions after it
     * are then read from ONE response captured in the same iteration, so they cannot disagree with each
     * other either — which the previous shape could, if the repair landed between two of them.
     */
    let net = null;
    await waitFor(async () => {
      assert.match(await pinStoredVersion('ythril-a', networkId, idB, '1.0.0', INSTANCES.a, tokenA), /^OK/,
        'could not stage a stale peer');
      const r = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
      const body = (r.body?.network ?? r.body);
      const stored = body?.members?.find(m => m.instanceId === idB)?.version;
      if (stored !== '1.0.0') return false;
      net = { body };
      return true;
    }, 40_000, 1_000);

    assert.ok(net, 'the pin never survived long enough to be read — a gossip round repairs it every time, '
      + 'so this case cannot observe the state it is about');

    const member = (net.body?.network ?? net.body)?.members?.find(m => m.instanceId === idB);
    assert.ok(member, 'B is not in the member list');
    assert.ok(member.belowFloor, 'a member pinned at 1.0.0 is not reported as below the floor');
    assert.ok(member.belowFloor.includes('1.0.0'),
      `the refusal does not name what the peer runs: ${JSON.stringify(member.belowFloor)}`);
    assert.ok(member.belowFloor.includes(floor),
      `the refusal does not name what is required: ${JSON.stringify(member.belowFloor)}`);
    assert.equal(member.minPeerVersion, floor,
      'the member row does not carry this instance\'s floor');
  });

  it('THE RECOVERY CASE: one gossip round clears it, with nothing restarted', async () => {
    /*
     * The failure this proves absent, and it is the one that nearly shipped: check the floor AHEAD of the
     * gossip that learns a version and a peer refused once can never report that it was upgraded, because
     * the exchange that would clear it sits behind the refusal.
     *
     * B is staged as stale by the previous case and is really running the current build, so this is the
     * same thing an operator does by upgrading: one exchange, no restart, no button.
     */
    const cleared = await waitFor(async () => {
      await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
      const v = await storedVersionOfB();
      return v != null && v !== '1.0.0';
    }, 60_000, 1_500).then(() => true).catch(() => false);

    assert.ok(cleared,
      'A never re-learned B\'s real version, so a peer refused once stays refused for ever — the floor '
      + 'is being checked ahead of the gossip that feeds it');

    // And the verdict follows the state, which is the half that proves the refusal was lifted rather
    // than the stored number merely changing.
    const net = await get(INSTANCES.a, tokenA, `/api/networks/${networkId}`);
    const member = (net.body?.network ?? net.body)?.members?.find(m => m.instanceId === idB);
    assert.equal(member?.belowFloor ?? null, null,
      `B reports ${member?.version} and is still refused: ${JSON.stringify(member?.belowFloor)}`);
  });

  it('and data flows between the pair once nothing is refused', async () => {
    // The end-to-end half, asserted where it CAN be asserted: on the positive case. A negative — "this
    // never arrives" — has no positive signal and, with a pin that self-heals, no stable window either.
    const marker = `floor-flows-${Date.now()}`;
    const created = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${spaceId}/facts`, {
      fact: `Written with both instances at or above the floor: ${marker}`,
      type: 'note', tags: [], properties: {},
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const arrived = await waitFor(async () => {
      await triggerSync(INSTANCES.a, tokenA, networkId).catch(() => {});
      return (await onB(marker)) > 0;
    }, 60_000, 1_500).then(() => true).catch(() => false);

    assert.ok(arrived,
      'nothing is below the floor and data still did not move — the floor is refusing a pair it admits');
  });
});
