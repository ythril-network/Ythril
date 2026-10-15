/**
 * Every sync door a peer reaches a space through answers `423 space_held` while the space is held for that peer, stores and serves nothing, and answers as ever
 * once the hold is lifted - an admin token is not an exchange, and the schema door is reach-only (bundle-106, §3.3 doors, R6-f, R-X2g, R-X17b).
 *
 * ## What was true before
 *
 * The data loop held nothing for a member whose cycle ran on an older release, or whose vote pull failed: it pushed pre-wipe records INTO a wiped instance and
 * pulled FROM it through doors that asked only `spaceAllowed`. The hold had to be symmetric and had to live in the doors, because a request comes from a
 * peer the instance does not control.
 *
 * ## What holds now
 *
 * - **R6-f** every route of the sync routers that takes a space - DERIVED from the routers' own stacks, never listed - answers a peer's request for a held space
 *   `423` with `code: 'space_held'`; the push doors store nothing; the refusal counter moves; the space that is not held is answered as ever (the control, same
 *   token, same cycle), and so is the held one once the peer's conclusion is recorded (the lift). An instance-admin token reading the space is not refused: it is
 *   the operator's own tooling, not the exchange.
 * - **R-X17b** the schema door (`GET /meta`) is REACH only: a wipe changes no schema and a subscriber takes type schemas through it, so it answers `200` for a held
 *   space - beside its positive twin, a document door for the same space, which answers `423`.
 * - **R-X2g** a peer whose request was admitted before an act registered and whose next chunk meets the writer's refusal is answered `423 space_held`, never `409`:
 *   `refusePeerWrite(res, err, token)` is the one place that answers it, a peer token gets the hold and an admin token does not.
 *
 * ## How it is driven
 *
 * The routers' own handlers over a real Mongo layer (`openPullDoor` supplies the config and the spaces; no fake peer is dialled here). The held state is a passed,
 * applied wipe round of the space on this instance with no evidence that the peer concluded it.
 *
 * ## Seen red
 *
 * At a638e702 no door asks a hold: the derived-doors case lists every door that answered something else, the counter case sees no counter, and R-X2g fails for the
 * missing `refusePeerWrite`. The control and lift rows are cases that pass on purpose. After the fix, by hand: drop the hold call from `pushAllowed` -> the push doors
 * are listed; hold `meta.ts` through `refusePeerSpace` -> R-X17b red.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peer-meets-a-held-space-on-every-sync-door-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { callRoute, counterTotal } from './_vote-round-instance.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const HELD = 'inboundheld';
const FREE = 'inboundfree';
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
/** The derived doors must number at least the document, tombstone and manifest routes the routers register: an empty derivation passes every loop. */
const DOOR_FLOOR = 20;

let door, loader, routers;

const wipeRound = (over = {}) => ({
  roundId: 'in-w', type: 'space_wipe', spaceId: HELD, subjectInstanceId: door.instanceId, subjectLabel: 'x', subjectUrl: '',
  openedAt: iso(NOW - HOUR), deadline: iso(NOW + 23 * HOUR), votes: [{ instanceId: door.instanceId, vote: 'yes', castAt: iso(NOW - HOUR) }],
  concluded: true, passed: true, appliedHere: true, proposedHere: true, ...over,
});
const setRounds = (rounds) => loader.mutateConfig((cfg) => { cfg.networks.find(n => n.id === door.NET).pendingRounds = rounds.map(r => structuredClone(r)); });

/** Every route of the routers that carries a space (`/meta` is the reach-only one and is asked separately). */
function doors() {
  const out = [];
  for (const [name, router] of Object.entries(routers)) {
    if (name === 'meta') continue;
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) out.push({ router, name, method, path: layer.route.path, label: `${method.toUpperCase()} ${layer.route.path}` });
    }
  }
  return out;
}

async function ask(d, space, token) {
  const req = {
    params: { id: 'nothing' },
    query: { spaceId: space, networkId: door.NET, full: 'true', sinceSeq: '0', limit: '10' },
    body: { spaceId: space, networkId: door.NET, tombstones: [], facts: [build.fact(space, 'inbound-f1', 7)] },
    authToken: token,
  };
  try {
    const { code, body } = await callRoute(d.router, d.method, d.path, req);
    return { code, body };
  } catch (err) {
    return { code: -1, body: { error: String(err) } };
  }
}
const isHeld = (r) => r.code === 423 && r.body?.code === 'space_held';

describe('a held space meets a peer on every sync door with 423', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'inbound', spaces: [HELD, FREE], type: 'club', direction: 'both', files: true });
    loader = await import('../../server/dist/config/loader.js');
    routers = {
      docs: (await import('../../server/dist/api/sync/docs.js')).syncDocsRouter,
      tombstones: (await import('../../server/dist/api/sync/tombstones.js')).syncTombstonesRouter,
      manifest: (await import('../../server/dist/api/sync/manifest.js')).syncManifestRouter,
      meta: (await import('../../server/dist/api/sync/meta.js')).syncMetaRouter,
    };
  });
  after(async () => { await door?.close(); });

  beforeEach(async () => {
    await door.reset();
    loader.mutateConfig((cfg) => {
      const net = cfg.networks.find(n => n.id === door.NET);
      net.pendingRounds = []; net.spaces = [HELD, FREE];
      delete cfg.pendingSpaceActs;
    });
    setRounds([wipeRound()]);
  });

  it('the derivation found the doors, at or above the floor', () => {
    const found = doors();
    assert.ok(found.length >= DOOR_FLOOR, `only ${found.length} sync route(s) found (floor ${DOOR_FLOOR}): ${found.map(d => d.label).join(', ')}`);
  });

  it('R6-f: every door answers a peer 423 space_held for the held space, stores nothing, and counts the refusal', async () => {
    const before = await counterTotal('ythril_space_held_refusals_total');
    const peer = peerToken(PEER);
    const answers = [];
    for (const d of doors()) answers.push({ d, r: await ask(d, HELD, peer) });
    const notHeld = answers.filter(a => !isHeld(a.r)).map(a => `${a.d.label} -> ${a.r.code} ${JSON.stringify(a.r.body).slice(0, 80)}`);
    assert.deepEqual(notHeld, [], 'these doors let a peer reach a space whose wipe only this side has applied:\n  ' + notHeld.join('\n  '));
    assert.equal(await door.coll(HELD, 'facts').findOne({ _id: 'inbound-f1' }), null, 'a push into a held space was stored');
    const after = await counterTotal('ythril_space_held_refusals_total');
    assert.ok(after - before >= answers.length, `ythril_space_held_refusals_total moved by ${after - before} for ${answers.length} refusals`);
  });

  it('R6-f control: the same token on the same doors is not refused for the space that is not held', async () => {
    const peer = peerToken(PEER);
    const refused = [];
    for (const d of doors()) { const r = await ask(d, FREE, peer); if (isHeld(r)) refused.push(d.label); }
    assert.deepEqual(refused, [], 'a space nothing holds was answered 423 space_held');
  });

  it('R6-f lift: once the peer\'s conclusion is recorded, no door answers 423 any more', async () => {
    setRounds([wipeRound({ peersConcluded: [PEER] })]);
    const peer = peerToken(PEER);
    const refused = [];
    for (const d of doors()) { const r = await ask(d, HELD, peer); if (isHeld(r)) refused.push(d.label); }
    assert.deepEqual(refused, [], 'the hold did not lift when the peer\'s completed conclusion was on the round');
  });

  it('R6-f: an instance-admin token reading the held space is not refused', async () => {
    const reads = doors().filter(d => d.method === 'get');
    assert.ok(reads.length >= 10, 'the read doors were not derived');
    const refused = [];
    for (const d of reads) { const r = await ask(d, HELD, ADMIN_TOKEN); if (isHeld(r)) refused.push(d.label); }
    assert.deepEqual(refused, [], 'an operator\'s own token was held as if it were the exchange');
  });

  it('R-X17b: the schema door is reach only - 200 for a held space - beside its twin, a document door, 423', async () => {
    const peer = peerToken(PEER);
    const docs = await ask({ router: routers.docs, method: 'get', path: '/facts' }, HELD, peer);
    assert.ok(isHeld(docs), `the twin failed: the document door did not hold the space (${docs.code}), so the schema door's 200 proves nothing`);
    const meta = await ask({ router: routers.meta, method: 'get', path: '/meta' }, HELD, peer);
    assert.equal(meta.code, 200, `the schema door answered ${meta.code} ${JSON.stringify(meta.body)} for a held space: a subscriber's type schemas would wait out the whole hold`);
  });

  it('R-X2g: a peer\'s write that meets the writer\'s refusal is answered 423 space_held, never 409; an admin token is not', async () => {
    const shared = await import('../../server/dist/api/sync/_shared.js');
    assert.equal(typeof shared.refusePeerWrite, 'function', 'api/sync/_shared.ts has no refusePeerWrite: a peer admitted before an act registered meets 409 on its next chunk, and the sender reads it as a failed transfer');
    const { SpaceNotWritableError } = await import('../../server/dist/spaces/space-write-gate.js');
    const refusal = new SpaceNotWritableError(HELD, 'it is being wiped');
    const answer = (token) => {
      const res = { code: 200, body: undefined, sent: false, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.sent = true; return this; }, setHeader() { return this; } };
      return { handled: shared.refusePeerWrite(res, refusal, token), code: res.code, body: res.body };
    };
    const forPeer = answer(peerToken(PEER));
    assert.equal(forPeer.handled, true);
    assert.equal(forPeer.code, 423, 'a peer was answered something other than 423 for a write the closure refused');
    assert.equal(forPeer.body?.code, 'space_held');
    assert.equal(answer(ADMIN_TOKEN).handled, false, 'an instance-admin token\'s push was answered by the peer path: it must reach the writer\'s own 409');
  });

  it('R-X2g driven: with an act standing for the space, a peer\'s push is 423 space_held and nothing lands', async () => {
    loader.mutateConfig((cfg) => {
      cfg.pendingSpaceActs = [{ id: 'act-1', kind: 'wipe', localId: HELD, rounds: [], postSteps: {}, registeredAt: iso(NOW), state: 'registered', attempts: 0 }];
      cfg.networks.find(n => n.id === door.NET).pendingRounds = [];
    });
    const r = await door.push('/batch-upsert', { facts: [build.fact(HELD, 'inbound-f2', 9)] }, { spaceId: HELD, networkId: door.NET, token: peerToken(PEER) });
    assert.equal(r.code, 423, `a peer's push into a space with a standing act was answered ${r.code} ${JSON.stringify(r.body).slice(0, 120)}`);
    assert.equal(r.body?.code, 'space_held');
    assert.equal(await door.coll(HELD, 'facts').findOne({ _id: 'inbound-f2' }), null, 'the push landed under a standing act');
  });
});
