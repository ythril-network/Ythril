/**
 * A passed `meta_change` round says it overwrote a field only when the stored value moved from the base the round CARRIES (`R6-8`, `metaBase`).
 *
 * ## What this holds that the database test does not
 *
 * `a-passed-round-warns-only-of-a-field-that-moved-from-its-base-db` drives a whole conclusion and reads the log, for a scalar. This is the pure
 * function under it (`applyMetaRound`), asked the cases that test cannot cheaply reach: the TYPES a round changes (judged per type, so a type
 * beside it that moved is not a collision), a base that is not what a peer should send (a round is a peer's, and a `null` base made the
 * comparison throw), and the two readings of "moved" side by side — the version the old rule compared, which a layer does not have.
 *
 *  - **the base wins over the version**: the stored meta's version is 0 against a round based on 5 (a layer, or the own definitions a layer set
 *    apart: no counter), and the round still reports nothing for a field the base says nobody moved;
 *  - **a field that moved is reported**, and only when the round is also changing it now;
 *  - **a type is judged by its own definition**: the type the round changes moved, or a neighbour did;
 *  - **a base that is not an object is no base**: null, a list, a string and a number are judged as a round from before this release is, and
 *    never throw.
 *
 * ## Seen red
 *
 * By mutation, each put back by hand: the `captured !== undefined` branch of `contested` removed (the first group fails: every field reads as moved
 * again); the plain-object guard on the base removed (the malformed-base group throws on `null`).
 *
 * Run: node --test testing/standalone/a-round-judges-an-overwrite-against-the-base-it-carries.test.js   (needs a server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let applyMetaRound;
before(async () => { ({ applyMetaRound } = await import('../../server/dist/sync/meta-round-merge.js')); });

/** A layer or a set-apart own meta: no version, no history. */
const held = (fields) => ({ ...fields });
/** A round proposing `proposed` for `changed`, based on version 5 and carrying `metaBase`. */
const round = (proposed, changed, metaBase) => ({
  pendingMeta: proposed, metaChangedFields: changed, baseMetaVersion: 5, ...(metaBase !== undefined ? { metaBase } : {}),
});

describe('the base the round carries decides whether a field moved', () => {
  it('nothing moved from the base: no overwrite, although the stored meta has no version to compare with the round\'s', () => {
    const r = applyMetaRound(held({ purpose: 'original' }), round({ purpose: 'proposed' }, ['purpose'], { purpose: 'original' }));
    assert.equal(r.meta.purpose, 'proposed');
    assert.deepEqual(r.conflicts, []);
  });

  it('the field moved from the base and the round changes it: reported, and the round still applies (the vote wins)', () => {
    const r = applyMetaRound(held({ purpose: 'what another round made it' }), round({ purpose: 'proposed' }, ['purpose'], { purpose: 'original' }));
    assert.equal(r.meta.purpose, 'proposed');
    assert.deepEqual(r.conflicts, ['purpose']);
  });

  it('the field moved to the very value the round proposes: agreement, not a collision', () => {
    const r = applyMetaRound(held({ purpose: 'proposed' }), round({ purpose: 'proposed' }, ['purpose'], { purpose: 'original' }));
    assert.deepEqual(r.conflicts, []);
  });

  it('a field the base says held nothing, and still holds nothing, is not a collision', () => {
    const r = applyMetaRound(held({ usageNotes: 'other' }), round({ purpose: 'proposed' }, ['purpose'], {}));
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.meta.usageNotes, 'other', 'a field the round never changed was touched');
  });

  it('another field moved: the round\'s own field is not a collision', () => {
    const r = applyMetaRound(held({ purpose: 'original', usageNotes: 'moved elsewhere' }), round({ purpose: 'proposed' }, ['purpose'], { purpose: 'original' }));
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.meta.usageNotes, 'moved elsewhere');
  });

  it('a stored value that is an object is compared by its content, not its key order', () => {
    const r = applyMetaRound(held({ stampSkew: { warnMinutes: 5, other: 1 } }),
      round({ stampSkew: { warnMinutes: 9 } }, ['stampSkew'], { stampSkew: { other: 1, warnMinutes: 5 } }));
    assert.deepEqual(r.conflicts, [], 'the same object in another key order read as moved');
  });
});

describe('a type is judged by its own definition', () => {
  const T = (extra) => ({ propertySchemas: { a: { type: 'string' } }, ...extra });
  const base = { typeSchemas: { entity: { Service: T() } } };

  it('the type the round changes is where the base had it: no collision', () => {
    const r = applyMetaRound(held({ typeSchemas: { entity: { Service: T() } } }),
      round({ typeSchemas: { entity: { Service: T({ namingPattern: '^s' }) } } }, ['typeSchemas'], base));
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.meta.typeSchemas.entity.Service.namingPattern, '^s');
  });

  it('the type the round changes moved from the base: the knowledge type is reported', () => {
    const r = applyMetaRound(held({ typeSchemas: { entity: { Service: T({ description: 'someone else' }) } } }),
      round({ typeSchemas: { entity: { Service: T({ namingPattern: '^s' }) } } }, ['typeSchemas'], base));
    assert.deepEqual(r.conflicts, ['typeSchemas.entity']);
  });

  it('a NEIGHBOUR type of the same knowledge type moved: not the round\'s type, not a collision', () => {
    const r = applyMetaRound(held({ typeSchemas: { entity: { Service: T(), Other: { description: 'moved' } } } }),
      round({ typeSchemas: { entity: { Service: T({ namingPattern: '^s' }) } } }, ['typeSchemas'], base));
    assert.deepEqual(r.conflicts, [], 'a type beside the changed one was read as a collision');
    assert.deepEqual(r.meta.typeSchemas.entity.Other, { description: 'moved' }, 'the neighbour was disturbed');
  });

  it('a type the base did not hold, and the stored meta still lacks: new on both sides, no collision', () => {
    const r = applyMetaRound(held({}), round({ typeSchemas: { entity: { Fresh: T() } } }, ['typeSchemas'], { typeSchemas: {} }));
    assert.deepEqual(r.conflicts, []);
  });
});

describe('a base that is not an object is no base', () => {
  const current = { version: 2, purpose: 'other' };
  for (const [label, bad] of [['null', null], ['a list', ['purpose']], ['a string', 'purpose'], ['a number', 7]]) {
    it(`${label}: the round is judged as one from before this release is, and nothing throws`, () => {
      let r;
      assert.doesNotThrow(() => { r = applyMetaRound(current, { pendingMeta: { purpose: 'proposed' }, metaChangedFields: ['purpose'], baseMetaVersion: 2, metaBase: bad }); });
      assert.equal(r.meta.purpose, 'proposed', 'the round was not applied');
      // Version 2 against 2: nothing moved by the old rule, so nothing is reported — the same answer a round with no base gives.
      assert.deepEqual(r.conflicts, applyMetaRound(current, { pendingMeta: { purpose: 'proposed' }, metaChangedFields: ['purpose'], baseMetaVersion: 2 }).conflicts);
    });
  }

  it('a base whose type map is not what it should be does not throw either', () => {
    for (const typeSchemas of [null, 'x', 5, [], { entity: null }, { entity: 'x' }]) {
      assert.doesNotThrow(() => applyMetaRound(held({ typeSchemas: { entity: { Service: {} } } }),
        round({ typeSchemas: { entity: { Service: { namingPattern: '^s' } } } }, ['typeSchemas'], { typeSchemas })));
    }
  });
});
