/**
 * A nested key is content, whatever it is called: the space hash leaves out a derived field at the TOP LEVEL of a record only
 * (Q-624, design rev 4 section 2, section 16 test 2; the probe's correction 1).
 *
 * ## The defect this prevents
 *
 * `canonicalDocHash` dropped every key spelled like a member of `DERIVED_FIELDS` (`embedding`, `matchedText`, `_expireAt`,
 * `syncBase`, `deliveredBy`, `spaceId`, ...) at EVERY level of a document. The derived fields are fields of the record, so a
 * record's own `properties` (which is authored free-form content) was blind to a key that happened to be spelled `embedding` or
 * `spaceId`: two instances holding different values under it hashed alike, and agreed they matched for ever. The same blindness
 * made a fork comparison and the merkle leaf disagree about what a record says. Q-624 hashes a record's body for its fork id and its
 * divergence test with the top-level rule, so the space hash must read the same way or one instance would hold two copies that the
 * space hash calls one.
 *
 * ## What it holds
 *
 * Over every member of the derived set (read from `LOCAL_ONLY_FIELDS` and `RETAGGED_FIELDS`, never listed, with a floor):
 *
 *  - two records that differ only in a NESTED key of that name (in `properties`, in an object inside an array, in `author`) have
 *    different leaves;
 *  - two records that differ only in the TOP-LEVEL field of that name keep the same leaf, as before: it is a local field and
 *    must not be hashed;
 *  - the bytes of a record with no nested derived-named key did not move (pinned by
 *    `canonical-json-is-made-once-and-keeps-the-merkle-bytes.test.js`).
 *
 * ## Red on the unchanged code
 *
 * On b857da8f every nested case is green-for-the-wrong-answer: the two leaves are EQUAL.
 *
 * Run: node --test testing/standalone/merkle-hashes-a-nested-key-whatever-its-name.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { docLeaf } = await import('../../server/dist/brain/merkle.js');
const { LOCAL_ONLY_FIELDS } = await import('../../server/dist/sync/local-only-fields.js');
const { RETAGGED_FIELDS } = await import('../../server/dist/sync/retagged-fields.js');
const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');

const DERIVED = [...new Set([...LOCAL_ONLY_FIELDS, ...RETAGGED_FIELDS])].sort();

const record = (extra = {}) => ({
  _id: 'r1', seq: 5, spaceId: 's', name: 'North', type: 'service', tags: ['a'],
  author: { instanceId: 'i1', instanceLabel: 'One' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  properties: { port: 8080 }, ...extra,
});

describe('the derived set is read, with a floor', () => {
  it('holds the local-only and the retagged fields, and the collections to range over are derived', () => {
    assert.ok(DERIVED.length >= 6, `only ${DERIVED.length} derived field(s) read: ${DERIVED.join(', ')}`);
    for (const f of ['embedding', 'syncBase', 'spaceId']) assert.ok(DERIVED.includes(f), `${f} is not in the derived set: it was read out of the wrong module`);
    assert.ok(BRAIN_COLLECTIONS.length >= 5, 'BRAIN_COLLECTIONS did not load');
  });
});

describe('a nested key is content whatever it is called', () => {
  for (const name of DERIVED) {
    it(`a nested '${name}' that differs is a different record, in properties, in an array of objects and in author`, () => {
      for (const coll of BRAIN_COLLECTIONS) {
        const a = record({ properties: { port: 1, [name]: 'x' } });
        const b = record({ properties: { port: 1, [name]: 'y' } });
        assert.notEqual(docLeaf(coll, a), docLeaf(coll, b), `${coll}: properties.${name} differs and the leaf does not`);
        const c = record({ properties: { list: [{ [name]: 1 }] } });
        const d = record({ properties: { list: [{ [name]: 2 }] } });
        assert.notEqual(docLeaf(coll, c), docLeaf(coll, d), `${coll}: properties.list[0].${name} differs and the leaf does not`);
        const e = record({ author: { instanceId: 'i1', instanceLabel: 'One', [name]: 'p' } });
        const f = record({ author: { instanceId: 'i1', instanceLabel: 'One', [name]: 'q' } });
        assert.notEqual(docLeaf(coll, e), docLeaf(coll, f), `${coll}: author.${name} differs and the leaf does not`);
      }
    });

    it(`a top-level '${name}' that differs is the same record: it is a local field and is not hashed`, () => {
      const a = record({ [name]: 'x' });
      const b = record({ [name]: 'y' });
      assert.equal(docLeaf('entities', a), docLeaf('entities', b), `the top-level ${name} is hashed: two instances would differ over a local field for ever`);
    });
  }

  it('the case the probe named: a record whose property is spelled like a fork field, author, seq or pos, is told apart by it', () => {
    for (const name of ['author', 'seq', 'pos', 'forkOf']) {
      assert.notEqual(docLeaf('entities', record({ properties: { [name]: 'a' } })), docLeaf('entities', record({ properties: { [name]: 'b' } })),
        `a property named '${name}' is invisible to the hash`);
    }
  });
});
