/**
 * The filter finds the records saved under one definition of their type, `schemaVersion: 'sameAs:<fp>'`, alike on both doors (Q-744,
 * bundle-268 design r3 §1 `sameAsIn`, r4 §3.2, §5.4 and §10 T4).
 *
 * ## The contract (written before the code)
 *
 * - `sameAs:<fp>` matches, per type, the records whose stamp is the same as `fp` for that type (the diff, mode `any`, names neither the
 *   type nor its kind `all`), plus every record stamped `fp` itself. It never matches an unversioned record, nor one whose version is
 *   not held or unclassified (other than `fp` itself).
 * - `sameAs:<fp>` with an `fp` not held matches only the records stamped `fp`.
 * - A malformed `sameAs:` is refused 400 naming `schemaVersion`.
 * - On `space_schema_versions`, a `type` sent as an object through MCP is refused naming `type`, never as an unknown argument.
 *
 * ## Fixture (space SA)
 *
 * v1: A{p}, B{x}. v2: A{q}, B{x} described. v3 (current): A{p}, B{x}. Records A and B at each version, A at a version not held, and
 * one unstamped A. `sameAs:v1` is A@v1, A@v3, B@v1, B@v3.
 *
 * ## Seen red at 327b105e
 *
 * `sameAs:` is refused 400 (schema-version-args.ts:77): it is no `schemaVersion` the filter knows.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/the-filter-finds-records-by-definition-on-both-doors-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { recordOf, saveVersion } from './_schema-version-fixtures.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SA = 'thsameas';
const META = { suppressEmbeddings: true };
const NOT_HELD = 'e'.repeat(64);
const str = (p) => ({ propertySchemas: { [p]: { type: 'string' } } });
const Bx = { propertySchemas: { x: { type: 'number' } } };

let d, owner, v1, v2, v3;
const seeded = new Map();
const idsOf = (...tags) => tags.flatMap(t => seeded.get(t) ?? assert.fail(`no seed ${t}`)).sort();

const DOORS = {
  REST: async (args) => {
    const r = await d.rest(owner.key, 'POST', '/api/filter', args);
    const body = r.body?.data ?? r.body ?? {};
    return { refused: r.status >= 400, status: r.status, ids: (body.results ?? []).map(x => x._id).sort(), text: r.text };
  },
  MCP: async (args) => {
    const r = await d.mcp(owner.key, 'filter', args);
    return { refused: r.isError, status: r.status, ids: (r.structured?.results ?? []).map(x => x._id).sort(), text: r.text };
  },
};

describe('the filter by definition, sameAs:<fp> (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'thsameas', spaces: [SA] });
    owner = await d.mint('ths-owner', { [SA]: d.row({ schema: 'read', knowledge: 'read' }) });
    v1 = await saveVersion(SA, { ...META, typeSchemas: { entity: { A: str('p'), B: Bx } } });
    v2 = await saveVersion(SA, { ...META, typeSchemas: { entity: { A: str('q'), B: { ...Bx, description: 'now described' } } } });
    v3 = await saveVersion(SA, { ...META, typeSchemas: { entity: { A: str('p'), B: Bx }, fact: { F: str('f') } } });
    let i = 0;
    for (const [tag, type, fp] of [['A@v1', 'A', v1.fp], ['A@v2', 'A', v2.fp], ['A@v3', 'A', v3.fp], ['B@v1', 'B', v1.fp], ['B@v2', 'B', v2.fp],
      ['B@v3', 'B', v3.fp], ['A@nh', 'A', NOT_HELD], ['A@-', 'A', null]]) {
      const docs = [recordOf('entities', SA, ++i, { type, fp })];
      await d.door.coll(SA, 'entities').insertMany(docs);
      seeded.set(tag, docs.map(x => x._id));
    }
  });
  after(async () => { await d?.close(); });

  for (const [door, call] of Object.entries(DOORS)) {
    describe(door, () => {
      const q = (schemaVersion) => call({ space: SA, collection: 'entities', schemaVersion, limit: 100 });

      it('sameAs:v1 finds each type\'s records on a version that defines it as v1 does', async () => {
        const r = await q(`sameAs:${v1.fp}`);
        assert.ok(!r.refused, r.text.slice(0, 300));
        assert.deepEqual(r.ids, idsOf('A@v1', 'A@v3', 'B@v1', 'B@v3'));
      });

      it('sameAs:v2 is per type: A only at v2, B at none but v2 (its wording differs from v1 and v3)', async () => {
        const r = await q(`sameAs:${v2.fp}`);
        assert.ok(!r.refused, r.text.slice(0, 300));
        assert.deepEqual(r.ids, idsOf('A@v2', 'B@v2'));
      });

      it('sameAs:<a version not held> matches only the records stamped with it', async () => {
        const r = await q(`sameAs:${NOT_HELD}`);
        assert.ok(!r.refused, r.text.slice(0, 300));
        assert.deepEqual(r.ids, idsOf('A@nh'));
      });

      it('a malformed sameAs is refused naming schemaVersion', async () => {
        for (const bad of ['sameAs:', 'sameAs:abc', `sameAs:${'A'.repeat(64)}`, `sameas:${v1.fp}`]) {
          const r = await q(bad);
          assert.ok(r.refused, `${bad} was answered`);
          if (door === 'REST') assert.equal(r.status, 400, bad);
          assert.match(r.text, /schemaVersion/, bad);
        }
      });
    });
  }

  it('MCP space_schema_versions refuses a type sent as an object, naming type, not as an unknown argument', async () => {
    const r = await d.mcp(owner.key, 'space_schema_versions', { space: SA, kind: 'entity', type: { $ne: 'A' } });
    assert.ok(r.isError, `an object type was answered: ${r.text.slice(0, 200)}`);
    assert.match(r.text, /\btype\b/);
    assert.doesNotMatch(r.text, /unexpected property|additional propert/i, 'refused as an unknown argument, not for its shape');
  });
});
