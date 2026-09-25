/**
 * A space carried by two networks keeps each network's schema as its own layer, applies them in precedence, and
 * names every clash rather than resolving it by arrival order (`F-39.2`).
 *
 * Owner decision 2026-09-25, option A: the network joined first wins by default, the operator may reorder, a clash
 * never stops data, and nothing mixed is sent on — each network is sent only this instance's own definitions plus
 * that network's own layer.
 *
 * Run: node --test testing/standalone/a-space-in-two-networks-applies-the-first-joined.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let effectiveMeta, clashesOf, metaForNetwork;
before(async () => {
  ({ effectiveMeta, clashesOf, metaForNetwork } = await import('../../server/dist/sync/replicated-meta.js'));
});

const prop = (type, description) => ({ type, ...(description ? { description } : {}) });
const ent = (types) => ({ typeSchemas: { entity: types } });
const person = (props) => ({ person: { propertySchemas: props } });

const OWN = ent(person({ email: prop('string', 'mine') }));
const A = { networkId: 'net-a', meta: ent(person({ phone: prop('string', 'from a'), tier: prop('number', 'a says number') })) };
const B = { networkId: 'net-b', meta: ent(person({ tier: prop('string', 'b says string'), city: prop('string') })) };

describe('effective meta', () => {
  it('holds every type and property from own and both layers', () => {
    const m = effectiveMeta(OWN, [A, B]);
    assert.deepEqual(Object.keys(m.typeSchemas.entity.person.propertySchemas).sort(), ['city', 'email', 'phone', 'tier']);
  });
  it('on a clash, the network first in precedence wins', () => {
    assert.equal(effectiveMeta(OWN, [A, B]).typeSchemas.entity.person.propertySchemas.tier.type, 'number');
    assert.equal(effectiveMeta(OWN, [B, A]).typeSchemas.entity.person.propertySchemas.tier.type, 'string');
  });
  it('a network\'s definition takes an exact match over the local one, as with one network', () => {
    const own = ent(person({ phone: prop('number', 'mine') }));
    assert.equal(effectiveMeta(own, [A]).typeSchemas.entity.person.propertySchemas.phone.type, 'string');
  });
  it('with no layers it is the own meta', () => {
    assert.deepEqual(effectiveMeta(OWN, []), OWN);
  });
});

describe('clashes', () => {
  it('names a property two networks define differently, with each network\'s definition', () => {
    const c = clashesOf([A, B]);
    assert.equal(c.length, 1, JSON.stringify(c));
    assert.deepEqual({ kind: c[0].kind, type: c[0].type, property: c[0].property }, { kind: 'entity', type: 'person', property: 'tier' });
    assert.deepEqual(c[0].values.map(v => v.networkId), ['net-a', 'net-b']);
  });
  it('the same definition in both networks is not a clash', () => {
    const same = { networkId: 'net-c', meta: ent(person({ phone: prop('string', 'from a') })) };
    assert.deepEqual(clashesOf([A, same]), []);
  });
  it('a top-level field two networks set differently is a clash too', () => {
    const c = clashesOf([{ networkId: 'x', meta: { purpose: 'one' } }, { networkId: 'y', meta: { purpose: 'two' } }]);
    assert.deepEqual(c.map(x => x.field), ['purpose']);
  });
});

describe('nothing mixed is sent on', () => {
  it('a network is sent the own meta plus its own layer, and nothing from the other', () => {
    const m = metaForNetwork(OWN, B);
    const props = Object.keys(m.typeSchemas.entity.person.propertySchemas).sort();
    assert.deepEqual(props, ['city', 'email', 'tier']);
    assert.equal(m.typeSchemas.entity.person.propertySchemas.tier.type, 'string', 'network A\'s definition leaked into B');
    assert.ok(!('phone' in m.typeSchemas.entity.person.propertySchemas), 'network A\'s property leaked into B');
  });
  it('a network with no layer yet is sent the own meta', () => {
    assert.deepEqual(metaForNetwork(OWN, undefined), OWN);
  });
});
