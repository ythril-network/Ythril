/**
 * A space's schema arriving from its network is merged ADDITIVELY (`F-39.1`).
 *
 * Owner, 2026-09-25: *"make sure schema is also additive (of course if an exact entity + property match that is
 * overwritten but even same entity should only add properties)"* — *"same for other knowledgetypes of course"*.
 * So a replicated schema adds types, adds properties to types both sides hold, takes the network's definition only
 * for an exact type-and-property match, and never removes anything local.
 *
 * Run: node --test testing/standalone/a-replicated-schema-only-adds.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let mergeReplicatedMeta, replicatedMetaOf;
before(async () => {
  ({ mergeReplicatedMeta, replicatedMetaOf } = await import('../../server/dist/sync/replicated-meta.js'));
});

const str = (description) => ({ type: 'string', ...(description ? { description } : {}) });

describe('types and properties', () => {
  it('a type the receiver lacks is added, for every knowledge type', () => {
    for (const kind of ['entity', 'fact', 'edge', 'chrono']) {
      const r = mergeReplicatedMeta({ typeSchemas: { [kind]: { mine: { propertySchemas: { a: str() } } } } },
        { typeSchemas: { [kind]: { theirs: { propertySchemas: { b: str() } } } } });
      assert.deepEqual(Object.keys(r.meta.typeSchemas[kind]).sort(), ['mine', 'theirs'], kind);
      assert.equal(r.changed, true);
    }
  });
  it('a type both hold keeps every local property and gains the network\'s new ones', () => {
    const r = mergeReplicatedMeta({ typeSchemas: { entity: { person: { propertySchemas: { email: str('local') } } } } },
      { typeSchemas: { entity: { person: { propertySchemas: { phone: str('net') } } } } });
    assert.deepEqual(Object.keys(r.meta.typeSchemas.entity.person.propertySchemas).sort(), ['email', 'phone']);
  });
  it('a property both hold takes the network\'s definition', () => {
    const r = mergeReplicatedMeta({ typeSchemas: { entity: { person: { propertySchemas: { email: str('local') } } } } },
      { typeSchemas: { entity: { person: { propertySchemas: { email: str('network') } } } } });
    assert.equal(r.meta.typeSchemas.entity.person.propertySchemas.email.description, 'network');
  });
  it('a type\'s own field is kept when only the receiver sets it, and the network\'s when both do', () => {
    const r = mergeReplicatedMeta({ typeSchemas: { entity: { person: { namingPattern: '^L', required: ['email'] } } } },
      { typeSchemas: { entity: { person: { namingPattern: '^N' } } } });
    assert.equal(r.meta.typeSchemas.entity.person.namingPattern, '^N');
    assert.deepEqual(r.meta.typeSchemas.entity.person.required, ['email']);
  });
  it('a library reference on either side is one unit, replaced whole by the network\'s definition', () => {
    const r = mergeReplicatedMeta({ typeSchemas: { entity: { person: { $ref: 'library:person' } } } },
      { typeSchemas: { entity: { person: { propertySchemas: { email: str() } } } } });
    assert.deepEqual(r.meta.typeSchemas.entity.person, { propertySchemas: { email: str() } });
  });
  it('nothing local is removed by an empty or partial schema', () => {
    const local = { typeSchemas: { entity: { person: { propertySchemas: { email: str() } } }, fact: { note: {} } } };
    const r = mergeReplicatedMeta(local, { typeSchemas: { entity: {} } });
    assert.deepEqual(r.meta.typeSchemas, local.typeSchemas);
    assert.equal(r.changed, false);
  });
});

describe('the rest of the meta', () => {
  it('a field the network sets takes its value, a field it leaves out keeps the local one', () => {
    const r = mergeReplicatedMeta({ purpose: 'local', usageNotes: 'local notes' }, { purpose: 'network', validationMode: 'warn' });
    assert.equal(r.meta.purpose, 'network');
    assert.equal(r.meta.usageNotes, 'local notes');
    assert.equal(r.meta.validationMode, 'warn');
  });
  it('the receiver keeps its own version and history', () => {
    const r = mergeReplicatedMeta({ version: 7, purpose: 'a' }, { version: 99, previousVersions: [{}], purpose: 'b' });
    assert.equal(r.meta.version, 7);
    assert.equal(r.meta.previousVersions, undefined);
  });
  it('an identical copy is not a change', () => {
    const local = { purpose: 'p', typeSchemas: { entity: { person: { propertySchemas: { email: str() } } } } };
    assert.equal(mergeReplicatedMeta(local, replicatedMetaOf({ ...local, version: 3 })).changed, false);
  });
});

describe('an arriving meta is untrusted', () => {
  it('a body the local API would refuse is refused whole, and nothing is merged', () => {
    const local = { purpose: 'kept' };
    for (const bad of [{ purpose: 'x', validationMdoe: 'strict' }, { validationMode: 'sometimes' }, 'text', [1]]) {
      const r = mergeReplicatedMeta(local, bad);
      assert.equal(r.changed, false, JSON.stringify(bad));
      assert.deepEqual(r.meta, local);
    }
  });
});
