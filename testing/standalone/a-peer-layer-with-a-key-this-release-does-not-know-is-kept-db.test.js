/**
 * A peer's schema layer that carries a key this release does not know is KEPT for what it knows and REPORTED for what it does
 * not — never refused whole (`R6-7`, the tolerant reader).
 *
 * ## The rule
 *
 * A space's schema travels: a subscriber takes the meta its upstream serves (`GET /api/sync/meta`) and keeps it as that network's
 * layer. Today the meta is parsed by a strict body, so ONE key the receiver has never heard of (a newer peer's `stampSkew` or
 * `rules`, a rolled-back build's leftovers) refuses the whole meta: the subscriber loses the purpose, the usage notes and every
 * type the peer sent, for one name, and says so only in a log line the peer never reads. From this release a receiver is a
 * tolerant reader: it keeps every meta key and type field it knows, and names the ones it does not on `space_schema_layers`
 * (`layers[].unknownFields`, names only, bounded), so an operator can see that a layer is partly unread and why.
 *
 * ## What each case pins
 *
 *  - the CONTROL: a peer meta of known keys only is stored as the layer, and the fake peer's `/api/sync/meta` was asked for it
 *    (the hit counter). Without it, every case below could pass by the pull never reaching the route;
 *  - a peer meta with an unknown top-level key AND an unknown field on a type: the known keys land in the layer, the layer is
 *    the space's effective schema for them, and `unknownFields` names both unknowns (the type field by its path) — read on the
 *    act both doors answer from;
 *  - a key a hostile or broken peer chose, 100 000 characters long: the reported name is bounded, and so is the list, because
 *    what a peer chose is never echoed whole (`Q-362`'s rule for a name);
 *  - the pull no longer logs a "refused whole" line for a meta it kept in part.
 *
 * ## Seen red
 *
 * On 85c4c564 the unknown-key cases fail on the first assertion about the stored layer: `mergeReplicatedMeta` parses the whole
 * meta with the strict `SpaceMetaBody`, `acceptNetworkLayer` logs "refused whole, nothing merged" and stores nothing, so the layer
 * is absent. The control passes there (it is the route-was-hit and known-keys-stored half).
 *
 * Run: a Mongo the harness accepts and a non-loopback address, then
 *      node --test testing/standalone/a-peer-layer-with-a-key-this-release-does-not-know-is-kept-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tolerant';
let door, loader, acts;

/** What the upstream serves for the space: the answer a case scripts, as `GET /api/sync/meta` answers it. */
const serve = (meta) => { door.state.meta = (_req, res) => { res.json({ meta }); }; };

const layerOnThisInstance = () => loader.getConfig().networks.find(n => n.id === door.NET).schemaLayers?.[S];
const layersAnswer = () => {
  const r = acts.schemaLayersAct(S);
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.body;
};
const ownLayer = () => layersAnswer().layers.find(l => l.networkId === door.NET);

/** A sync cycle, and the wait for the pull to have been asked: a cycle that never reached the route proves nothing. */
async function pullOnce() {
  const before = door.state.metaRequests.length;
  const out = await door.logsDuring(() => door.sync());
  await waitFor(() => door.state.metaRequests.length > before, 10_000, 50, 'the fake peer was never asked for GET /api/sync/meta', { what: 'the pull reaching /api/sync/meta' });
  return out.lines;
}

describe('a peer layer with a key this release does not know', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tolerant', spaces: [S] });
    loader = await import('../../server/dist/config/loader.js');
    acts = await import('../../server/dist/spaces/schema-layers-acts.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('control: a meta of keys this release knows is stored as the layer, and the route was hit', async () => {
    serve({ purpose: 'from the publisher', validationMode: 'warn' });
    await pullOnce();
    assert.ok(door.state.metaRequests.length > 0, 'the fake peer was never asked for the meta — the cases below would prove nothing');
    assert.equal(door.state.metaRequests[0].spaceId, S, 'the pull asked for another space than the one the network carries');
    assert.equal(layerOnThisInstance()?.purpose, 'from the publisher', 'a meta of known keys is not stored as the layer');
    assert.equal(layerOnThisInstance()?.validationMode, 'warn');
    assert.deepEqual(ownLayer()?.unknownFields ?? [], [], 'a layer with nothing unknown reports something unknown');
  });

  it('an unknown meta key and an unknown type field: what is known is kept, what is not is named', async () => {
    serve({
      purpose: 'kept despite the stranger beside it',
      validationMode: 'warn',
      postReleaseMetaKey: { anything: true },
      typeSchemas: { entity: { person: {
        propertySchemas: { tier: { type: 'number' } },
        postReleaseTypeField: ['x'],
      } } },
    });
    const lines = await pullOnce();
    const layer = layerOnThisInstance();
    assert.ok(layer, 'the layer is absent: the whole meta was refused for the key it did not know');
    assert.equal(layer.purpose, 'kept despite the stranger beside it');
    assert.equal(layer.validationMode, 'warn');
    assert.deepEqual(layer.typeSchemas?.entity?.person?.propertySchemas?.tier, { type: 'number' }, 'a property of the known part of the type was lost');
    const effective = loader.getConfig().spaces.find(s => s.id === S).meta;
    assert.equal(effective.purpose, 'kept despite the stranger beside it', 'the kept part is not what the space runs on');
    assert.equal(effective.typeSchemas?.entity?.person?.propertySchemas?.tier?.type, 'number');

    const unknown = ownLayer()?.unknownFields;
    assert.ok(Array.isArray(unknown), `space_schema_layers carries no unknownFields for the layer: ${JSON.stringify(ownLayer())}`);
    assert.ok(unknown.includes('postReleaseMetaKey'), `the unknown meta key is not named: ${JSON.stringify(unknown)}`);
    assert.ok(unknown.some(u => u.includes('postReleaseTypeField') && u.includes('person')),
      `the unknown type field is not named with the type it sits on: ${JSON.stringify(unknown)}`);
    assert.ok(!unknown.includes('purpose') && !unknown.includes('validationMode'), 'a key this release knows is reported as unknown');
    assert.deepEqual(lines.filter(l => l.includes('refused whole')), [], 'the pull still logs that it refused a meta it kept in part');
  });

  it('a key a peer chose, 100 000 characters long, is named bounded — and so is the list', async () => {
    const hugeKey = `k${'x'.repeat(100_000)}`;
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`unknownKey${i}`, i]));
    serve({ purpose: 'kept beside a hostile meta', [hugeKey]: 1, ...many });
    await pullOnce();
    assert.equal(layerOnThisInstance()?.purpose, 'kept beside a hostile meta', 'the known key did not survive the hostile ones');
    const unknown = ownLayer()?.unknownFields;
    assert.ok(Array.isArray(unknown) && unknown.length > 0, 'nothing was reported for the unknown keys');
    assert.ok(unknown.every(u => typeof u === 'string' && u.length <= 300), 'a reported name was not bounded: what a peer chose was echoed whole');
    assert.ok(unknown.length <= 100, `the list of unknown names is unbounded (${unknown.length})`);
    assert.ok(JSON.stringify(layersAnswer()).length < 50_000, 'the answer grew with what the peer sent');
  });
});
