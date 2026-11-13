/**
 * The filter finds records by the schema version they carry, alike on both doors (Q-741; bundle-267 design r3 §3, §7 "-db, filter";
 * r2 "Filter meaning"; vet T2/T4/T6, DI 2/6).
 *
 * ## The contract (written before the code)
 *
 * `filter` (REST `POST /api/filter`, MCP `filter`) takes `schemaVersion`: `current | older | unversioned | <64-hex fingerprint>`, and
 * `schemaChanged`: `structural` (default) | `any`, read only with `older`. Resolved PER MEMBER (a personal view's members each have
 * their own current version) and joined under `$and`. Meanings, per member with current text C:
 * - `current`: stamped C. `<fp>`: stamped fp. `unversioned`: no stamp.
 * - `older`: stamped F != C where the diff of F against C changes the record's type in that class (a space rule: every type of the
 *   kinds it governs, untyped records too; a kind's allowlist state: every type of that kind), plus every record whose F is not held.
 *   Never an unversioned record. EMPTY is held. A layer of the current variation is read from the config, row or no row.
 * - The answer carries `schemaVersion: { members: [{ spaceId, current, unclassified }] }` when the argument was sent; `unclassified`
 *   counts the matching records whose version is not held or not classifiable, over the WHOLE match, not the page.
 * - Refused 400 / isError, naming the argument: on `files` and `links`, a malformed fingerprint, `schemaChanged` without `older`.
 *
 * ## Fixture (space A unless named)
 *
 * v1 -> v2: entity A renamed p -> q (structural), entity B's description (wording), fact F unchanged, edge `knows` w number -> string
 * (structural), edge `likes` unchanged. P is a held peer text where A is defined as in v2 and D exists. Records: A@v1 3, B@v1 2,
 * A@v2 4, A@P 2, D@P 1, A@EMPTY 2, A@not-held 3, A unstamped 5; F@v1 2, F@v2 1; knows@v1 2, likes@v1 2, knows@v2 1.
 * Space C: v1 -> v2 adds a space rule over entities and a first fact type (A1, A2). Space B: its own versions, for the view.
 * Space D: a network layer stored while an act stands, so its row lags and its text is the config's alone.
 *
 * ## Seen red at b299cde3
 *
 * `schemaVersion` and `schemaChanged` are not filter arguments: the tool schema is closed, so both doors refuse every case (new code).
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-filter-finds-records-by-schema-version-on-both-doors-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { snapshotRow, snapshotsOf, linksOf, sha256 } from './_schema-snapshot-peer.mjs';
import { recordOf, saveVersion, heldRows, undocumentedKeys, readsDuring } from './_schema-version-fixtures.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SUITE = 'svfilter';
const [A, B, C, D] = ['svfa', 'svfb', 'svfc', 'svfd'];
const META = { suppressEmbeddings: true };
const NOT_HELD = 'e'.repeat(64);

const A1 = { propertySchemas: { p: { type: 'string' } } };
const A2 = { propertySchemas: { q: { type: 'string' } } };
const Bt = { propertySchemas: { x: { type: 'number' } } };
const F = { propertySchemas: { f: { type: 'string' } } };
const metaA = (a, bDesc, w) => ({ ...META, typeSchemas: {
  entity: { A: a, B: bDesc ? { ...Bt, description: bDesc } : Bt },
  fact: { F },
  edge: { knows: { propertySchemas: { w: { type: w } } }, likes: {} },
} });

let d, admin, owner, vA1, vA2, vB1, vB2, vC1, vC2, P, EMPTY, layerFp;

/** One call on one door: `{ refused, status, rows, echo, total, text }`. */
const DOORS = {
  'REST POST /api/filter': async (key, args) => {
    const r = await d.rest(key, 'POST', '/api/filter', args);
    const body = r.body?.data ?? r.body ?? {};
    return { refused: r.status >= 400, status: r.status, rows: body.results ?? [], echo: body.schemaVersion, total: body.total, text: r.text };
  },
  'MCP filter': async (key, args) => {
    const r = await d.mcp(key, 'filter', args);
    const s = r.structured ?? {};
    return { refused: r.isError, status: r.status, rows: s.results ?? [], echo: s.schemaVersion, total: s.total, text: r.text };
  },
};
const ids = (a) => a.rows.map(r => r._id).sort();
const ok = (a, what) => assert.ok(!a.refused, `${what} was refused: ${a.text.slice(0, 400)}`);
const memberOf = (a, spaceId) => a.echo?.members?.find(m => m.spaceId === spaceId);

/** The ids of the records seeded under `tag`, for comparing answers by what was meant, not by count alone. */
const seeded = new Map();
async function seed(spaceId, part, tag, n, opts) {
  const docs = [];
  for (let k = 0; k < n; k++) docs.push(recordOf(part, spaceId, seed.next++, opts));
  await d.door.coll(spaceId, part).insertMany(docs);
  seeded.set(`${spaceId}/${part}/${tag}`, docs.map(x => x._id));
}
seed.next = 1;
const idsOf = (...keys) => keys.flatMap(k => seeded.get(k) ?? assert.fail(`no seed ${k}`)).sort();

describe('the filter by schema version (real MongoDB, both doors)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: SUITE, openDoor: () => openPullDoor({
      suite: SUITE, spaces: [A, B, C, D], type: 'club', direction: 'both', monitorCommands: true, meta: Object.fromEntries([A, B, C, D].map(s => [s, META])),
    }) });
    admin = await d.mint('svf-admin', {}, { admin: true });
    owner = await d.mint('svf-owner', Object.fromEntries([A, B].map(s => [s, d.row({ knowledge: 'read', schema: 'read' })])));
    EMPTY = (await import('../../server/dist/spaces/schema-stamp.js')).EMPTY_SCHEMA_FINGERPRINT;

    vA1 = await saveVersion(A, metaA(A1, undefined, 'number'));
    vA2 = await saveVersion(A, metaA(A2, 'now described', 'string'));
    const { canonicalJson } = await import('../../server/dist/util/canonical-json.js');
    const pText = canonicalJson({ format: 1, typeSchemas: { entity: { A: A2, B: { ...Bt, description: 'now described' }, D: { propertySchemas: { d: { type: 'boolean' } } } }, fact: { F }, edge: metaA(A2, 'x', 'string').typeSchemas.edge }, rules: {} });
    P = { text: pText, fp: sha256(pText) };
    await snapshotsOf(d.door.mongo, A).insertOne(snapshotRow({ fp: P.fp, text: P.text, origin: 'fetched', from: 'a-peer', links: linksOf(P.fp) }));

    await seed(A, 'entities', 'A@v1', 3, { type: 'A', fp: vA1.fp });
    await seed(A, 'entities', 'B@v1', 2, { type: 'B', fp: vA1.fp });
    await seed(A, 'entities', 'A@v2', 4, { type: 'A', fp: vA2.fp });
    await seed(A, 'entities', 'A@P', 2, { type: 'A', fp: P.fp });
    await seed(A, 'entities', 'D@P', 1, { type: 'D', fp: P.fp });
    await seed(A, 'entities', 'A@EMPTY', 2, { type: 'A', fp: EMPTY });
    await seed(A, 'entities', 'A@nh', 3, { type: 'A', fp: NOT_HELD });
    await seed(A, 'entities', 'A@-', 5, { type: 'A' });
    await seed(A, 'facts', 'F@v1', 2, { type: 'F', fp: vA1.fp });
    await seed(A, 'facts', 'F@v2', 1, { type: 'F', fp: vA2.fp });
    await seed(A, 'edges', 'knows@v1', 2, { type: 'knows', fp: vA1.fp });
    await seed(A, 'edges', 'likes@v1', 2, { type: 'likes', fp: vA1.fp });
    await seed(A, 'edges', 'knows@v2', 1, { type: 'knows', fp: vA2.fp });

    vB1 = await saveVersion(B, { ...META, typeSchemas: { entity: { A: A1 } } });
    vB2 = await saveVersion(B, { ...META, typeSchemas: { entity: { A: { propertySchemas: { p: { type: 'string' }, r: { type: 'number' } } } } } });
    await seed(B, 'entities', 'A@vB2', 2, { type: 'A', fp: vB2.fp });
    await seed(B, 'entities', 'A@vB1', 1, { type: 'A', fp: vB1.fp });

    const T = { propertySchemas: { t: { type: 'string' } } };
    vC1 = await saveVersion(C, { ...META, typeSchemas: { entity: { T } } });
    vC2 = await saveVersion(C, { ...META, typeSchemas: { entity: { T }, fact: { G: F } }, rules: { tagged: { rule: 'size(self.tags) > 0', message: 'tag it', kinds: ['entity'] } } });
    await seed(C, 'entities', 'T@v1', 2, { type: 'T', fp: vC1.fp });
    await seed(C, 'entities', 'untyped@v1', 1, { type: null, fp: vC1.fp });
    await seed(C, 'facts', 'X@v1', 2, { type: 'X', fp: vC1.fp });
    await seed(C, 'chrono', 'Y@v1', 1, { type: 'Y', fp: vC1.fp });
    // F3: an edge whose label is not a string, the only edge carrying vC1 (an arrival keeps its writer's stamp unchecked).
    await seed(C, 'edges', 'odd@v1', 1, { type: 42, fp: vC1.fp });

    await saveVersion(D, { ...META, typeSchemas: { entity: { O: { propertySchemas: { o: { type: 'string' } } } } } });
    await seedActEntry(d.loader, { kind: 'wipe', localId: D, state: 'registered' });
    const { readPeerMeta } = await import('../../schema/dist/internal.js');
    const layer = readPeerMeta({ typeSchemas: { entity: { L1: { propertySchemas: { l: { type: 'string' } } } } } });
    assert.ok(layer.ok, layer.message);
    (await import('../../server/dist/spaces/effective-meta.js')).storeNetworkLayer(d.door.NET, D, layer.meta);
    layerFp = (await import('../../server/dist/spaces/schema-stamp.js')).variationOf(D).layers[0].stamp.fp;
    await seed(D, 'entities', 'L1@layer', 2, { type: 'L1', fp: layerFp });

    const made = await d.rest(owner.key, 'POST', '/api/views', { name: 'svfview', members: [A, B] });
    assert.ok(made.status < 300, `the view was not made: ${made.text}`);
  });
  after(async () => { clearActEntries(d?.loader ?? { mutateConfig() {} }); await d?.close(); });

  for (const [door, call] of Object.entries(DOORS)) {
    describe(door, () => {
      const q = (args) => call(admin.key, { space: A, collection: 'entities', limit: 100, ...args });

      it('current, a fingerprint and unversioned select by the stamp alone', async () => {
        const cur = await q({ schemaVersion: 'current' });
        ok(cur, 'current');
        assert.deepEqual(ids(cur), idsOf(`${A}/entities/A@v2`));
        const v1 = await q({ schemaVersion: vA1.fp });
        ok(v1, 'a fingerprint');
        assert.deepEqual(ids(v1), idsOf(`${A}/entities/A@v1`, `${A}/entities/B@v1`));
        const un = await q({ schemaVersion: 'unversioned' });
        ok(un, 'unversioned');
        assert.deepEqual(ids(un), idsOf(`${A}/entities/A@-`));
      });

      it('older (structural, the default) lists A renamed, not B reworded, not A as a peer defines it the same, and never an unversioned record', async () => {
        const o = await q({ schemaVersion: 'older' });
        ok(o, 'older');
        assert.deepEqual(ids(o), idsOf(`${A}/entities/A@v1`, `${A}/entities/D@P`, `${A}/entities/A@EMPTY`, `${A}/entities/A@nh`),
          'older is not: A at v1, D at the peer version, A at the empty schema (its kind gained types) and A at a version not held');
        const explicit = await q({ schemaVersion: 'older', schemaChanged: 'structural' });
        assert.deepEqual(ids(explicit), ids(o), 'schemaChanged defaults to something other than structural');
      });

      it('older + any is still per type: B reworded joins, A as the peer defines it does not', async () => {
        const o = await q({ schemaVersion: 'older', schemaChanged: 'any' });
        ok(o, 'older any');
        assert.deepEqual(ids(o), idsOf(`${A}/entities/A@v1`, `${A}/entities/B@v1`, `${A}/entities/D@P`, `${A}/entities/A@EMPTY`, `${A}/entities/A@nh`));
      });

      it('a version not held is counted unclassified over the whole match, not the page, and echoed with the current version', async () => {
        const o = await q({ schemaVersion: 'older', limit: 1 });
        ok(o, 'older, one row');
        assert.equal(o.rows.length, 1);
        const m = memberOf(o, A);
        assert.ok(m, `no echo for ${A}: ${JSON.stringify(o.echo)}`);
        assert.equal(m.current, vA2.fp, 'the echo does not name the current version');
        assert.equal(m.unclassified, 3, 'unclassified does not count every record of the version not held over the match');
        const plain = await call(admin.key, { space: A, collection: 'entities', limit: 1 });
        assert.equal(plain.echo, undefined, 'the echo is there though schemaVersion was not sent');
      });

      it('a projection without the stamp still classifies and counts, and the stamp stays out of the rows', async () => {
        const o = await q({ schemaVersion: 'older', projection: { name: 1 } });
        ok(o, 'older with a projection');
        assert.equal(o.rows.length, 9);
        assert.ok(o.rows.every(r => !('schemaFingerprint' in r)), 'the stamp the read added is in the answer');
        assert.equal(memberOf(o, A)?.unclassified, 3);
      });

      it('facts unchanged are older in neither mode; edges are typed by their label', async () => {
        for (const schemaChanged of ['structural', 'any']) {
          const f = await call(admin.key, { space: A, collection: 'facts', schemaVersion: 'older', schemaChanged });
          ok(f, `facts ${schemaChanged}`);
          assert.deepEqual(ids(f), [], `${schemaChanged}: a fact of an unchanged type is older`);
        }
        const e = await call(admin.key, { space: A, collection: 'edges', schemaVersion: 'older' });
        ok(e, 'edges');
        assert.deepEqual(ids(e), idsOf(`${A}/edges/knows@v1`), 'older edges are not the knows edges of v1 alone');
      });

      it('a space rule reaches untyped records of its kinds, and a kind that gains its first type makes every record of it older (A1, A2)', async () => {
        const e = await call(admin.key, { space: C, collection: 'entities', schemaVersion: 'older' });
        ok(e, 'C entities');
        assert.deepEqual(ids(e), idsOf(`${C}/entities/T@v1`, `${C}/entities/untyped@v1`));
        const f = await call(admin.key, { space: C, collection: 'facts', schemaVersion: 'older' });
        assert.deepEqual(ids(f), idsOf(`${C}/facts/X@v1`), 'a fact of a type neither version declares is not older once its kind declares one');
        const c = await call(admin.key, { space: C, collection: 'chrono', schemaVersion: 'older' });
        assert.deepEqual(ids(c), [], 'a chrono record is older though nothing governing chrono changed');
      });

      it('a version carried only by records whose type is not a string is older and unclassified, never dropped (lens sweep F3)', async () => {
        // Seen red at b4b51aed: the (stamp, type) group of the non-string label was dropped, so vC1 never reached `older` for edges.
        const e = await call(admin.key, { space: C, collection: 'edges', schemaVersion: 'older' });
        ok(e, 'C edges older');
        assert.deepEqual(ids(e), idsOf(`${C}/edges/odd@v1`), 'the record of a type no reader can name is not older');
        assert.equal(memberOf(e, C)?.unclassified, 1, 'the record of a type no reader can name is not counted unclassified');
      });

      it('a layer whose row lags behind an act is read from the config: its records are classified, never unclassified', async () => {
        assert.ok(!(await heldRows(d.door.mongo, D)).includes(layerFp), 'precondition: the layer row landed although an act stands');
        const o = await call(admin.key, { space: D, collection: 'entities', schemaVersion: 'older' });
        ok(o, 'D older');
        assert.deepEqual(ids(o), [], 'a record stamped with the current layer, defined the same, is older');
        assert.equal(memberOf(o, D)?.unclassified, 0, 'the layer version, held in the config, was counted not held');
        const byFp = await call(admin.key, { space: D, collection: 'entities', schemaVersion: layerFp });
        assert.deepEqual(ids(byFp), idsOf(`${D}/entities/L1@layer`));
      });

      it('through a personal view each member answers its own current version', async () => {
        const v = await call(owner.key, { space: '@svfview', collection: 'entities', schemaVersion: 'current', limit: 100 });
        ok(v, 'the view');
        assert.deepEqual(ids(v), idsOf(`${A}/entities/A@v2`, `${B}/entities/A@vB2`), 'current resolved once for the view, not per member');
        assert.equal(memberOf(v, A)?.current, vA2.fp);
        assert.equal(memberOf(v, B)?.current, vB2.fp);
        const o = await call(owner.key, { space: '@svfview', collection: 'entities', schemaVersion: 'older', limit: 100 });
        assert.ok(ids(o).includes(idsOf(`${B}/entities/A@vB1`)[0]), 'B\'s older record is missing from the view');
      });

      it('refuses, naming the argument: files and links, a malformed fingerprint, schemaChanged without older', async () => {
        for (const [args, name] of [
          [{ collection: 'files', schemaVersion: 'current' }, 'schemaVersion'],
          [{ collection: 'links', schemaVersion: 'current' }, 'schemaVersion'],
          [{ schemaVersion: 'abc' }, 'schemaVersion'],
          [{ schemaVersion: 'A'.repeat(64) }, 'schemaVersion'],
          [{ schemaVersion: 'current', schemaChanged: 'any' }, 'schemaChanged'],
          [{ schemaChanged: 'any' }, 'schemaChanged'],
        ]) {
          const r = await q(args);
          assert.ok(r.refused, `${JSON.stringify(args)} was answered: ${r.text.slice(0, 200)}`);
          if (door.startsWith('REST')) assert.equal(r.status, 400, JSON.stringify(args));
          assert.match(r.text, new RegExp(name), `${JSON.stringify(args)}: the refusal does not name ${name}`);
          assert.doesNotMatch(r.text, /additional propert|unexpected property/i,`${JSON.stringify(args)}: refused as an unknown argument, not for what it says`);
        }
      });
    });
  }

  it('a second identical older call and a fingerprint ask read no version text (lens sweep F5)', async () => {
    // Seen red at b4b51aed: `older` read every carried version's text on each call, and hashed both texts for the memo key; the
    // fingerprint ask read a text only to learn whether it is held.
    const client = d.door.mongo.getMongo();
    const readsText = (c) => c.name !== 'find' || !c.command.projection || c.command.projection.text === 1;
    const watch = (args) => readsDuring(client, `${A}_schema_snapshots`, () => DOORS['MCP filter'](admin.key, { space: A, collection: 'entities', limit: 100, ...args }));
    await watch({ schemaVersion: 'older' });
    const again = await watch({ schemaVersion: 'older' });
    ok(again.result, 'older again');
    assert.ok(again.sent.length > 0, 'older read no snapshot row: the probe watched the wrong collection');
    assert.deepEqual(again.sent.filter(readsText).map(c => c.command.projection ?? c.name), [], 'the second older call read a version text');
    const byFp = await watch({ schemaVersion: P.fp });
    ok(byFp.result, 'a fingerprint');
    assert.deepEqual(byFp.sent.filter(readsText).map(c => c.command.projection ?? c.name), [], 'the fingerprint ask read a version text');
    assert.deepEqual(ids(byFp.result), idsOf(`${A}/entities/A@P`, `${A}/entities/D@P`));
    assert.equal(memberOf(byFp.result, A)?.unclassified, 0, 'a held fingerprint is counted unclassified');
  });

  it('the two doors answer the same rows and the same echo', async () => {
    const args = { space: A, collection: 'entities', schemaVersion: 'older', schemaChanged: 'any', limit: 100 };
    const [rest, mcp] = await Promise.all(Object.values(DOORS).map(call => call(admin.key, args)));
    ok(rest, 'REST'); ok(mcp, 'MCP');
    assert.deepEqual(ids(rest), ids(mcp));
    assert.deepEqual(rest.echo, mcp.echo);
  });

  it('every key of the echo is named where the filter is documented (04d, Structured query)', async () => {
    const o = await DOORS['MCP filter'](admin.key, { space: A, collection: 'entities', schemaVersion: 'older' });
    ok(o, 'older');
    const keys = ['schemaVersion', ...Object.keys(o.echo ?? {}), ...Object.keys(o.echo?.members?.[0] ?? {}), 'schemaChanged'];
    assert.ok(keys.length >= 5, `the echo has too few keys to compare: ${JSON.stringify(o.echo)}`);
    assert.deepEqual(await undocumentedKeys('integration-guide/04d-brain-ops-api.md', 'Structured query', keys), []);
  });
});
