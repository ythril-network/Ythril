/**
 * A type's history groups the versions its records carry into definitions, in keeping order, bounded, on both doors (Q-744, bundle-268
 * design r4 §1 R4, §5.2, §10 T2; r3 §5.5, §7.3).
 *
 * ## The contract (written before the code)
 *
 * - `GET /api/spaces/:id/schema-versions?kind=<kind>&type=<T>` / MCP `space_schema_versions { space, kind, type }` answer
 *   `{ kind, type, current, declared, recordFacts?, cut?, definitions: [{ rep, current, since?, until?, origin: { edited, networks,
 *   fetched } }], count, total, limit, skip, truncated, nextSkip? }`. A definition is a class of `~T` (the diff names neither T nor T's
 *   kind `all`) among the held stamps T's records carry, plus current. Exactly one is `current`, and its `rep` is the current version.
 * - A class all of whose versions were fetched sets no span. A class kept here has `since` = the keeping time of its first version.
 * - `CLASS_MAX = 64` (spaces/type-history.js): the 64th class is drawn; past it, or past `COMPARE_MAX = 4096` representative
 *   comparisons, the rest is not listed and the answer carries `cut: true`.
 * - R4 `fingerprintsOfType(spaceId, collection, T, timeLeft)` (spaces/schema-snapshot-carried.js) answers exactly the stamps T's records carry.
 * - A type named `__proto__` is a name like any other (rows are keyed by `Map`). A name over `TYPE_NAME_MAX` is refused 400 naming `type`.
 * - No answer carries a record figure: none of `counts`, `records`, `notCurrent`, `stamped`, `totals`, `unversioned`, `changes`.
 *
 * ## Fixture (space H, entity A; keeping order by `at`)
 *
 * h1 A{p} (Jan), h2 A{p}+B (Feb), h3 A{q} (Mar), f1 A{z} fetched (Mar 15), h4 A{p}+B{b2} (Apr), e1 A{r} and e2 A{r}+B{e} (both May 1),
 * current A{p,s}. Classes: {current}, {h1,h2,h4}, {h3}, {f1}, {e1,e2}. `__proto__` records at h1 and h3. Space CAP: 63 versions of A,
 * each its own definition, plus current (64 classes), then two more. Space CMP: 200 versions cycling through 40 definitions of A.
 *
 * ## Seen red at 327b105e
 *
 * The `kind` + `type` form is unknown: REST answers the version list, MCP refuses `kind` and `type`; R4 and `CLASS_MAX` do not exist.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-type-history-groups-versions-into-definitions-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { snapshotOf, snapshotRow, snapshotsOf, linksOf } from './_schema-snapshot-peer.mjs';
import { recordOf, saveVersion } from './_schema-version-fixtures.mjs';
import { typeDoors, allPages, need } from './_type-history.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SUITE = 'thhist';
const [H, CAP, CMP] = ['thhist', 'thhistcap', 'thhistcmp'];
const META = { suppressEmbeddings: true };
const FIGURES = ['counts', 'records', 'notCurrent', 'stamped', 'totals', 'unversioned', 'changes', 'versions'];

const A = (props, extra = {}) => ({ entity: { A: { propertySchemas: Object.fromEntries(props.map(p => [p, { type: 'string' }])) }, ...extra } });
const at = (month, day = 1) => `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;

let d, doors, owner, V = {}, cur, capCur, cmpCur;
let rid = 0;

/** A kept own row (or a fetched one) for `typeSchemas` at `when`, and `n` records of `type` stamped with it. */
async function keep(space, typeSchemas, when, { origin = 'own', type = 'A', n = 1 } = {}) {
  const v = await snapshotOf({ typeSchemas });
  await snapshotsOf(d.door.mongo, space).insertOne(snapshotRow({ fp: v.fp, text: v.text, origin, ...(origin === 'fetched' ? { from: 'a-peer' } : {}), links: linksOf(v.fp), at: when }));
  await d.door.coll(space, 'entities').insertMany(Array.from({ length: n }, () => recordOf('entities', space, ++rid, { type, fp: v.fp })));
  return v;
}

/** Which named class a stamp belongs to, by the fixture. */
const classOf = (fp) => Object.entries(V).find(([, v]) => v.fp === fp)?.[0]?.replace(/^(h1|h2|h4)$/, 'X').replace(/^(e1|e2)$/, 'R') ?? (fp === cur?.fp ? 'current' : `? ${fp}`);

/** Every key anywhere in `value`. */
const keysIn = (value, out = new Set()) => {
  if (Array.isArray(value)) { for (const v of value) keysIn(v, out); return out; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysIn(v, out); }
  return out;
};

describe('a type history groups versions into definitions (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: SUITE, openDoor: () => openPullDoor({
      suite: SUITE, spaces: [H, CAP, CMP], type: 'club', direction: 'both', meta: { [H]: META, [CAP]: META, [CMP]: META },
    }) });
    doors = typeDoors(d);
    owner = await d.mint('thh-owner', Object.fromEntries([H, CAP, CMP].map(s => [s, d.row({ schema: 'read', knowledge: 'read' })])));
    V.h1 = await keep(H, A(['p']), at(1));
    V.h2 = await keep(H, A(['p'], { B: {} }), at(2));
    V.h3 = await keep(H, A(['q']), at(3));
    V.f1 = await keep(H, A(['z']), at(3, 15), { origin: 'fetched' });
    V.h4 = await keep(H, A(['p'], { B: { description: 'b2' } }), at(4));
    V.e1 = await keep(H, A(['r']), at(5));
    V.e2 = await keep(H, A(['r'], { B: { description: 'e' } }), at(5));
    for (const fp of [V.h1.fp, V.h3.fp]) await d.door.coll(H, 'entities').insertOne(recordOf('entities', H, ++rid, { type: '__proto__', fp }));
    cur = await saveVersion(H, { ...META, typeSchemas: A(['p', 's']) });
    await d.door.coll(H, 'entities').insertOne(recordOf('entities', H, ++rid, { type: 'A', fp: cur.fp }));

    for (let i = 0; i < 63; i++) await keep(CAP, A([`c${i}`]), at(1 + Math.floor(i / 28), 1 + (i % 28)));
    capCur = await saveVersion(CAP, { ...META, typeSchemas: A(['current']) });

    for (let j = 0; j < 200; j++) await keep(CMP, A([`k${j % 40}`], { B: { description: `step ${j}` } }), new Date(Date.UTC(2026, 0, 1) + j * 3_600_000).toISOString());
    cmpCur = await saveVersion(CMP, { ...META, typeSchemas: A(['current']) });
    const { ensureTtlIndexes } = await import('../../server/dist/spaces/space-indexes.js');
    for (const s of [H, CAP, CMP]) assert.deepEqual((await ensureTtlIndexes(s)).failed, [], `${s}: the stamp index did not build`);
  });
  after(async () => { await d?.close(); });

  for (const door of ['REST', 'MCP']) {
    describe(door, () => {
      it('the definitions are the classes: current, {h1,h2,h4}, {h3}, {f1}, {e1,e2}, each once, current first-class and alone', async () => {
        const { rows, last } = await allPages(doors[door], owner.key, H, { kind: 'entity', type: 'A' }, 'definitions');
        assert.deepEqual({ kind: last.body.kind, type: last.body.type, declared: last.body.declared, current: last.body.current },
          { kind: 'entity', type: 'A', declared: 'own', current: cur.fp });
        assert.deepEqual(rows.map(r => classOf(r.rep)).sort(), ['R', 'X', 'current', 'f1', 'h3'], 'the definitions are not the classes of ~A');
        assert.deepEqual(rows.filter(r => r.current).map(r => r.rep), [cur.fp], 'not exactly one current definition, or its rep is not the current version');
        assert.equal(last.body.cut, undefined, 'a history under every bound says it was cut');
      });

      it('spans follow keeping order; an all-fetched class sets none; origin says where the version is now', async () => {
        const { rows } = await allPages(doors[door], owner.key, H, { kind: 'entity', type: 'A' }, 'definitions');
        const by = new Map(rows.map(r => [classOf(r.rep), r]));
        assert.equal(by.get('X')?.since, at(1), 'the class of h1, h2 and h4 does not start at h1\'s keeping');
        assert.equal(by.get('h3')?.since, at(3));
        assert.equal(by.get('R')?.since, at(5), 'the equal-time class does not start at its keeping');
        const fetched = by.get('f1');
        assert.ok(fetched && fetched.since === undefined && fetched.until === undefined, `a class kept only by fetching has a span: ${JSON.stringify(fetched)}`);
        assert.equal(fetched.origin?.fetched, true);
        assert.equal(by.get('X')?.origin?.edited, true, 'an own class is not answered edited here');
        assert.equal(by.get('current')?.until, undefined, 'the current definition has an end');
        for (const r of rows) assert.ok(Array.isArray(r.origin?.networks), `${classOf(r.rep)}: origin.networks is not a list`);
      });

      it('no answer carries a record figure', async () => {
        const answers = [await doors[door](owner.key, H, { kind: 'entity', type: 'A' }), await doors[door](owner.key, H, { kind: 'entity' })];
        for (const a of answers) {
          assert.ok(!a.refused, a.text.slice(0, 300));
          const figures = FIGURES.filter(k => keysIn(a.body).has(k));
          assert.deepEqual(figures, [], `the answer carries ${figures}`);
        }
      });

      it('a type named __proto__ is a name like any other; a name over TYPE_NAME_MAX is refused naming type', async () => {
        const r = await doors[door](owner.key, H, { kind: 'entity', type: '__proto__' });
        assert.ok(!r.refused, r.text.slice(0, 300));
        assert.equal(r.body.type, '__proto__');
        assert.equal(r.body.declared, 'none');
        assert.equal(r.body.definitions?.length, 1, '__proto__ at h1 and h3 (neither declares it) is not one definition');
        assert.equal(({}).polluted, undefined);
        // The bound lives in the schema package (schema/src/space-meta.ts, design r3 §2), exported beside the per-type maps it bounds.
        const { TYPE_NAME_MAX } = await import('../../schema/dist/internal.js');
        assert.equal(typeof TYPE_NAME_MAX, 'number', 'the schema package exports no TYPE_NAME_MAX');
        const long = await doors[door](owner.key, H, { kind: 'entity', type: 'T'.repeat(TYPE_NAME_MAX + 1) });
        assert.ok(long.refused, `a type name over the bound was answered: ${long.text.slice(0, 200)}`);
        if (door === 'REST') assert.equal(long.status, 400);
        assert.match(long.text, /\btype\b/);
        assert.doesNotMatch(long.text, /unexpected property|additional propert/i, 'refused as an unknown argument, not for its length');
      });

      it('CLASS_MAX: the 64th class is drawn with no cut; two more versions cut the list at 64', async () => {
        const { CLASS_MAX } = await need('spaces/type-history.js', ['CLASS_MAX']);
        assert.equal(CLASS_MAX, 64);
        const whole = await allPages(doors[door], owner.key, CAP, { kind: 'entity', type: 'A' }, 'definitions');
        assert.equal(whole.rows.length, 64, 'the 64 classes are not all drawn');
        assert.equal(whole.last.body.cut, undefined, '64 classes were cut');
      });
    });
  }

  it('past CLASS_MAX the list is cut at 64 and says so, on both doors', async () => {
    await keep(CAP, A(['late1']), at(4, 1));
    await keep(CAP, A(['late2']), at(4, 2));
    for (const door of ['REST', 'MCP']) {
      const { rows, last } = await allPages(doors[door], owner.key, CAP, { kind: 'entity', type: 'A' }, 'definitions');
      assert.equal(last.body.cut, true, `${door}: 66 classes are not cut`);
      assert.equal(rows.length, 64, `${door}: the cut list does not draw 64`);
      assert.ok(rows.some(r => r.rep === capCur.fp && r.current), `${door}: the cut dropped the current definition`);
    }
  });

  it('COMPARE_MAX: 200 versions cycling through 40 definitions spend the comparisons, and the list says it was cut', async () => {
    const { COMPARE_MAX } = await need('spaces/type-history.js', ['COMPARE_MAX']);
    assert.equal(COMPARE_MAX, 4096);
    for (const door of ['REST', 'MCP']) {
      const { rows, last } = await allPages(doors[door], owner.key, CMP, { kind: 'entity', type: 'A' }, 'definitions');
      assert.equal(last.body.cut, true, `${door}: about 7,000 representative comparisons ran uncut`);
      assert.ok(rows.length <= 41 && rows.some(r => r.rep === cmpCur.fp), `${door}: ${rows.length} definitions, current ${rows.some(r => r.current)}`);
    }
  });

  it('R4 fingerprintsOfType answers exactly the stamps the type\'s records carry', async () => {
    const { fingerprintsOfType } = await need('spaces/schema-snapshot-carried.js', ['fingerprintsOfType']);
    const timeLeft = () => 10_000;
    const want = [V.h1, V.h2, V.h3, V.f1, V.h4, V.e1, V.e2, cur].map(v => v.fp).sort();
    assert.deepEqual([...await fingerprintsOfType(H, 'entities', 'A', timeLeft)].sort(), want);
    assert.deepEqual([...await fingerprintsOfType(H, 'entities', '__proto__', timeLeft)].sort(), [V.h1.fp, V.h3.fp].sort());
    assert.deepEqual([...await fingerprintsOfType(H, 'entities', 'B', timeLeft)], [], 'a type no record carries has stamps');
  });
});
