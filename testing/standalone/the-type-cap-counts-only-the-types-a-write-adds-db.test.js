/**
 * The cap on type definitions per knowledge type counts only the types a write ADDS (bundle-270, Q-754, design revision 3, challenge F10): one
 * check (`spaces/types-added-past-cap.ts`) that the per-type route and the schema-from-RDF door ask.
 *
 * ## What it holds
 *
 * - The check: a write that adds no type passes on a kind already at the cap; a write whose new types would take a kind past it is refused,
 *   naming the kind; types of another kind, and types the write only replaces, are not counted.
 * - The per-type route answers as before: an update of a stored type passes on a kind at the cap, and a new type there is 400 with the same
 *   sentence.
 *
 * Run: node --test testing/standalone/the-type-cap-counts-only-the-types-a-write-adds-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-type-cap-');
const skip = await mongoSkipReason();
/** The route's figure, written here as the sentence states it: the check's own constant is what is tested against it. */
const CAP = 200;
const typesOf = (n, prefix = 't') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, {}]));

describe('the type cap counts only the types a write adds', { skip }, () => {
  let inst;
  before(async () => {
    await openTestMongo('type_cap');
    inst = await bootSchemaInstance(dir, {
      spaces: [{ id: 'full', label: 'Full', folders: [], meta: { suppressEmbeddings: true, typeSchemas: { entity: typesOf(CAP), fact: typesOf(3) } } }],
    });
  });
  /** The check's module, loaded by the cases that ask it, so the route's case runs whatever the build holds. */
  const check = () => import('../../server/dist/spaces/types-added-past-cap.js');
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  it('the check: a write adding no type passes on a kind at the cap; one new type past it is refused, naming the kind', async () => {
    const cap = await check();
    const stored = { entity: typesOf(CAP), fact: typesOf(3) };
    assert.equal(cap.typesAddedPastCap(stored, { entity: { t0: { propertySchemas: {} }, t7: {} } }), null, 'replacing stored types counts as adding');
    assert.equal(cap.typesAddedPastCap(stored, { fact: typesOf(10, 'f') }), null, 'another kind\'s types were counted');
    const refused = cap.typesAddedPastCap(stored, { entity: { t0: {}, fresh: {} } });
    assert.ok(refused, 'a new type on a kind at the cap passed');
    assert.equal(refused.status, 400);
    assert.equal(refused.error, `Max ${CAP} type definitions per knowledge type reached for 'entity'. Remove unused types before adding new ones.`);
  });

  it('the check: new types are counted together, so a write that fits one at a time but not all at once is refused', async () => {
    const cap = await check();
    const stored = { entity: typesOf(CAP - 2) };
    assert.equal(cap.typesAddedPastCap(stored, { entity: typesOf(2, 'n') }), null, 'two new types fit the two places left');
    assert.ok(cap.typesAddedPastCap(stored, { entity: typesOf(3, 'n') }), 'three new types took the kind past the cap');
    assert.equal(cap.typesAddedPastCap(undefined, { entity: typesOf(CAP, 'n') }), null, 'a space with no types takes up to the cap');
    assert.ok(cap.typesAddedPastCap(undefined, { entity: typesOf(CAP + 1, 'n') }));
  });

  it('the route: an update of a stored type passes on a kind at the cap, and a new type there is 400 with the same sentence', async () => {
    inst.reset();
    const update = await inst.doors['put-single-type']('full', { typeSchemas: { entity: { t5: { propertySchemas: { size: { type: 'number' } } } } } });
    assert.equal(update.status, 200, update.text.slice(0, 300));
    const added = await inst.doors['put-single-type']('full', { typeSchemas: { entity: { brandNew: {} } } });
    assert.equal(added.status, 400, added.text.slice(0, 300));
    assert.equal(added.body?.error, `Max ${CAP} type definitions per knowledge type reached for 'entity'. Remove unused types before adding new ones.`);
    assert.ok(!('brandNew' in inst.heldTypes('full').entity));
  });
});
