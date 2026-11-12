/**
 * A space's schema fingerprint is its CONTENT — the same schema is the same fingerprint on every instance, whatever order its keys were written in,
 * and nothing that is not the schema moves it (Q-734, bundle-265).
 *
 * ## What the fingerprint is
 *
 * `T = canonicalJson({ format: 1, typeSchemas, rules })` over a space's STORED effective meta with every resolvable library `$ref` inlined, an empty
 * kind map and an empty rules map left out; the fingerprint is `sha256(utf8(T))`. `schemaFingerprintTextOf` (the schema package's `./internal`) makes
 * `T` and never hashes it; `readMetaForWrite(spaceId).stamp` (`server/src/spaces/schema-stamp.ts`) is the server's `{ fp, text }`.
 *
 * ## Why it is held here
 *
 * A fingerprint that depends on the instance (a key order, the id of the space, a `$ref` spelled one way, the purpose text) makes two members that hold
 * one schema stamp their records differently, and the whole point of stamping a record with the schema it conformed to — comparing it with a peer's,
 * fetching the snapshot a stamp names — is gone. And one that does NOT move on a real edit (a description, an enum's order, a space rule) stamps a
 * record with the schema it no longer conforms to. Both directions are held below, each on its own meta.
 *
 * ## Seen red
 *
 * On ce37b83a the module `schema/src/schema-fingerprint.ts` and `server/src/spaces/schema-stamp.ts` do not exist: the import in `before` throws, so
 * every case is red for that reason; a module that gets one rule wrong (an instance id in the text, a `$ref` hashed as written) fails that rule's case alone.
 *
 * Run: node --test testing/standalone/a-schema-fingerprint-is-content-not-instance.test.js   (after `npm run build -w @ythril/server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstanceDir, removeInstanceDir } from './_vote-round-instance.mjs';
import { sha256Hex, clone, deepReverse, baseMeta, inlineTwinOfBase, personEntry, PERSON_DEFINITION, openStampSpace } from './_schema-fingerprint.mjs';

const dir = tempInstanceDir('ythril-schema-fingerprint-');

let textOf, space, loader;
/** The stamp of a stored meta, as the server answers it. */
const stampOf = (meta) => space.put(meta).stamp;
const fpOf = (meta) => stampOf(meta).fp;

describe('a schema fingerprint is content, not instance', () => {
  before(async () => {
    ({ schemaFingerprintTextOf: textOf } = await import('../../schema/dist/internal.js'));
    space = await openStampSpace(dir, { spaces: ['fp', 'one', 'two'].map(id => ({ id, label: id, folders: [] })) });
    ({ loader } = space);
    loader.saveSchemaLibrary([personEntry()]);
  });
  after(() => removeInstanceDir(dir));

  describe('what the text is', () => {
    it('the text of a stored meta is the text its fingerprint is the hash of, so the name is its own content', () => {
      const stamp = stampOf(baseMeta());
      assert.equal(stamp.fp, sha256Hex(stamp.text), 'the fingerprint is not the sha256 of the very text it came with: a snapshot named by it could not be verified');
      assert.match(stamp.fp, /^[0-9a-f]{64}$/);
      assert.equal(JSON.parse(stamp.text).format, 1, 'the text names its format, so a later format is told from this one');
    });

    it('the text holds the type schemas and the rules and nothing else, the empty kind left out', () => {
      const parsed = JSON.parse(stampOf(baseMeta()).text);
      assert.deepEqual(Object.keys(parsed).sort(), ['format', 'rules', 'typeSchemas']);
      assert.deepEqual(Object.keys(parsed.typeSchemas).sort(), ['edge', 'entity'], 'fact: {} is an empty kind and is not in the text');
      assert.deepEqual(Object.keys(parsed.rules), ['r1']);
    });

    it('the schema package makes the text from resolved input alone and hashes nothing (the text of a meta is not its fingerprint)', () => {
      const text = textOf({ typeSchemas: { entity: { project: baseMeta().typeSchemas.entity.project } } });
      assert.equal(typeof text, 'string');
      assert.doesNotMatch(text, /^[0-9a-f]{64}$/, 'schemaFingerprintTextOf returned a hash: the schema package compares texts and never hashes one');
      assert.equal(JSON.parse(text).typeSchemas.entity.project.description, 'A project');
    });

    it('the text is compact canonical JSON: sorted at every level, no spaces, UTF-8 kept literal', () => {
      const { text } = stampOf({ typeSchemas: { entity: { zeta: { description: 'Ünïcode – ok' }, alpha: { description: 'b' } } } });
      assert.equal(text, `{"format":1,"rules":{},"typeSchemas":{"entity":{"alpha":{"description":"b"},"zeta":{"description":"Ünïcode – ok"}}}}`);
    });
  });

  describe('what does not move it', () => {
    it('the order the keys were written in, at every level', () => {
      assert.equal(fpOf(deepReverse(baseMeta())), fpOf(baseMeta()));
    });

    it('an empty kind and an absent kind; an empty rules map and an absent one', () => {
      const withEmptyFact = fpOf(baseMeta());
      const withoutFact = baseMeta(); delete withoutFact.typeSchemas.fact;
      assert.equal(fpOf(withoutFact), withEmptyFact, '{} for a kind and no key for it are one schema');
      const noRules = baseMeta(); delete noRules.rules;
      const emptyRules = baseMeta(); emptyRules.rules = {};
      assert.equal(fpOf(noRules), fpOf(emptyRules), 'absent rules and {} rules are one schema');
    });

    it('a library $ref and the library entry written inline in its place (and in another key order)', () => {
      assert.equal(fpOf(inlineTwinOfBase()), fpOf(baseMeta()), 'a $ref and what it resolves to are one schema: two instances that spell it differently would stamp differently');
      const reordered = inlineTwinOfBase(); reordered.typeSchemas.entity.person = deepReverse(PERSON_DEFINITION);
      assert.equal(fpOf(reordered), fpOf(baseMeta()));
    });

    it('everything of a meta that is not its schema: purpose, notes, modes, linkage, suppression, history, version, the unknown-field answer', () => {
      const edited = baseMeta();
      Object.assign(edited, {
        purpose: 'another purpose', usageNotes: 'notes', validationMode: 'off', strictLinkage: false, version: 99, updatedAt: '2030-01-01T00:00:00Z',
        previousVersions: [], unknownWriteFields: 'refuse', suppressEmbeddings: true, whenDuePasses: 'nothing', stampSkew: { warnMinutes: 5 },
      });
      assert.equal(fpOf(edited), fpOf(baseMeta()), 'a field that is not the schema moved the fingerprint: a label edit would re-stamp nothing but still name a new schema');
    });

    it('the space it is held in: the same schema in two spaces is one fingerprint', () => {
      assert.equal(space.put(baseMeta(), 'one').stamp.fp, space.put(deepReverse(baseMeta()), 'two').stamp.fp, 'a fingerprint carries the id of the space it was taken in');
    });

    it('a library edit moves the fingerprint of a space that LINKS the entry and not one that holds it inline', () => {
      const linked = baseMeta(); const inline = inlineTwinOfBase();
      const [before, beforeInline] = [fpOf(linked), fpOf(inline)];
      loader.saveSchemaLibrary([personEntry({ ...PERSON_DEFINITION, description: 'A human being' })]);
      try {
        assert.notEqual(fpOf(linked), before, 'the library entry changed and the linked space kept its fingerprint: a memo keyed on the stored object alone is stale (the library is a second input)');
        assert.equal(fpOf(inline), beforeInline, 'a space that holds the definition inline does not read the library');
      } finally { loader.saveSchemaLibrary([personEntry()]); }
      assert.equal(fpOf(linked), before, 'the entry restored, the fingerprint is the first again');
    });
  });

  describe('what moves it (each edit on its own)', () => {
    const base = () => fpOf(baseMeta());
    const edits = {
      'a type description': m => { m.typeSchemas.entity.project.description = 'A Project'; },
      'a property description': m => { m.typeSchemas.entity.project.propertySchemas.status.description = 'the state'; },
      'an enum value added': m => { m.typeSchemas.entity.project.propertySchemas.status.enum.push('dropped'); },
      'an enum REORDERED (arrays keep their order)': m => { m.typeSchemas.entity.project.propertySchemas.status.enum.reverse(); },
      'a property type': m => { m.typeSchemas.entity.project.propertySchemas.status.type = 'number'; delete m.typeSchemas.entity.project.propertySchemas.status.enum; },
      'a type added': m => { m.typeSchemas.fact.note = { propertySchemas: { body: { type: 'string' } } }; },
      'a type removed': m => { delete m.typeSchemas.entity.project; },
      'an edge endpoint': m => { m.typeSchemas.edge.owns.endpoints.to = ['person']; },
      'an edge made not functional': m => { delete m.typeSchemas.edge.owns.functional; },
      'a space rule edited': m => { m.rules.r1.rule = 'false'; },
      'a space rule added': m => { m.rules.r2 = { rule: 'true', message: 'second', kinds: ['fact'] }; },
      'a space rule removed': m => { delete m.rules.r1; },
    };
    for (const [what, edit] of Object.entries(edits)) {
      it(what, () => {
        const m = baseMeta(); edit(m);
        assert.notEqual(fpOf(m), base(), `${what} left the fingerprint where it was: a record stamped with it would claim a schema it was not checked against`);
      });
    }

    it('two different edits are two different fingerprints (not merely "different from the base")', () => {
      const a = baseMeta(); a.typeSchemas.entity.project.description = 'X';
      const b = baseMeta(); b.typeSchemas.entity.project.description = 'Y';
      assert.notEqual(fpOf(a), fpOf(b));
    });
  });

  describe('the empty schema', () => {
    it('no schema at all and an empty schema stamp alike: the fingerprint of the empty schema, which is not absent', () => {
      const none = stampOf(undefined);
      assert.equal(none.fp, stampOf({}).fp, 'a space with no meta and one with {} are the same schema');
      assert.equal(none.fp, stampOf({ typeSchemas: {}, rules: {} }).fp);
      assert.equal(none.fp, stampOf({ typeSchemas: { entity: {}, edge: {}, fact: {}, chrono: {} }, purpose: 'only a purpose' }).fp, 'empty kinds and a purpose are the empty schema');
      assert.equal(none.text, textOf(undefined), 'the schema package and the server make the empty schema\'s text alike');
      assert.equal(none.fp, sha256Hex(none.text));
    });

    it('is a fixed fingerprint, because stored stamps outlive a build: the text, and the fingerprint named by it, are what 6.6.0 first wrote', () => {
      const none = stampOf(undefined);
      assert.equal(none.text, '{"format":1,"rules":{},"typeSchemas":{}}');
      assert.equal(none.fp, '49bea0b1b287256c8bf200fb74fabfa5505e43634da1aba9ec7e44717c868186');
    });
  });

  describe('two instances agree', () => {
    it('a schema served to a peer, read back through the peer parse with no library of its own, has the sender\'s fingerprint', async () => {
      const { readPeerMeta } = await import('../../schema/dist/internal.js');
      const { inlineResolvableRefs } = await import('../../server/dist/spaces/schema-validation.js');
      const { replicatedMetaOf } = await import('../../server/dist/sync/replicated-meta.js');
      const sender = baseMeta();
      sender.typeSchemas.entity.project.description = 'Projekt “Ü” – née';
      const senderFp = fpOf(sender);
      // What `GET /api/sync/meta` serves: the replicated parts, refs inlined, through JSON.
      const wire = JSON.parse(JSON.stringify(inlineResolvableRefs(replicatedMetaOf(sender))));
      loader.saveSchemaLibrary([]);   // the receiver holds no library entry
      try {
        const read = readPeerMeta(wire);
        assert.equal(read.ok, true, `the served meta did not parse on the receiver: ${read.message}`);
        assert.equal(fpOf(read.meta), senderFp, 'two instances holding one schema (one of them through a library entry it does not have) fingerprint it differently');
      } finally { loader.saveSchemaLibrary([personEntry()]); }
    });

    it('the stored meta and the same meta after a round trip through JSON have one fingerprint (nothing in the text is an object identity)', () => {
      assert.equal(fpOf(clone(baseMeta())), fpOf(baseMeta()));
    });
  });
});
