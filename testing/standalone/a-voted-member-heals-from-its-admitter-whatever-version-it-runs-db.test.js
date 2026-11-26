/**
 * A member of a voted network heals from its admitter under mixed versions, in a network stored before 5.2 and after its admitter left (`Q-966`,
 * second review N1, N2, N3, N4, N7 and the lens sweep).
 *
 * ## What each case pins
 *
 * - N1: an answer without `networkSeeded` (an older admitter's bare meta) may be stored but never marks the space seeded, so the heal asks
 *   again; the mark is set only by an answer that says `networkSeeded: true`.
 * - N2: a member whose `admittedVia` names a member that has left the network heals from the first member.
 * - N3: a member with no `origin` and no `admittedVia` (a network stored before 5.2) that owns definitions from a passed round still heals;
 *   owning definitions never proves it created the network. A member with `origin: 'created'` is never asked.
 * - N4: an accepted pending space is stored with the schema it waited with and left unseeded, so the heal takes the current one from the admitter.
 * - N7: a layer a passed round wrote while the heal's fetch was in flight is not overwritten by the older answer.
 * - F3 (lens): only the first member is asked; a second member that is seeded and answers is not.
 *
 * The admitter is the pull door's fake peer (an HTTP listener on the host's private address); the instance is the real config over a real Mongo.
 * The heal is `pullNetworkSchema`, the call the sync engine makes for each space of each member.
 *
 * Run: a Mongo the harness accepts and a non-loopback address, then
 *      node --test testing/standalone/a-voted-member-heals-from-its-admitter-whatever-version-it-runs-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { ADMIN_TOKEN } from './_push-door.mjs';
import { listenOnPrivateAddress } from '../_shared/local-server.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'heal';
const FULL = { validationMode: 'strict', typeSchemas: { entity: { person: { propertySchemas: { tier: { type: 'number' } } } } } };
const BARE = { purpose: 'a bare meta from a member that has not healed' };
const opts = () => ({ headers: { Authorization: 'Bearer t' } });

let door, loader, pull, acts;

const net = () => loader.getConfig().networks.find(n => n.id === door.NET);
const layerOf = (space = S) => net().schemaLayers?.[space];
const markOf = (space = S) => net().schemaLayerSeeded?.[space];
const asked = () => door.state.metaRequests.length;
const serve = (body) => { door.state.meta = (_req, res) => { res.json(body); }; };
const whole = () => serve({ meta: FULL, network: FULL, networkSeeded: true });
/** The heal as the engine runs it, for `memberId` (the fake peer by default). */
const heal = (memberId = PEER, space = S, remote = S) => pull.pullNetworkSchema(net(), net().members.find(m => m.instanceId === memberId), space, remote, opts);

describe('a voted member heals from its admitter', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'q966heal', spaces: [S], type: 'closed' });
    loader = await import('../../server/dist/config/loader.js');
    pull = await import('../../server/dist/sync/space-meta-pull.js');
    acts = await import('../../server/dist/networks/network-acts.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    const n = net();
    delete n.origin; delete n.admittedVia; delete n.schemaLayerSeeded; delete n.schemaLayers; delete n.pendingSpaces;
    n.members = n.members.filter(m => m.instanceId === PEER);
    const sp = loader.getConfig().spaces.find(s => s.id === S);
    sp.meta = {}; delete sp.ownMeta;
    door.state.meta = null;
    door.state.metaRequests.length = 0;
  });

  it('N1: an answer without networkSeeded leaves the space unseeded, and the space heals once the admitter says true', async () => {
    serve({ meta: BARE });
    await heal();
    assert.equal(asked(), 1, 'the admitter was not asked');
    assert.equal(markOf(), undefined, 'an older admitter\'s bare meta marked the space seeded for good');
    whole();
    await heal();
    assert.equal(asked(), 2, 'the heal never asked the admitter again');
    assert.equal(layerOf()?.validationMode, 'strict', 'the network\'s whole schema was not taken once the admitter answered true');
    assert.equal(markOf(), 'layer');
    await heal();
    assert.equal(asked(), 2, 'a seeded space was asked again');
  });

  it('N1: an admitter that answers networkSeeded false is not taken from and not marked', async () => {
    serve({ meta: BARE, network: BARE, networkSeeded: false });
    await heal();
    assert.equal(asked(), 1);
    assert.equal(layerOf(), undefined, 'a layer from a member that says it has not healed was stored');
    assert.equal(markOf(), undefined);
  });

  it('N2: a member whose admitter has left the network heals from the first member', async () => {
    net().admittedVia = 'a-member-that-has-left';
    whole();
    await heal();
    assert.equal(asked(), 1, 'a member whose admitter left never asked anybody');
    assert.equal(layerOf()?.validationMode, 'strict');
    assert.equal(markOf(), 'layer');
  });

  it('N3: a member with no origin and no admitter that owns definitions from a passed round still heals', async () => {
    const sp = loader.getConfig().spaces.find(s => s.id === S);
    sp.ownMeta = { purpose: 'fields a passed round wrote' };
    sp.meta = { purpose: 'fields a passed round wrote' };
    whole();
    await heal();
    assert.equal(asked(), 1, 'a pre-5.2 joiner that proposed a change was read as the creator and never asked');
    assert.equal(layerOf()?.validationMode, 'strict');
    assert.equal(markOf(), 'layer');
  });

  it('N3: a member that created the network is never asked, however long the window', async () => {
    net().origin = 'created';
    whole();
    for (let i = 0; i < 3; i++) await heal();
    assert.equal(asked(), 0, 'the creator asked a member for the network\'s schema');
    assert.equal(layerOf(), undefined);
    // The control: the same door, the same answer, asked by a member that did not create the network.
    net().origin = 'joined';
    await heal();
    assert.equal(asked(), 1, 'the door never answered, so the absence above proves nothing');
  });

  it('N4: an accepted pending space whose schema changed while it waited ends with the current schema', async () => {
    net().pendingSpaces = [{ networkId: 'pend-remote', localId: 'pend', why: 'held', from: 'test', at: new Date().toISOString(), meta: BARE }];
    const res = await acts.resolvePendingSpaceAct(ADMIN_TOKEN, door.NET, { spaceId: 'pend-remote', action: 'accept' });
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.equal(layerOf('pend')?.purpose, BARE.purpose, 'the schema the space waited with was not kept as its layer');
    assert.equal(markOf('pend'), undefined, 'a schema that waited was marked as the network\'s current whole one');
    whole();
    await heal(PEER, 'pend', 'pend-remote');
    assert.equal(layerOf('pend')?.validationMode, 'strict', 'the accepted space kept the schema it waited with');
    assert.equal(markOf('pend'), 'layer');
  });

  it('N7: a layer a round wrote while the fetch was in flight is not overwritten by the older answer', async () => {
    const roundApplied = { purpose: 'a passed round applied while the heal was asking' };
    door.state.meta = (_req, res) => {
      (net().schemaLayers ??= {})[S] = roundApplied;
      res.json({ meta: FULL, network: FULL, networkSeeded: true });
    };
    await heal();
    assert.equal(asked(), 1);
    assert.deepEqual(layerOf(), roundApplied, 'the answer that was in flight overwrote what a passed round wrote meanwhile');
    assert.equal(markOf(), undefined, 'a layer that was not stored was marked');
    whole();
    await heal();
    assert.equal(layerOf()?.validationMode, 'strict', 'the heal did not converge once nothing changed under it');
    assert.equal(markOf(), 'layer');
  });

  describe('F3: only the first member is asked', () => {
    let decoy;
    let decoyHits = 0;
    before(async () => {
      decoy = await listenOnPrivateAddress(http.createServer((_req, res) => {
        decoyHits += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ meta: { purpose: 'a decoy' }, network: { purpose: 'a decoy' }, networkSeeded: true }));
      }), privateHostAddress());
    });
    after(async () => { await decoy?.close(); });

    it('takes nothing from a second member that is seeded and answers, while the first member does not', async () => {
      decoyHits = 0;
      net().members.push({ instanceId: 'decoy-c', label: 'C', url: decoy.url, tokenHash: 'x', direction: 'both' });
      door.state.meta = (_req, res) => { res.status(503).json({ error: 'busy' }); };
      await heal(PEER);
      await heal('decoy-c');
      assert.equal(decoyHits, 0, 'a member that is not the first was asked for the network\'s schema');
      assert.equal(layerOf(), undefined, 'a decoy layer from a member that is not the first was stored');
      whole();
      await heal(PEER);
      await heal('decoy-c');
      assert.equal(layerOf()?.validationMode, 'strict', 'the first member did not heal the space');
      assert.equal(decoyHits, 0);
    });
  });
});
