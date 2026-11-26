/**
 * Who serves a voted network's schema as the network's, and who a member takes it from, is decided in one module (`Q-966`, second review N2, N3,
 * N6 and the lens sweep).
 *
 * `networks/schema-standing.ts` answers three questions the door (`GET /api/sync/meta`) and the heal (`pullNetworkSchema`) must agree on:
 *
 * - `createdHere`: `origin` says it, and only `origin`. A network stored before 5.2.0 has none, which everywhere else reads as JOINED, and no
 *   other field tells a creator of that age from a joiner (the create path and the join path both write `joinedBy`, `spaceOrigins`, `createdAt`),
 *   so owning definitions never proves creation: a pre-5.2 joiner that proposed a change owns definitions too, and read as the creator it never
 *   healed (N3), and two such members each waited on the other for ever (N6).
 * - `admitterOf`: who admitted this instance, but only while that member is still a member; the member the join pushed first when it was not
 *   recorded or has left the network (N2: a member whose admitter left never healed).
 * - `servedNetworkPart`: what the door answers as `network` and `networkSeeded`. It was an inline decision in the route that no test reached.
 *
 * Run: node --test testing/standalone/a-voted-networks-schema-standing-decides-who-serves-and-who-takes.test.js
 * (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const standing = await import('../../server/dist/networks/schema-standing.js');

const OWN_SPACE = { id: 's', ownMeta: { purpose: 'definitions this instance holds' }, meta: { purpose: 'definitions this instance holds' } };
const m = (...ids) => ids.map(instanceId => ({ instanceId }));

describe('createdHere', () => {
  it('is true for a network this instance created, false for one it joined', () => {
    assert.equal(standing.createdHere({ origin: 'created' }, OWN_SPACE), true);
    assert.equal(standing.createdHere({ origin: 'joined' }, OWN_SPACE), false);
  });

  it('reads a network with no origin as joined, whatever definitions the space owns and whoever admitted it', () => {
    assert.equal(standing.createdHere({}, OWN_SPACE), false, 'owning definitions proved creation: a pre-5.2 joiner that proposed a change never heals');
    assert.equal(standing.createdHere({ admittedVia: 'inviter' }, OWN_SPACE), false);
    assert.equal(standing.createdHere({}, undefined), false);
  });
});

describe('admitterOf', () => {
  it('is the member that admitted this instance while it is a member', () => {
    assert.equal(standing.admitterOf({ admittedVia: 'y', members: m('x', 'y') }), 'y');
  });

  it('is the first member when the admitter was not recorded', () => {
    assert.equal(standing.admitterOf({ members: m('x', 'y') }), 'x');
  });

  it('is the first member when the admitter is no longer a member', () => {
    assert.equal(standing.admitterOf({ admittedVia: 'left', members: m('x', 'y') }), 'x', 'a member whose admitter left never heals');
  });

  it('is nobody when the network has no members', () => {
    assert.equal(standing.admitterOf({ admittedVia: 'left', members: [] }), undefined);
  });
});

describe('servedNetworkPart: what the door answers as the network\'s schema', () => {
  const OWN = { purpose: 'own definitions' };
  const LAYER = { purpose: 'the layer' };
  const serve = (net) => standing.servedNetworkPart(net, 's', OWN, () => LAYER);

  it('the creator serves its own definitions as the network\'s, seeded', () => {
    assert.deepEqual(serve({ origin: 'created' }), { network: OWN, networkSeeded: true });
  });

  it('a proposer of the space serves its own definitions, seeded', () => {
    assert.deepEqual(serve({ origin: 'joined', schemaLayerSeeded: { s: 'own' } }), { network: OWN, networkSeeded: true });
  });

  it('a member holding the whole layer serves the layer, seeded', () => {
    assert.deepEqual(serve({ origin: 'joined', schemaLayerSeeded: { s: 'layer' } }), { network: LAYER, networkSeeded: true });
  });

  it('a member that has not healed serves its layer, not seeded, so nobody takes it as the whole', () => {
    assert.deepEqual(serve({ origin: 'joined' }), { network: LAYER, networkSeeded: false });
    assert.deepEqual(serve({ origin: 'joined', schemaLayerSeeded: { other: 'layer' } }), { network: LAYER, networkSeeded: false });
  });

  it('a creator of a network stored before 5.2 (no origin) serves its layer, not seeded, and never its definitions', () => {
    assert.deepEqual(serve({}), { network: LAYER, networkSeeded: false });
  });
});
