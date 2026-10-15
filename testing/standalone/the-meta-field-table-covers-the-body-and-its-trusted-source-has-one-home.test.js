/**
 * `spaces/meta-fields.ts` decides how a merge treats EVERY key the meta body accepts, and the one function that mints a parsed meta
 * from stored parts has one home (bundle-23 wave 1; `Q-216`, `Q-217`, R5-5).
 *
 * ## What it prevents
 *
 * - **A body key no merge knows.** `SpaceMetaBody` is `.strict()`, so a key added to it is accepted by every door — and a merge written
 *   before the key existed used to copy a fixed list of fields, so the write answered success and the value was not stored
 *   (`whenDuePasses`, `stampSkew`). The table gives each key a KIND and `mergeMetaFields` skips a key without one; `body-schemas.ts`
 *   refuses to load when the body accepts a key the table lacks. This file holds the same rule from outside, derived from the body, and
 *   holds that the one per-type key is named once.
 * - **A second door for the brand.** `derivedFromStored` mints a `ParsedSpaceMeta` from what a store already holds, with no parse: it
 *   is the named trusted source (the effective meta is own definitions laid under layers, each parsed when it was stored). A caller that
 *   handed it something that arrived from outside would launder it past the one parse, so the callers are derived from the tree and held
 *   to the store that owns the derivation.
 *
 * Run: node --test testing/standalone/the-meta-field-table-covers-the-body-and-its-trusted-source-has-one-home.test.js
 * (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources, readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { SpaceMetaBody } = await import('../../server/dist/spaces/body-schemas.js');
const fields = await import('../../server/dist/spaces/meta-fields.js');

/** The one store that derives a meta from stored parts, and the module that mints the brand. */
const HOMES = new Set(['server/src/spaces/effective-meta.ts', 'server/src/spaces/body-schemas.ts']);

describe('the merge table covers every key the meta body accepts', () => {
  const bodyKeys = Object.keys(SpaceMetaBody.shape);

  it('reads the body (a table checked against nothing would pass)', () => {
    assert.ok(bodyKeys.length >= 9, `only ${bodyKeys.length} keys read from SpaceMetaBody`);
  });

  it('every key of the body has a kind, and every kind is one the merges know', () => {
    const kinds = new Set(['scalar', 'object-replaced-whole', 'per-type', 'replaced-whole']);
    for (const key of bodyKeys) {
      const kind = fields.metaFieldKind(key);
      assert.ok(kind, `SpaceMetaBody accepts '${key}' and the merge table gives it no kind: a merge would not carry it`);
      assert.ok(kinds.has(kind), `'${key}' has the kind '${kind}', which no merge reads`);
    }
  });

  it('no row of the table names a key the body does not accept (a stale row decides nothing)', () => {
    assert.deepEqual(Object.keys(fields.META_FIELD_KINDS).filter(k => !bodyKeys.includes(k)), [],
      'the table has a kind for a key SpaceMetaBody no longer accepts');
  });

  it('exactly one key is per-type, and it is the one the walkers inside the types name', () => {
    const perType = Object.entries(fields.META_FIELD_KINDS).filter(([, kind]) => kind === 'per-type').map(([k]) => k);
    assert.deepEqual(perType, [fields.PER_TYPE_META_FIELD]);
    assert.equal(fields.PER_TYPE_META_FIELD, 'typeSchemas');
  });

  it('a key with no kind is not merged, and a prototype-named key is not a field', () => {
    const merged = fields.mergeMetaFields({ purpose: 'a' }, { purpose: 'b', aKeyFromTheFuture: 1, ...JSON.parse('{"constructor":{"x":1}}') }, () => ({}));
    assert.deepEqual(merged, { purpose: 'b' }, 'a key the table has no kind for was carried by a merge');
    assert.equal(fields.metaFieldKind('constructor'), undefined);
    assert.equal(fields.metaFieldKind('toString'), undefined);
    assert.deepEqual(fields.unknownMetaFields(['purpose', 'nope', 'version']), ['nope', 'version'],
      'housekeeping the server owns is not a merge field either: a tolerant reader names it, it never stores it');
  });

  it('the names a reader reports are bounded in count and in length', () => {
    const many = Array.from({ length: 500 }, (_, i) => `k${i}`);
    const named = fields.boundedNames(many);
    assert.equal(named.length, fields.MAX_UNKNOWN_NAMES + 1, 'the list is bounded, plus the one entry that says how many more');
    assert.match(named.at(-1), /\(\+450 more\)/);
    assert.ok(fields.boundedNames(['x'.repeat(100_000)])[0].length < 400, 'one name of 100 000 characters was echoed whole');
  });
});

describe('derivedFromStored has one home', () => {
  const calls = () => readTrackedSources('server/src', { untracked: true, floor: 300 })
    .filter(({ text }) => /\bderivedFromStored\s*\(/.test(stripComments(text)))
    .map(f => f.file);

  it('reads a tree worth reading, and the trusted source is used at all (a floor)', () => {
    assert.ok(trackedSources('server/src', { floor: 300 }).length >= 300);
    assert.ok(calls().length >= 2, `only ${calls().length} file(s) mention derivedFromStored: the scan lost its subject`);
  });

  it('only the effective-meta store (and the module that defines it) names it', () => {
    const strangers = calls().filter(f => !HOMES.has(f));
    assert.deepEqual(strangers, [],
      'a meta that did not come from a store was given the brand without a parse (call parseSpaceMeta, which reads what arrives): '
      + strangers.join(', '));
  });
});
