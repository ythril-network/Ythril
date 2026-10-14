/**
 * A receiver keeps the meta it understands and REPORTS the key it does not — and this is tested against the receiver a peer on the
 * previous release really has (`Q-217`; R6-7).
 *
 * ## The skew
 *
 * `SpaceMetaBody` is `.strict()` and `mergeReplicatedMeta` refuses a meta that fails it WHOLE. On the day a release adds a meta key
 * (`stampSkew` here, `rules` with F-46) every member still on the previous release therefore refuses the entire layer from a member that
 * sets it: not the new key, the schema. `sync-protocol.md` says so for a meta that does not parse. D-24 is the precedent for how a mixed
 * network is told to upgrade; R6-7 adds the two halves a release can do on its own:
 *
 * - **from this release on, the receiver is tolerant**: it keeps every meta and type field it knows, drops the one it does not, and
 *   reports the name (bounded) instead of refusing the layer — so the NEXT key added is not this problem again;
 * - **a writer warns** (`a-schema-write-warns-of-members-that-predate-its-keys-db.test.js`) when it sets a key that members on an older release
 *   will refuse.
 *
 * A meta that does not PARSE (a wrong value, a pattern too risky to run) is a different thing and stays refused whole: tolerance is for
 * the unknown, never for the invalid.
 *
 * ## Why the previous release is loaded, not described
 *
 * The old receiver is `v5.6.10`'s own `replicated-meta.ts` and `body-schemas.ts` (`_previous-release.mjs`), run as shipped. That is what
 * makes the first group below a measurement of the skew rather than the author's belief about it, and what makes the second group (the
 * new body accepts everything the old one did) a real compatibility check instead of a list kept in step by hand.
 *
 * Run: node --test testing/standalone/the-meta-reader-tolerates-what-a-newer-build-sends.test.js
 * (requires a prior server build and the tag v5.6.10 in the checkout)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { releaseSkipReason, loadRelease, sourceAt, PREDECESSOR_TAG } from './_previous-release.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';

const skip = releaseSkipReason();
const BODY = 'server/src/spaces/body-schemas.ts';
const REPLICATED = 'server/src/sync/replicated-meta.ts';

/** The members of an interface in a source text. */
function interfaceKeysOf(text, name) {
  const sf = parseSource(`${name}.ts`, stripComments(text));
  let keys = null;
  sf.forEachChild(function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      keys = node.members.filter(m => m.name).map(m => m.name.getText(sf).replace(/^['"]|['"]$/g, ''));
      return;
    }
    ts.forEachChild(node, visit);
  });
  assert.ok(keys, `interface ${name} not found`);
  return keys;
}

/** What a result says apart from the meta itself: where a receiver reports what it left out. */
const reportOf = (result) => JSON.stringify({ ...result, meta: undefined });

describe(`the meta reader against the previous release (${PREDECESSOR_TAG})`, { skip }, () => {
  let old, oldBody, oldMerge, newBody, newMerge, newKeys, loaded;
  before(async () => {
    loaded = await loadRelease([BODY, REPLICATED]);
    oldBody = loaded.modules[BODY];
    oldMerge = loaded.modules[REPLICATED].mergeReplicatedMeta;
    old = { bodyKeys: Object.keys(oldBody.SpaceMetaBody.shape) };
    ({ SpaceMetaBody: newBody } = await import('../../server/dist/spaces/body-schemas.js'));
    ({ mergeReplicatedMeta: newMerge } = await import('../../server/dist/sync/replicated-meta.js'));
    newKeys = Object.keys(newBody.shape).filter(k => !old.bodyKeys.includes(k));
  });
  after(() => loaded?.cleanup());

  describe('the premise, measured on the old receiver', () => {
    it('refuses a meta carrying a key it does not know, WHOLE — the known fields of the same meta are not kept either', () => {
      const result = oldMerge({}, { purpose: 'known', aKeyFromTheFuture: 1 });
      assert.ok(result.invalid, 'the previous release accepted an unknown meta key: the skew this file is about does not exist');
      assert.equal(result.changed, false);
      assert.equal(result.meta.purpose, undefined, 'the previous release kept part of a meta it refused');
    });
    it('refuses an unknown key inside a type the same way', () => {
      const result = oldMerge({}, { typeSchemas: { entity: { T: { namingPattern: '^a', aFieldFromTheFuture: true } } } });
      assert.ok(result.invalid);
    });
    it('a key this build added since is among those it refuses (so the writer owes its members a warning)', () => {
      assert.ok(newKeys.length >= 1, 'this build adds no meta key since the predecessor: stampSkew (Q-217) is the first, so SpaceMetaBody must now accept it');
      assert.ok(newKeys.includes('stampSkew'), `the keys new since ${PREDECESSOR_TAG} are ${JSON.stringify(newKeys)}; stampSkew is missing`);
      for (const key of newKeys) {
        const sample = key === 'stampSkew' ? { warnMinutes: 5 } : key === 'rules' ? { r: { rule: 'true', message: 'm' } } : null;
        assert.ok(sample !== null, `no sample for the new meta key ${key}: add one here`);
        const result = oldMerge({}, { purpose: 'known', [key]: sample });
        assert.ok(result.invalid, `the previous release accepted the new key ${key}`);
      }
    });
  });

  describe('this build accepts everything the previous release accepted', () => {
    it('every key of the old body is a key of the new one', () => {
      assert.deepEqual(old.bodyKeys.filter(k => !(k in newBody.shape)), [], 'a meta key the previous release accepts is refused by this build');
    });
    it('every meta the old build sends is read whole by this build and by the old one alike (a table over every old key)', () => {
      const sample = {
        purpose: 'p', usageNotes: 'u', validationMode: 'strict', strictLinkage: true, suppressEmbeddings: false, whenDuePasses: 'nothing',
        typeSchemas: { entity: { T: { namingPattern: '^a', propertySchemas: { x: { type: 'string' } } } }, edge: { rel: { endpoints: { from: ['a'] }, functional: true } } },
      };
      assert.deepEqual(old.bodyKeys.filter(k => !(k in sample)), [], 'the sample lacks a key the old body accepts: extend it');
      const before = oldMerge({}, sample);
      const after = newMerge({}, sample);
      assert.equal(before.invalid, undefined);
      assert.equal(after.invalid, undefined, `this build refused a meta the previous release accepts: ${String(after.invalid).slice(0, 200)}`);
      assert.deepEqual(after.meta, before.meta, 'the two builds read the same meta differently');
    });
    it('every field of the old TypeSchema is accepted by this build\'s type schema', async () => {
      const keys = interfaceKeysOf(sourceAt(PREDECESSOR_TAG, 'server/src/config/types-knowledge.ts'), 'TypeSchema')
        .filter(k => k !== '$ref' && k !== '_unresolvedRef');
      const samples = {
        description: ['entity', 'text'], namingPattern: ['entity', '^a'], retention: ['chrono', { days: 3 }], whenDuePasses: ['chrono', 'nothing'],
        propertySchemas: ['entity', { p: { type: 'string' } }], suppressEmbeddings: ['entity', true], endpoints: ['edge', { from: ['a'] }], functional: ['edge', true],
      };
      assert.ok(keys.length >= 7, `only ${keys.length} type fields read at ${PREDECESSOR_TAG}`);
      assert.deepEqual(keys.filter(k => !(k in samples)), [], 'the predecessor\'s TypeSchema has a field with no sample here');
      const { TypeSchemasZ } = await import('../../server/dist/spaces/body-schemas.js');
      for (const k of keys) {
        const [kind, value] = samples[k];
        assert.equal(TypeSchemasZ.safeParse({ [kind]: { T: { [k]: value } } }).success, true, `this build refuses ${k}, which the previous release accepts`);
      }
    });
  });

  describe('the tolerant reader: keep what is known, report what is not', () => {
    it('a meta with an unknown key keeps its known fields, drops the unknown one and names it', () => {
      const result = newMerge({}, { purpose: 'known', usageNotes: 'also known', aKeyFromTheFuture: 1 });
      assert.equal(result.invalid, undefined, `the whole meta was refused for one unknown key: ${String(result.invalid).slice(0, 200)}`);
      assert.equal(result.meta.purpose, 'known', 'a known field of the same meta was lost');
      assert.equal(result.meta.usageNotes, 'also known');
      assert.equal(Object.hasOwn(result.meta, 'aKeyFromTheFuture'), false, 'an unknown key was STORED: the reader must keep what it knows and no more');
      assert.match(reportOf(result), /aKeyFromTheFuture/, 'the unknown key is not reported anywhere in the result');
    });

    it('an unknown field inside a type is dropped and named, and the type\'s known fields are kept', () => {
      const result = newMerge({}, { typeSchemas: { entity: { T: { namingPattern: '^a', aFieldFromTheFuture: true } } } });
      assert.equal(result.invalid, undefined, `the layer was refused for one unknown type field: ${String(result.invalid).slice(0, 200)}`);
      assert.deepEqual(result.meta.typeSchemas.entity.T, { namingPattern: '^a' });
      assert.match(reportOf(result), /aFieldFromTheFuture/);
    });

    it('the report is bounded: a meta full of unknown keys does not become a megabyte of names', () => {
      const incoming = { purpose: 'known' };
      for (let i = 0; i < 500; i++) incoming[`unknown${i}`] = 1;
      const result = newMerge({}, incoming);
      assert.equal(result.invalid, undefined);
      assert.ok(reportOf(result).length < 4_000, `the report is ${reportOf(result).length} characters for 500 unknown keys`);
    });

    it('tolerance is for the UNKNOWN: a field that is known and wrong still refuses the whole meta, and stores nothing', () => {
      const result = newMerge({ purpose: 'kept' }, { purpose: 'new', validationMode: 'sideways', aKeyFromTheFuture: 1 });
      assert.ok(result.invalid, 'a meta with an invalid value was accepted');
      assert.equal(result.changed, false);
      assert.equal(result.meta.purpose, 'kept', 'part of a meta that does not parse was applied');
    });

    it('a round naming an unknown field applies the known ones and reports the unknown, never storing it', async () => {
      const { applyMetaRound } = await import('../../server/dist/sync/meta-round-merge.js');
      const current = { version: 2, purpose: 'old' };
      const applied = applyMetaRound(current, { pendingMeta: { purpose: 'new', aKeyFromTheFuture: 1 }, metaChangedFields: ['purpose', 'aKeyFromTheFuture'], baseMetaVersion: 2 });
      assert.equal(applied.meta.purpose, 'new');
      assert.equal(Object.hasOwn(applied.meta, 'aKeyFromTheFuture'), false, 'an unknown field of a passed round was stored in the meta');
      assert.match(reportOf(applied), /aKeyFromTheFuture/, 'the unknown field of the round is not reported');
    });
  });
});
