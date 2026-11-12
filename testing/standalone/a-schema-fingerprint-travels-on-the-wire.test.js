/**
 * A record's schema stamp (`schemaFingerprint`, bundle-265 Q-737) travels with the record, and is never what two copies of it are told apart by.
 *
 * ## The rule, in four parts
 *
 * The stamp is the fingerprint of the schema the record's WRITER validated it against. It replicates, so:
 *
 *  1. **Every record family's `Incoming*` schema declares it** (the four record collections: facts, entities, edges, chrono). Undeclared, zod strips it on
 *     push and pull keeps it: the direction-dependent loss `a-replicated-field-reaches-its-incoming-schema` exists to catch. A value that is not a
 *     64-character hex fingerprint is read as ABSENT and the record is admitted: a peer's malformed claim costs it its stamp, never its record.
 *  2. **It is version metadata** (`VERSION_META`, `sync/authored-content.ts`), so it is not body: two copies of one version that differ only in the
 *     schema their writers held say the same thing, and the planner skips them instead of forking one (ADR 15). The planner half is in
 *     `sync-upsert-plan.test.js`; the hash it decides by is here, for the normalised hash and for the raw one a copy that fails its schema falls back to.
 *  3. **It is left out of the Merkle record leaf** (`REPLICATED_UNHASHED_FIELDS`, `brain/merkle.ts`): an older member drops it on arrival, and an equal-seq
 *     copy is never stored over the held one, so a hashed stamp would keep two members' leaves apart for ever over metadata about the write.
 *  4. **It is not a local-only field**: the arrival writer strips those, and a stamp stripped on arrival is no stamp. The gate half of this (the set is
 *     found, every record document declares the stamp, the hash leaves it out) is in `a-replicated-field-reaches-its-incoming-schema`.
 *
 * ## Seen red
 *
 * On the base (ce37b83a) no schema declares the stamp, `VERSION_META` does not name it, and `docLeaf` hashes a stamp it is handed. The Incoming and body-hash
 * cases assert the precondition first (declared, named), because the schema strips the stamp on the base and the hash would otherwise be equal for a reason that
 * stops being true the day the schema declares it; the leaf cases are red on their own (the leaf differs). The "malformed is read as absent" half passes on the
 * base by itself (the key is stripped there): each family's case asserts the good value first, so it is red.
 *
 * Run: node --test testing/standalone/a-schema-fingerprint-travels-on-the-wire.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base, MAIN_FIELD, ALTERNATE } from './_fork-body-fixtures.mjs';

const fp = (word) => createHash('sha256').update(`schema ${word}`, 'utf8').digest('hex');
const X = fp('X');
const Y = fp('Y');

/** Values a peer may send in the stamp's place that are not a fingerprint: every one is read as absent. */
const MALFORMED = Object.freeze([
  ['an empty string', ''],
  ['a short string', 'abc'],
  ['63 hex characters', X.slice(0, 63)],
  ['65 hex characters', `${X}a`],
  ['64 characters that are not all hex', `${X.slice(0, 63)}g`],
  ['a number', 12345],
  ['null', null],
  ['an object', { fp: X }],
  ['an array', [X]],
  ['true', true],
]);

let INCOMING, H, M, BRAIN, RECORD_FAMILIES, LOCAL;

before(async () => {
  ({ INCOMING_SCHEMA_OF: INCOMING } = await import('../../server/dist/sync/incoming-schemas.js'));
  H = await import('../../server/dist/sync/authored-content.js');
  M = await import('../../server/dist/brain/merkle.js');
  ({ BRAIN_COLLECTIONS: BRAIN } = await import('../../server/dist/config/types-knowledge.js'));
  LOCAL = await import('../../server/dist/sync/local-only-fields.js');
  // The record collections: every brain collection that holds a record with a schema (a link has none, a file has no type schema), read from the registry.
  RECORD_FAMILIES = BRAIN.filter(c => c !== 'links' && c !== 'files');
});

describe('the families the stamp travels on are derived', () => {
  it('the record collections are the four with a fixture, and none is missing', () => {
    assert.deepEqual([...RECORD_FAMILIES].sort(), Object.keys(MAIN_FIELD).sort(),
      'the brain collections less links and files are not the four families the fixtures carry: a record family was added or removed, so give it a fixture before trusting this file');
    assert.ok(RECORD_FAMILIES.length >= 4, `only ${RECORD_FAMILIES.length} record families`);
  });
});

describe('every record family\'s Incoming schema declares the stamp; a malformed one is read as absent', () => {
  for (const family of ['facts', 'entities', 'edges', 'chrono']) {
    it(`${family}: a fingerprint survives the schema, and each malformed value is dropped with the record admitted`, () => {
      const schema = INCOMING[family].schema;
      assert.ok('schemaFingerprint' in schema.shape, `${INCOMING[family].name} declares no schemaFingerprint: zod strips a peer's stamp on push`);
      const good = schema.safeParse(base(family, { schemaFingerprint: X }));
      assert.equal(good.success, true, `a ${family} carrying a good stamp was refused: ${JSON.stringify(good.error?.issues)}`);
      assert.equal(good.data.schemaFingerprint, X, `${family}: the stamp did not survive its own Incoming schema`);
      for (const [what, value] of MALFORMED) {
        const r = schema.safeParse(base(family, { schemaFingerprint: value }));
        assert.equal(r.success, true, `${family}: ${what} refused the whole record (${JSON.stringify(r.error?.issues)}): a malformed claim must cost the stamp, never the record`);
        assert.equal('schemaFingerprint' in r.data, false, `${family}: ${what} was kept as the stamp: ${JSON.stringify(r.data.schemaFingerprint)}`);
      }
    });

    it(`${family}: a record with no stamp is admitted as it always was (the stamp is optional)`, () => {
      const schema = INCOMING[family].schema;
      assert.ok('schemaFingerprint' in schema.shape, `${INCOMING[family].name} declares no schemaFingerprint`);
      const r = schema.safeParse(base(family));
      assert.equal(r.success, true, `an unstamped ${family} was refused: ${JSON.stringify(r.error?.issues)}`);
      assert.equal('schemaFingerprint' in r.data, false, `${family}: parsing invented a stamp`);
    });
  }

  it('a link and a file carry no stamp: their schemas do not declare it (a link has no schema, a file no type schema)', () => {
    for (const family of ['links', 'filemeta']) {
      assert.ok(INCOMING[family], `no Incoming schema for ${family}`);
      assert.equal('schemaFingerprint' in INCOMING[family].schema.shape, false, `${INCOMING[family].name} declares a stamp: nothing validates a ${family} against a schema, so nothing could stamp it`);
    }
  });
});

describe('the stamp is version metadata, so it is not what two copies are told apart by', () => {
  it('VERSION_META names it, and no forking family reads it as body', () => {
    assert.ok(H.VERSION_META.includes('schemaFingerprint'), 'VERSION_META does not name schemaFingerprint: the stamp would be body, and a stamp-only difference would fork');
    for (const family of RECORD_FAMILIES) {
      assert.ok('schemaFingerprint' in INCOMING[family].schema.shape, `${family}: the schema does not declare the stamp, so "not body" says nothing yet`);
      assert.ok(!H.BODY_FIELDS_OF[family].includes('schemaFingerprint'), `${family}: the stamp is in BODY_FIELDS_OF`);
    }
  });

  for (const family of ['facts', 'entities', 'edges', 'chrono']) {
    it(`${family}: the body hash is the same whatever the stamp, for a copy that parses and for one that fails its schema`, () => {
      assert.ok('schemaFingerprint' in INCOMING[family].schema.shape, `${family}: the stamp is not declared, so the hash below is equal only because it is stripped`);
      const copies = [
        ['parses', (over) => base(family, over)],
        // `tags` of the wrong type fails every Incoming schema, so the hash falls back to the raw projection (`normalised: false`).
        ['fails its schema', (over) => base(family, { tags: 'not-a-list', ...over })],
      ];
      for (const [kind, make] of copies) {
        const none = H.authoredContentHash(family, make({}));
        assert.equal(none.normalised, kind === 'parses', `${family}: the "${kind}" fixture is not the kind it claims`);
        for (const stamp of [X, Y, 'not a fingerprint']) {
          const stamped = H.authoredContentHash(family, make({ schemaFingerprint: stamp }));
          assert.equal(stamped.hash, none.hash, `${family} (${kind}): a stamp changed the body hash`);
          assert.equal(stamped.text, none.text, `${family} (${kind}): a stamp is in the body text, so a fork id derived from it would differ between members`);
          assert.equal(stamped.rawHash, none.rawHash, `${family} (${kind}): a stamp changed the raw hash two copies are compared by when either fails its schema`);
        }
      }
      // The control: a body difference still changes it, so the equal hashes above are not an empty comparison.
      const other = H.authoredContentHash(family, base(family, { schemaFingerprint: X, [MAIN_FIELD[family]]: ALTERNATE[family][MAIN_FIELD[family]] }));
      assert.notEqual(other.hash, H.authoredContentHash(family, base(family, { schemaFingerprint: X })).hash, `${family}: the hash does not see the body`);
    });
  }

  it('a redacted chrono entry is compared by the same stamp-free text', () => {
    const redacted = (over) => (({ description, ...rest }) => rest)(base('chrono', { contentRedacted: true, contentRedactedAt: '2026-10-02T00:00:00.000Z', ...over }));
    assert.ok('schemaFingerprint' in INCOMING.chrono.schema.shape, 'chrono does not declare the stamp');
    const a = H.authoredContentHash('chrono', redacted({ schemaFingerprint: X }));
    const b = H.authoredContentHash('chrono', redacted({}));
    assert.ok(a.redacted && b.redacted, 'the redacted comparison text is absent');
    assert.equal(a.redacted.hash, b.redacted.hash, 'a stamp changed the text a redacted copy is compared by');
  });
});

describe('the Merkle record leaf leaves the stamp out', () => {
  for (const family of ['facts', 'entities', 'edges', 'chrono']) {
    it(`${family}: the leaf is the same with no stamp, with one, and with another`, () => {
      // No precondition on the schema here: `docLeaf` is handed the stored document as it is, so it is red on the base for its own reason (it hashes the stamp).
      const leaf = (doc) => M.docLeaf(family, doc);
      const none = leaf(base(family));
      assert.equal(leaf(base(family, { schemaFingerprint: X })), none, `${family}: a stamped record hashes differently from the same record unstamped: an older member that drops the stamp can never agree with the one that wrote it`);
      assert.equal(leaf(base(family, { schemaFingerprint: X })), leaf(base(family, { schemaFingerprint: Y })), `${family}: two members that stamped one version with different schemas disagree about identical content`);
    });
  }

  it('the leaf still sees what a record says, the stamp being out of it (the comparison above is not an empty one)', () => {
    for (const family of RECORD_FAMILIES) {
      const doc = base(family, { schemaFingerprint: X });
      assert.notEqual(M.docLeaf(family, doc), M.docLeaf(family, { ...doc, [MAIN_FIELD[family]]: ALTERNATE[family][MAIN_FIELD[family]] }), `${family}: the leaf does not see the body`);
      assert.notEqual(M.docLeaf(family, doc), M.docLeaf(family, { ...doc, seq: 6 }), `${family}: the leaf does not see the version`);
    }
  });

  it('it is excluded as a replicated field, never as a local-only one (the arrival writer strips those)', () => {
    assert.equal(LOCAL.LOCAL_ONLY_FIELDS.has('schemaFingerprint'), false, 'schemaFingerprint is in LOCAL_ONLY_FIELDS: the arrival writer would strip the stamp from every arrival');
    assert.equal(LOCAL.RESTORED_LOCAL_FIELDS.has('schemaFingerprint'), false, 'schemaFingerprint is in RESTORED_LOCAL_FIELDS: it is no record-tier local field');
    assert.equal('schemaFingerprint' in LOCAL.stripLocalOnly({ _id: 'x', schemaFingerprint: X }), true, 'stripLocalOnly drops an arriving schemaFingerprint: it is treated as a local field');
    assert.equal(LOCAL.LOCAL_ONLY_EXCLUSION.schemaFingerprint, undefined, 'a sender\'s read projection drops the stamp from the wire');
    // And the hash leaves it out through its own list, which is what makes the leaf cases above pass: asserted on the leaf, not on a name.
    const doc = base('facts', { schemaFingerprint: X });
    assert.equal(M.docLeaf('facts', doc), M.docLeaf('facts', base('facts')), 'the leaf sees the stamp although it is not a local-only field');
  });
});
