/**
 * The older mark on a type row is true exactly when the `older` filter (with `schemaChanged: 'any'`) finds a record of that type, and both
 * equal an independent oracle (Q-744, bundle-268 design r4 §3.3, §4, §5.1, §5.3, §10 T3).
 *
 * ## The contract (written before the code)
 *
 * - `GET /api/spaces/:id/schema-versions?kind=<kind>` and MCP `space_schema_versions { space, kind }` answer
 *   `{ kind, current, types: [{ type, declared: 'own' | 'layer' | 'none', networks?, older? }], count, total, limit, skip, truncated, nextSkip? }`.
 *   `older` is on every `own` row of a caller holding `knowledge: read` (or an administrator).
 * - The glyph rule (06a): `older` is true exactly when `filter { <type field>: T, schemaVersion: 'older', schemaChanged: 'any' }` finds a
 *   record. Records whose definition this instance cannot tell (a version not held, an unread place, a stamp some record of which has a
 *   type that is not a string) count as older.
 * - `fps=<fp,...>&kind=<kind>&type=<T>` answers `{ kind, type, current, standings: [{ fp, standing: 'current' | 'older' | 'notHeld' |
 *   'unclassified', definition? }] }`; `current` means the stamp is the same as the current version for T.
 *
 * ## The oracle
 *
 * `olderOracle` (`_type-history.mjs`) reads every record and every snapshot text directly and decides sameness with
 * `typesDifferingUnder` alone. It is checked first against the hand-stated {@link EXPECT}, so a broken oracle is a red of its own.
 *
 * ## Fixture (space S; v1 -> v2 -> v3 current)
 *
 * v2 renames A's property (structural), rewords B, changes edge `knows` and chrono `Z`, and adds a space rule over facts (every fact type
 * `all`); v3 adds entity H. P is a held fetched text: v3 plus entity D. Plants: G only at P beside a record whose type is the number 42
 * (P is unnamed, so unclassified); K only at a version not held; M at v2 beside a stamped `['M', 'X']` (v2 unnamed); an unstamped `['C']`
 * and an unstamped C; E and H only on current; C, likes and Q only on versions that define them the same.
 *
 * ## Seen red at 327b105e
 *
 * The `kind` form does not exist: REST ignores the parameter and answers the version list (no `types`), MCP refuses `kind` as an unknown
 * argument. A mutation check after the build: flipping `notSameFor` must turn the per-type comparison red.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/the-older-mark-is-true-exactly-when-the-older-filter-finds-a-record-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { snapshotRow, snapshotsOf, linksOf, sha256 } from './_schema-snapshot-peer.mjs';
import { recordOf, saveVersion } from './_schema-version-fixtures.mjs';
import { typeDoors, allPages, rowsByType, olderOracle, KIND_PARTS, typeFieldOfKind } from './_type-history.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SUITE = 'tholder';
const S = 'tholder';
const META = { suppressEmbeddings: true };
const NOT_HELD = 'e'.repeat(64);

/** The mark each own type must carry, stated by hand from the fixture above. */
const EXPECT = Object.freeze({
  entity: { A: true, B: true, C: false, E: false, G: true, H: false, K: true, M: true },
  fact: { F: true, F2: false },
  edge: { knows: true, likes: false },
  chrono: { Q: false, Z: true },
});

const str = (p) => ({ propertySchemas: { [p]: { type: 'string' } } });
const V1 = {
  entity: { A: str('p'), B: { propertySchemas: { x: { type: 'number' } } }, C: str('c'), E: str('e'), G: str('g'), K: str('k'), M: str('m') },
  edge: { knows: { propertySchemas: { w: { type: 'number' } } }, likes: {} },
  fact: { F: str('f'), F2: str('f2') },
  chrono: { Q: str('q'), Z: { propertySchemas: { z: { type: 'number' } } } },
};
const V2 = structuredClone(V1);
V2.entity.A = str('q');
V2.entity.B = { ...V1.entity.B, description: 'now described' };
V2.edge.knows = { propertySchemas: { w: { type: 'string' } } };
V2.chrono.Z = { propertySchemas: { z: { type: 'string' } } };
const RULES2 = { tagged: { rule: 'size(self.tags) > 0', message: 'tag it', kinds: ['fact'] } };
const V3 = structuredClone(V2);
V3.entity.H = str('h');

let d, doors, owner, v1, v2, v3, P;

describe('the older mark equals the older filter and the oracle (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: SUITE, openDoor: () => openPullDoor({
      suite: SUITE, spaces: [S], type: 'club', direction: 'both', meta: { [S]: META },
    }) });
    doors = typeDoors(d);
    owner = await d.mint('tho-owner', { [S]: d.row({ schema: 'read', knowledge: 'read' }) });
    v1 = await saveVersion(S, { ...META, typeSchemas: V1 });
    v2 = await saveVersion(S, { ...META, typeSchemas: V2, rules: RULES2 });
    v3 = await saveVersion(S, { ...META, typeSchemas: V3, rules: RULES2 });
    const { canonicalJson } = await import('../../server/dist/util/canonical-json.js');
    const pDoc = JSON.parse(v3.text);
    pDoc.typeSchemas.entity.D = str('d');
    const pText = canonicalJson(pDoc);
    P = { text: pText, fp: sha256(pText) };
    await snapshotsOf(d.door.mongo, S).insertOne(snapshotRow({ fp: P.fp, text: P.text, origin: 'fetched', from: 'a-peer', links: linksOf(P.fp) }));

    let i = 0;
    const put = (part, type, fp, n = 1) => d.door.coll(S, part).insertMany(Array.from({ length: n }, () => recordOf(part, S, ++i, { type, fp })));
    await put('entities', 'A', v1.fp, 2); await put('entities', 'A', v3.fp);
    await put('entities', 'B', v1.fp); await put('entities', 'B', v3.fp);
    await put('entities', 'C', v1.fp, 2); await put('entities', 'C', v3.fp); await put('entities', ['C'], null); await put('entities', 'C', null);
    await put('entities', 'E', v3.fp);
    await put('entities', 'G', P.fp); await put('entities', 42, P.fp);
    await put('entities', 'H', v3.fp);
    await put('entities', 'K', NOT_HELD);
    await put('entities', 'M', v2.fp); await put('entities', ['M', 'X'], v2.fp);
    await put('facts', 'F', v1.fp); await put('facts', 'F2', v3.fp);
    await put('edges', 'knows', v1.fp); await put('edges', 'likes', v1.fp);
    await put('chrono', 'Q', v1.fp); await put('chrono', 'Z', v1.fp);
    const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
    assert.deepEqual((await ensureTtlIndexes(S)).failed, [], 'the stamp indexes did not build');
  });
  after(async () => { await d?.close(); });

  it('the oracle says what the fixture was built to say (a broken oracle is a red of its own)', async () => {
    for (const [kind, types] of Object.entries(EXPECT)) {
      for (const [T, want] of Object.entries(types)) {
        assert.equal((await olderOracle(d.door.mongo, S, kind, T)).older, want, `the oracle says ${kind}/${T} older=${!want}`);
      }
    }
  });

  it('the older filter (any) finds a record of T exactly for the types the oracle marks, on both doors', async () => {
    for (const [kind, types] of Object.entries(EXPECT)) {
      for (const T of Object.keys(types)) {
        const args = { space: S, collection: KIND_PARTS[kind], filter: { [typeFieldOfKind(kind)]: T }, schemaVersion: 'older', schemaChanged: 'any', limit: 1 };
        const rest = await d.rest(owner.key, 'POST', '/api/filter', args);
        assert.equal(rest.status, 200, rest.text.slice(0, 300));
        const mcp = await d.mcp(owner.key, 'filter', args);
        assert.ok(!mcp.isError, mcp.text.slice(0, 300));
        const restFound = ((rest.body?.data ?? rest.body)?.results ?? []).length > 0;
        assert.equal(restFound, EXPECT[kind][T], `REST filter older any ${kind}/${T}`);
        assert.equal((mcp.structured?.results ?? []).length > 0, EXPECT[kind][T], `MCP filter older any ${kind}/${T}`);
      }
    }
  });

  for (const door of ['REST', 'MCP']) {
    describe(door, () => {
      it('every own type of every kind is listed once, declared own, and its mark equals the oracle and the filter', async () => {
        for (const [kind, types] of Object.entries(EXPECT)) {
          const { rows, last } = await allPages(doors[door], owner.key, S, { kind }, 'types');
          assert.equal(last.body.kind, kind, `${kind}: the answer does not echo kind (an older server)`);
          assert.equal(last.body.current, v3.fp, `${kind}: the answer does not name the current version`);
          assert.equal(last.body.recordFacts, undefined, `${kind}: record facts withheld from a caller holding knowledge: read`);
          const byType = rowsByType(rows);
          assert.equal(byType.size, rows.length, `${kind}: a type is listed twice`);
          const own = rows.filter(r => r.declared === 'own').map(r => r.type).sort();
          assert.deepEqual(own, Object.keys(types).sort(), `${kind}: the own types listed are not the current version's`);
          const marks = Object.fromEntries(own.map(T => [T, byType.get(T).older]));
          assert.deepEqual(marks, { ...types }, `${kind}: the marks are not the oracle's`);
          for (const r of rows) {
            assert.ok(Object.keys(r).every(k => ['type', 'declared', 'networks', 'older'].includes(k)), `${kind}/${r.type}: a row carries ${Object.keys(r)}`);
            if (r.declared !== 'own') assert.equal(r.older, undefined, `${kind}/${r.type}: a ${r.declared} row carries a mark`);
          }
        }
      });

      it('the fps read answers each stamp of T the standing the oracle gives it', async () => {
        for (const [kind, types] of Object.entries(EXPECT)) {
          for (const T of Object.keys(types)) {
            const { stamps } = await olderOracle(d.door.mongo, S, kind, T);
            const fps = [...stamps.keys()].sort();
            assert.ok(fps.length > 0, `${kind}/${T}: the fixture gives T no stamp`);
            const r = await doors[door](owner.key, S, { fps, kind, type: T });
            assert.ok(!r.refused, `${kind}/${T}: ${r.text.slice(0, 300)}`);
            assert.deepEqual({ kind: r.body.kind, type: r.body.type }, { kind, type: T }, `${kind}/${T}: no echo`);
            const got = new Map((r.body.standings ?? []).map(s => [s.fp, s.standing]));
            assert.deepEqual(new Map([...got].sort()), new Map([...stamps].sort()), `${kind}/${T}: the standings are not the oracle's`);
          }
        }
      });
    });
  }

  it('a type with a stamp the filter cannot classify is marked, and an unstamped array record marks nothing', async () => {
    const r = await doors.REST(owner.key, S, { kind: 'entity' });
    assert.ok(Array.isArray(r.body.types), `the kind form is not answered: ${r.text.slice(0, 300)}`);
    const byType = rowsByType(r.body.types);
    assert.equal(byType.get('G')?.older, true, 'G, only at a stamp one of whose records has a numeric type, is not marked');
    assert.equal(byType.get('M')?.older, true, 'M, at a stamp an array-typed record shares, is not marked');
    assert.equal(byType.get('C')?.older, false, 'C, same everywhere it is stamped, is marked (an unstamped array record leaked in)');
    assert.equal(byType.get('E')?.older, false, 'E, only on current, is marked');
  });
});
