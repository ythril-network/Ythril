/**
 * A definition's origin says `edited: null` when an own definitions text it needs is no longer kept, and never guesses "Edited here"
 * (bundle-268, Q-744 design r3 §8.2 "edited: null when the own text of X or of Y is no longer held", r4 §5.2; the case r4 left open and the
 * build decided).
 *
 * ## The decision (the build's, recorded here)
 *
 * A definition's origin is read from its oldest version X and the own version Y kept just before X on the space's own line. `edited` asks
 * whether the type differs between X's own definitions text (`links.own`) and Y's. When either text is not kept here any more, the answer is
 * `null`, on both doors, and the definition is still LISTED, with its span and `fetched: false`: the history loses only the origin word, never
 * the definition (the client then shows no "Edited here"). With no Y (X is the first own version) `edited` is whether X's own definitions
 * declare the type, and `null` when that text is gone.
 *
 * ## Fixture (space OG, entity A; keeping order by `at`)
 *
 * v1 A{p} (Jan; own, its `links.own` names a text no row holds), v2 A{r} (Feb; own, `links.own` itself), current A{q}. Records of A at
 * each. Then: v1's own text is gone (null); v2's Y is v1, whose own text is gone (null); current's Y is v2, both kept, A differs (true).
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-type-history-origin-is-unknown-when-an-own-text-is-gone-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { snapshotOf, snapshotRow, snapshotsOf, linksOf } from './_schema-snapshot-peer.mjs';
import { recordOf, saveVersion } from './_schema-version-fixtures.mjs';
import { typeDoors, allPages } from './_type-history.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const OG = 'thorigin';
const META = { suppressEmbeddings: true };
const GONE = 'f'.repeat(64);
const A = (prop) => ({ entity: { A: { propertySchemas: { [prop]: { type: 'string' } } } } });

let d, doors, owner, v1, v2, cur;

describe('a definition whose own text is gone has no origin word (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'thorigin', spaces: [OG] });
    doors = typeDoors(d);
    owner = await d.mint('tho-owner', { [OG]: d.row({ schema: 'read', knowledge: 'read' }) });
    v1 = await snapshotOf({ typeSchemas: A('p') });
    v2 = await snapshotOf({ typeSchemas: A('r') });
    await snapshotsOf(d.door.mongo, OG).insertMany([
      snapshotRow({ fp: v1.fp, text: v1.text, origin: 'own', links: linksOf(GONE), at: '2026-01-01T00:00:00.000Z' }),
      snapshotRow({ fp: v2.fp, text: v2.text, origin: 'own', links: linksOf(v2.fp), at: '2026-02-01T00:00:00.000Z' }),
    ]);
    cur = await saveVersion(OG, { ...META, typeSchemas: A('q') });
    let i = 0;
    await d.door.coll(OG, 'entities').insertMany([v1, v2, cur].map(v => recordOf('entities', OG, ++i, { type: 'A', fp: v.fp })));
    const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
    assert.deepEqual((await ensureTtlIndexes(OG)).failed, [], 'the stamp index did not build');
  });
  after(async () => { await d?.close(); });

  for (const door of ['REST', 'MCP']) {
    it(`${door}: edited is null where an own text is gone, true where both are kept, and every definition is still listed`, async () => {
      const { rows } = await allPages(doors[door], owner.key, OG, { kind: 'entity', type: 'A' }, 'definitions');
      const by = new Map(rows.map(r => [r.rep, r]));
      assert.deepEqual([...by.keys()].sort(), [v1.fp, v2.fp, cur.fp].sort(), 'a definition whose own text is gone is not listed');
      assert.equal(by.get(v1.fp).origin.edited, null, 'the first own version, whose own text is gone, is answered edited or not');
      assert.equal(by.get(v2.fp).origin.edited, null, 'a version whose predecessor\'s own text is gone is answered edited or not');
      assert.equal(by.get(cur.fp).origin.edited, true, 'the current version, after a kept own version that defined A otherwise, is not edited here');
      for (const r of rows) assert.equal(r.origin.fetched, false, `${r.rep}: an own version is answered fetched`);
      assert.equal(by.get(v1.fp).since, '2026-01-01T00:00:00.000Z', 'an origin it cannot tell took the span with it');
    });
  }
});
