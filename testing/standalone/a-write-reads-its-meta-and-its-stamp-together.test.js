/**
 * A write reads its meta ONCE, and the stamp it may write comes out of the same read (Q-734, Q-736's D-77 guarantee, bundle-265).
 *
 * ## The rule
 *
 * `readMetaForWrite(spaceId)` answers `{ meta, stamp }`: `meta` is what the write validates its record against (the stored meta with its library
 * `$ref`s resolved, the form `getSpaceMeta` returns), `stamp` is `{ fp, text }`, the fingerprint of the STORED object that `meta` was made from. They
 * are read together and synchronously, so a record that is stamped is stamped with the fingerprint of the very schema it was checked against — never
 * the fingerprint of a schema a concurrent meta write stored between two reads. A write that read the meta and, later, asked for the fingerprint
 * separately could stamp a record with a schema it never conformed to; the pair cannot be pulled apart.
 *
 * ## The memo
 *
 * Making `text` costs milliseconds on a large meta, and every write asks. The answer is memoised on the stored meta OBJECT (a meta write stores a new one,
 * so a changed schema is a miss) and on the library's generation (a library edit changes what a `$ref` resolves to without touching any stored meta). The
 * cases below observe both from outside: an unchanged stored object answers one stamp (the very object, not a copy), a replaced object answers its own, a
 * library edit answers a new one for a linked space.
 *
 * ## Seen red
 *
 * On ce37b83a `server/src/spaces/schema-stamp.ts` does not exist: the import in `before` throws.
 *
 * Run: node --test testing/standalone/a-write-reads-its-meta-and-its-stamp-together.test.js   (after `npm run build -w @ythril/server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, removeInstanceDir } from './_vote-round-instance.mjs';
import { sha256Hex, clone, baseMeta, inlineTwinOfBase, personEntry, PERSON_DEFINITION, openStampSpace } from './_schema-fingerprint.mjs';

const dir = tempInstanceDir('ythril-read-meta-for-write-');
const ID = 'fp';

let space, schemaValidation, textOf;

describe('a write reads its meta and its stamp together', () => {
  before(async () => {
    ({ schemaFingerprintTextOf: textOf } = await import('../../schema/dist/internal.js'));
    space = await openStampSpace(dir, { spaceId: ID });
    schemaValidation = await import('../../server/dist/spaces/schema-validation.js');
    space.loader.saveSchemaLibrary([personEntry()]);
  });
  after(() => removeInstanceDir(dir));

  it('answers the meta a write validates with (library refs resolved) and the stamp of the stored meta it was made from', () => {
    const write = space.put(baseMeta());
    assert.deepEqual(write.meta, schemaValidation.getSpaceMeta(ID), 'the meta of the pair is not the meta getSpaceMeta answers: a write would validate against something else');
    assert.deepEqual(write.meta.typeSchemas.entity.person.propertySchemas.born, PERSON_DEFINITION.propertySchemas.born, 'the $ref was not resolved in the meta a write validates with');
    const stored = space.space().meta;
    assert.equal(write.stamp.text, textOf(schemaValidation.inlineResolvableRefs(stored)),
      'the stamp\'s text is not the fingerprint text of the stored meta with its refs inlined');
    assert.equal(write.stamp.fp, sha256Hex(write.stamp.text));
  });

  it('the stamp names the schema the meta of the same pair holds: the text parses back to the types the meta validates with', () => {
    const write = space.put(baseMeta());
    const named = JSON.parse(write.stamp.text);
    assert.deepEqual(named.typeSchemas.entity.person, write.meta.typeSchemas.entity.person,
      'the stamp was taken of a different schema than the meta it travels with');
    assert.deepEqual(named.rules, write.meta.rules);
  });

  it('a space with no stored meta answers no meta and the empty schema\'s stamp', () => {
    const write = space.put(undefined);
    assert.equal(write.meta, undefined);
    assert.equal(write.stamp.text, textOf(undefined));
    assert.equal(write.stamp.fp, sha256Hex(textOf(undefined)));
  });

  it('is synchronous: nothing can land between the meta and the stamp', () => {
    space.put(baseMeta());
    const write = space.stampMod.readMetaForWrite(ID);
    assert.equal(typeof write.then, 'undefined', 'readMetaForWrite returned a promise: a meta write could store a new schema between its two halves');
    assert.deepEqual(Object.keys(write).sort(), ['meta', 'stamp']);
  });

  it('the pair stays a pair when the stored meta is replaced after it was read', () => {
    const first = space.put(baseMeta());
    const [firstFp, firstMeta] = [first.stamp.fp, clone(first.meta)];
    const changed = baseMeta(); changed.typeSchemas.entity.project.description = 'changed after the read';
    const second = space.put(changed);
    assert.notEqual(second.stamp.fp, firstFp, 'the fixture is wrong: the edit did not change the schema');
    assert.equal(first.stamp.fp, firstFp, 'a stamp already handed to a write moved when the stored meta did');
    assert.deepEqual(first.meta, firstMeta, 'the meta already handed to a write moved when the stored meta did');
  });

  it('getSpaceMeta is untouched: it answers no fingerprint, so a caller of the old door cannot read one that was not taken with its meta', () => {
    space.put(baseMeta());
    assert.equal('schemaFingerprint' in schemaValidation.getSpaceMeta(ID), false);
  });

  describe('the memo', () => {
    it('an unchanged stored meta answers one stamp, however many writes ask', () => {
      const a = space.put(baseMeta());
      const b = space.stampMod.readMetaForWrite(ID);
      const c = space.stampMod.readMetaForWrite(ID);
      assert.equal(b.stamp, a.stamp, 'the stamp was made again for a stored meta that did not change: every write would pay the milliseconds');
      assert.equal(c.stamp, a.stamp);
    });

    it('a replaced stored meta with the same content answers the same fingerprint, and one with other content answers its own', () => {
      const a = space.put(baseMeta());
      const same = space.put(baseMeta());
      assert.equal(same.stamp.fp, a.stamp.fp);
      const other = baseMeta(); other.rules.r1.rule = 'false';
      assert.notEqual(space.put(other).stamp.fp, a.stamp.fp, 'a changed schema was served the memo of the old object');
    });

    it('a library edit gives a space that links the entry a new stamp without any stored meta changing, and a space that holds it inline none', () => {
      const linked = space.put(baseMeta()).stamp;
      const inline = space.put(inlineTwinOfBase()).stamp;
      space.put(baseMeta());   // the linked meta is the stored one again
      space.loader.saveSchemaLibrary([personEntry({ ...PERSON_DEFINITION, description: 'A human being' })]);
      try {
        const after = space.stampMod.readMetaForWrite(ID);
        assert.notEqual(after.stamp.fp, linked.fp, 'a library edit did not reach the stamp of a space that links the entry: the memo is stale and records would be stamped with the old schema');
        assert.equal(after.meta.typeSchemas.entity.person.description, 'A human being', 'the meta and the stamp of one read disagree about the library');
        assert.equal(JSON.parse(after.stamp.text).typeSchemas.entity.person.description, 'A human being');
        space.put(inlineTwinOfBase());
        assert.equal(space.stampMod.readMetaForWrite(ID).stamp.fp, inline.fp, 'a space that holds the definition inline was moved by a library edit');
      } finally { space.loader.saveSchemaLibrary([personEntry()]); }
      space.put(baseMeta());
      assert.equal(space.stampMod.readMetaForWrite(ID).stamp.fp, linked.fp, 'the entry restored, the stamp is the first again');
    });
  });
});
