/**
 * A space lists, reads and compares the schema versions its records carry, alike on both doors (Q-742 without names; bundle-267 design
 * r3 §4, §7 "-db, versions"; r2 "Q-742 without names"; vet S1/S3, I2, R2, T3, docs 9/10).
 *
 * ## The contract (written before the code)
 *
 * - `GET /api/spaces/:id/schema-versions` answers `{ versions: [{ fp, current, held, origin?, since?, counts: { entities, facts,
 *   edges, chrono } }], truncated, total, count, limit, skip, nextSkip?, ...the budget figures }` (`pageList`'s fields): current first (read from the config, row or no row), then the held rows by `at` descending, then
 *   the fingerprints records carry with no row (`held: false`). It takes `skip` and the shared budget (`maxChars`, `maxBytes`,
 *   `maxTokens`); a cut page answers `nextSkip`.
 * - `GET .../schema-versions?fp=<fp>` answers `{ fp, current, held, schema: { typeSchemas, rules } }`.
 * - `GET .../schema-versions?fp=<fp>&against=current|<fp>` answers the per-type diff (from = fp, to = against).
 * - MCP `space_schema_versions { space, fp?, against?, skip?, maxChars... }` takes the same parameters: no fp the list, fp the
 *   version, fp + against the diff. One route and one tool, one shape (one-capability-is-one-shape).
 * - Refusals: `404 unknown_fingerprint` (not held, or not one this caller may have), `400 bad_fingerprint`, and on both doors
 *   `400 against_needs_fp`.
 * - A local token sees all the versions the space holds. A peer-bound token no longer reaches these doors to be narrowed to what `servableTo` lets the
 *   sync door serve it: Q-244 (bundle-47) confines it to the sync doors, so the list, the read and the diff answer it `403 peer_door` on REST and on `/mcp`
 *   (an HTTP `403` with a JSON body, not a tool result), and the held version built from a network the peer is not in is never read for it.
 * - A personal view on these routes is an unknown space, answered as `GET /meta` answers it.
 * - `versionText(spaceId, fp)` (`spaces/schema-version-text.js`): a row that is gone is not held (`null`); a store failure throws.
 *
 * ## Seen red at b299cde3
 *
 * The routes answer 404 with no code (no such route), the tool does not exist, `schema-version-text.js` does not exist (new code).
 *
 * ## Seen red at 31c71f2d (a current version that is a network layer)
 *
 * `configuredVersions` answered the current layer `{ origin: 'own', links }` while `owedOf` (what the sync door keeps) answers it
 * `{ origin: 'layer', networkId, links: null }`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { snapshotNamed, snapshotRow, snapshotsOf, linksOf } from './_schema-snapshot-peer.mjs';
import { recordOf, saveVersion, heldRows, undocumentedKeys, readsDuring } from './_schema-version-fixtures.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SUITE = 'svversions';
const S = 'svver';
const LAG = 'svverlag';
/** A space whose own definitions add nothing to its one network layer: its current fingerprint is the layer's. */
const LAYERED = 'svverlayered';
const META = { suppressEmbeddings: true };
const NOT_HELD = 'e'.repeat(64);
const OUTSIDE_NET = 'a-network-the-peer-is-not-in';

let d, local, peer, v1, v2, X, lagV2;
const typed = (prop) => ({ ...META, typeSchemas: { entity: { A: { propertySchemas: { [prop]: { type: 'string' } } } } } });

const listRest = (key, id = S, query = '') => d.rest(key, 'GET', `/api/spaces/${encodeURIComponent(id)}/schema-versions${query}`);
const versionsOf = (r) => r.body?.versions ?? r.structured?.versions ?? [];

describe('a space lists, reads and compares its schema versions (real MongoDB)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: SUITE, openDoor: () => openPullDoor({
      suite: SUITE, spaces: [S, LAG, LAYERED], type: 'club', direction: 'both', monitorCommands: true, meta: { [S]: META, [LAG]: META, [LAYERED]: META },
    }) });
    local = await d.mint('svv-local', {
      [S]: d.row({ schema: 'read', knowledge: 'read' }), [LAG]: d.row({ schema: 'read' }), [LAYERED]: d.row({ schema: 'read' }),
    });
    peer = await d.mint('svv-peer', { [S]: d.row({ schema: 'read' }) }, { peerInstanceId: PEER });
    v1 = await saveVersion(S, typed('p'));
    v2 = await saveVersion(S, typed('q'));
    // A held row built from a network the peer is not in: the sync door refuses it to that peer (servableTo, not_shared).
    X = await snapshotNamed('built-elsewhere');
    await snapshotsOf(d.door.mongo, S).insertOne(snapshotRow({ fp: X.fp, text: X.text, origin: 'fetched', from: 'another-member',
      links: linksOf(X.fp, [{ networkId: OUTSIDE_NET, fp: 'c'.repeat(64) }]), at: '2026-01-01T00:00:00.000Z' }));
    let i = 0;
    const put = async (part, n, opts) => d.door.coll(S, part).insertMany(Array.from({ length: n }, () => recordOf(part, S, ++i, opts)));
    await put('entities', 3, { type: 'A', fp: v1.fp });
    await put('entities', 2, { type: 'A', fp: v2.fp });
    await put('entities', 2, { type: 'A', fp: NOT_HELD });
    await put('facts', 1, { type: 'F', fp: v2.fp });
    await put('edges', 1, { type: 'knows', fp: v1.fp });
    await put('entities', 4, { type: 'A' });

    await saveVersion(LAG, typed('p'));
    await seedActEntry(d.loader, { kind: 'wipe', localId: LAG, state: 'registered' });
    lagV2 = await saveVersion(LAG, typed('r'), { landRow: false });

    const made = await d.rest(local.key, 'POST', '/api/views', { name: 'svvview', members: [S] });
    assert.ok(made.status < 300, made.text);
  });
  after(async () => { if (d) clearActEntries(d.loader); await d?.close(); });

  describe('the list', () => {
    it('current first, then held rows newest first, then carried versions not held, each with its counts per collection', async () => {
      const r = await listRest(local.key);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const list = versionsOf(r);
      assert.equal(list[0]?.fp, v2.fp, 'the first entry is not the current version');
      assert.equal(list[0].current, true);
      assert.equal(list[0].held, true);
      assert.deepEqual(list[0].counts, { entities: 2, facts: 1, edges: 0, chrono: 0 });
      const at = (fp) => list.findIndex(e => e.fp === fp);
      const one = list[at(v1.fp)];
      assert.ok(one, 'v1 is not listed');
      assert.deepEqual({ current: one.current, held: one.held, origin: one.origin }, { current: false, held: true, origin: 'own' });
      assert.deepEqual(one.counts, { entities: 3, facts: 0, edges: 1, chrono: 0 });
      assert.ok(at(v1.fp) < at(X.fp), 'the held rows are not newest first');
      const gone = list[at(NOT_HELD)];
      assert.ok(gone, 'a version records carry with no row is not listed');
      assert.equal(gone.held, false);
      assert.equal(gone.counts.entities, 2);
      assert.ok(at(NOT_HELD) > at(X.fp), 'a version not held is listed before a held one');
    });

    it('the list reads no version text: its rows are read without `text`, while a read still reads it (lens sweep F4)', async () => {
      // Seen red at b4b51aed: the list read every kept row through `heldVersions`, whose projection names `text`.
      const client = d.door.mongo.getMongo();
      const readsText = (c) => c.name !== 'find' || !c.command.projection || c.command.projection.text === 1;
      const list = await readsDuring(client, `${S}_schema_snapshots`, () => listRest(local.key));
      assert.equal(list.result.status, 200, list.result.text.slice(0, 300));
      assert.ok(list.sent.length > 0, 'the list read no snapshot row at all: the probe watched the wrong collection');
      assert.deepEqual(list.sent.filter(readsText).map(c => c.command.projection ?? c.name), [], 'the list read a version text');
      const read = await readsDuring(client, `${S}_schema_snapshots`, () => listRest(local.key, S, `?fp=${v1.fp}`));
      assert.equal(read.result.status, 200, read.result.text.slice(0, 300));
      assert.ok(read.sent.some(readsText), 'a version read no longer reads its text: the probe cannot tell the two apart');
    });

    it('the tool answers the same list', async () => {
      const mcp = await d.mcp(local.key, 'space_schema_versions', { space: S });
      assert.ok(!mcp.isError, mcp.text.slice(0, 300));
      assert.deepEqual(versionsOf(mcp), versionsOf(await listRest(local.key)));
    });

    it('the tool description names every page key the list answers, beyond the shared budget disclosure', async () => {
      // bundle-267: the list moved onto pageList and the description kept naming `{ versions, nextSkip? }` alone.
      const { space_schema_versionsTool } = await import('../../server/dist/mcp/tools/schema-versions.js');
      const { budgetFields } = await import('../../server/dist/brain/result-budget.js');
      const disclosed = new Set(Object.keys(budgetFields({ returned: [], truncated: false, charsReturned: 0, bytesReturned: 0 }, 0, { chars: 1, bytes: null })));
      const whole = await listRest(local.key);
      const cut = await listRest(local.key, S, '?maxBytes=300');
      const keys = [...new Set([...Object.keys(whole.body), ...Object.keys(cut.body)])].filter(k => !disclosed.has(k) && !k.startsWith('budget'));  // budgetBoundBy joins the disclosure on a cut page
      assert.ok(keys.includes('versions') && keys.includes('nextSkip'), `the page keys were not read: ${keys}`);
      const unnamed = keys.filter(k => !new RegExp(`\\b${k}\\b`).test(space_schema_versionsTool.description));
      assert.deepEqual(unnamed, [], 'the tool description does not name keys the list answers');
    });

    it('the current version comes from the config while its row lags behind an act', async () => {
      assert.ok(!(await heldRows(d.door.mongo, LAG)).includes(lagV2.fp), 'precondition: the current row landed although an act stands');
      const r = await listRest(local.key, LAG);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(versionsOf(r)[0]?.fp, lagV2.fp);
      assert.equal(versionsOf(r)[0]?.held, true, 'the current version, in the config, is answered not held');
      const read = await listRest(local.key, LAG, `?fp=${lagV2.fp}`);
      assert.equal(read.status, 200, read.text.slice(0, 300));
    });

    it('a page cut by the budget answers nextSkip, and the next page continues it', async () => {
      const whole = versionsOf(await listRest(local.key));
      // maxBytes, not maxChars: a character budget is raised to the shared floor (MIN_MAX_BYTES), which this short list fits under;
      // a byte ceiling has no floor, so 300 bytes cuts it on both doors.
      const cut = await listRest(local.key, S, '?maxBytes=300');
      assert.equal(cut.status, 200, cut.text.slice(0, 300));
      assert.ok(versionsOf(cut).length < whole.length, 'a 300-byte page holds every version');
      assert.equal(typeof cut.body?.nextSkip, 'number', 'a cut page answers no nextSkip');
      assert.deepEqual({ truncated: cut.body.truncated, total: cut.body.total, skip: cut.body.skip }, { truncated: true, total: whole.length, skip: 0 },
        'a cut page does not say it was cut, of how many, from where (pageList\'s fields)');
      const next = await listRest(local.key, S, `?skip=${cut.body.nextSkip}`);
      assert.equal(versionsOf(next)[0]?.fp, whole[cut.body.nextSkip]?.fp);
      const mcp = await d.mcp(local.key, 'space_schema_versions', { space: S, maxBytes: 300 });
      assert.equal(typeof mcp.structured?.nextSkip, 'number', 'the tool ignores the budget');
    });

    it('every key of an entry is named in the integration guide (06a, Schema versions)', async () => {
      const whole = await listRest(local.key);
      const list = versionsOf(whole);
      // The page's own keys as the list answers them (`pageList`'s), plus `nextSkip`, which only a cut page carries.
      const keys = [...new Set([...Object.keys(whole.body), 'nextSkip', ...list.flatMap(e => Object.keys(e)), ...Object.keys(list[0]?.counts ?? {})])];
      assert.ok(keys.length >= 8, `too few keys to compare: ${keys}`);
      assert.deepEqual(await undocumentedKeys('integration-guide/06a-schema-api.md', 'Schema versions', keys), []);
    });
  });

  describe('a version and a comparison', () => {
    it('reads one version\'s schema, on both doors', async () => {
      const r = await listRest(local.key, S, `?fp=${v1.fp}`);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.body.fp, v1.fp);
      assert.equal(r.body.current, false);
      assert.equal(r.body.held, true);
      assert.deepEqual(r.body.schema?.typeSchemas?.entity?.A?.propertySchemas, { p: { type: 'string' } });
      const mcp = await d.mcp(local.key, 'space_schema_versions', { space: S, fp: v1.fp });
      assert.ok(!mcp.isError, mcp.text.slice(0, 300));
      assert.deepEqual(mcp.structured?.schema, r.body.schema);
      assert.deepEqual(await undocumentedKeys('integration-guide/06a-schema-api.md', 'Schema versions', Object.keys(r.body)), []);
    });

    it('compares a version against current, and against a named version', async () => {
      const r = await listRest(local.key, S, `?fp=${v1.fp}&against=current`);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const rowA = r.body.types?.find(t => t.kind === 'entity' && t.type === 'A');
      assert.ok(rowA?.changes?.some(c => c.class === 'structural'), `the rename p -> q is not a structural change of A: ${r.text.slice(0, 400)}`);
      const same = await listRest(local.key, S, `?fp=${v1.fp}&against=${v1.fp}`);
      assert.equal(same.status, 200);
      assert.deepEqual(same.body.types, [], 'a version compared with itself differs');
      const mcp = await d.mcp(local.key, 'space_schema_versions', { space: S, fp: v1.fp, against: 'current' });
      assert.ok(!mcp.isError, mcp.text.slice(0, 300));
      assert.deepEqual(mcp.structured?.types, r.body.types);
    });

    it('refuses with the sync door\'s spellings: 404 unknown_fingerprint, 400 bad_fingerprint, 400 against_needs_fp', async () => {
      const gone = await listRest(local.key, S, `?fp=${'d'.repeat(64)}`);
      assert.equal(gone.status, 404);
      assert.equal(gone.body?.code, 'unknown_fingerprint');
      const bad = await listRest(local.key, S, '?fp=abc');
      assert.equal(bad.status, 400);
      assert.equal(bad.body?.code, 'bad_fingerprint');
      const badDiff = await listRest(local.key, S, `?fp=${v1.fp}&against=abc`);
      assert.equal(badDiff.status, 400);
      assert.equal(badDiff.body?.code, 'bad_fingerprint');
      const noFp = await listRest(local.key, S, '?against=current');
      assert.equal(noFp.status, 400);
      assert.equal(noFp.body?.code, 'against_needs_fp');
      const mcp = await d.mcp(local.key, 'space_schema_versions', { space: S, against: 'current' });
      assert.ok(mcp.isError, mcp.text);
      assert.match(mcp.text, /against_needs_fp/);
      const mcpGone = await d.mcp(local.key, 'space_schema_versions', { space: S, fp: 'd'.repeat(64) });
      assert.ok(mcpGone.isError);
      assert.match(mcpGone.text, /unknown_fingerprint/);
    });
  });

  describe('who sees which versions', () => {
    it('a peer-bound token is refused 403 peer_door on the list, the read and the diff, on both doors; a local token sees all', async () => {
      const mine = versionsOf(await listRest(local.key)).map(e => e.fp);
      assert.ok(mine.includes(X.fp), 'a local token does not see a held version');
      for (const path of ['', `?fp=${X.fp}`, `?fp=${X.fp}&against=current`]) {
        const r = await listRest(peer.key, S, path);
        assert.equal(r.status, 403, `${path || 'list'}: ${r.text.slice(0, 200)}`);
        assert.equal(r.body?.code, 'peer_door', `${path || 'list'}: the peer was not refused as a peer`);
        assert.deepEqual(versionsOf(r), [], `${path || 'list'}: a version was read for the peer`);
      }
      const viaMcp = await d.rpc(peer.key, 'tools/call', { name: 'space_schema_versions', arguments: { space: S, fp: X.fp } });
      assert.equal(viaMcp.status, 403, 'MCP: a peer-bound token was answered');
      assert.equal(viaMcp.messages[0]?.code, 'peer_door', 'MCP: the peer was not refused as a peer');
    });

    it('a personal view is an unknown space here, answered as GET meta answers it', async () => {
      const meta = await d.rest(local.key, 'GET', '/api/spaces/%40svvview/meta');
      assert.ok(meta.status >= 400, `precondition: GET meta took a view (${meta.status})`);
      for (const path of ['schema-versions', `schema-versions?fp=${v1.fp}`, `schema-versions?fp=${v1.fp}&against=current`]) {
        const r = await d.rest(local.key, 'GET', `/api/spaces/%40svvview/${path}`);
        assert.equal(r.status, meta.status, `${path}: ${r.text.slice(0, 200)}`);
        assert.deepEqual(r.body, meta.body, `${path} answers a view in other words than GET meta`);
      }
      const mcp = await d.mcp(local.key, 'space_schema_versions', { space: '@svvview' });
      const mcpMeta = await d.mcp(local.key, 'space_meta', { space: '@svvview' });
      assert.ok(mcp.isError && mcpMeta.isError);
      assert.equal(mcp.text, mcpMeta.text, 'the tool answers a view in other words than space_meta');
    });
  });

  describe('a current version that is a network layer', () => {
    it('is answered as that layer, as the sync door keeps it (owedOf), never as an own version', async () => {
      const { readPeerMeta } = await import('../../schema/dist/internal.js');
      const layer = readPeerMeta({ typeSchemas: { entity: { L1: { propertySchemas: { l: { type: 'string' } } } } } });
      assert.ok(layer.ok, layer.message);
      (await import('../../server/dist/spaces/effective-meta.js')).storeNetworkLayer(d.door.NET, LAYERED, layer.meta);
      const variation = (await import('../../server/dist/spaces/schema-stamp.js')).variationOf(LAYERED);
      const fp = variation.stamp.fp;
      assert.equal(variation.layers[0]?.stamp.fp, fp, 'precondition: the current fingerprint is not the layer\'s');
      const { owedOf } = await import('../../server/dist/spaces/schema-snapshot-store.js');
      const owed = owedOf(LAYERED).find(([s]) => s.fp === fp)?.[1];
      assert.deepEqual(owed, { origin: 'layer', networkId: d.door.NET, links: null }, 'precondition: the sync door does not keep it as the layer');
      const { configuredVersions } = await import('../../server/dist/spaces/schema-version-text.js');
      assert.deepEqual(configuredVersions(LAYERED).get(fp)?.kept, owed, 'the versions doors read the current layer as another row than the sync door keeps');
      const r = await listRest(local.key, LAYERED);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const entry = versionsOf(r).find(e => e.fp === fp);
      assert.deepEqual({ current: entry?.current, origin: entry?.origin }, { current: true, origin: 'layer' });
    });
  });

  describe('versionText', () => {
    it('a row that is gone is not held; a store that fails throws', async () => {
      const mod = await import('../../server/dist/spaces/schema-version-text.js').catch(err => ({ __missing: err }));
      assert.ok(!mod.__missing, `spaces/schema-version-text.js does not load (${mod.__missing?.code})`);
      const gone = await snapshotNamed('swept-away');
      assert.equal(await mod.versionText(S, gone.fp), null, 'a fingerprint with no row is answered held');
      assert.equal(await mod.versionText(S, v1.fp), v1.text, 'a held row is not read');
      // The store fails: every read of the snapshot collection rejects. That is never "not held".
      const proto = Object.getPrototypeOf(d.door.mongo.col(`${S}_schema_snapshots`));
      const saved = { find: proto.find, findOne: proto.findOne, aggregate: proto.aggregate };
      const fail = (name) => function failing(...args) {
        if (String(this.collectionName).endsWith('_schema_snapshots')) {
          if (name === 'findOne') return Promise.reject(new Error('the store is not answering'));
          const err = new Error('the store is not answering');
          return { toArray: () => Promise.reject(err), next: () => Promise.reject(err), project() { return this; }, limit() { return this; }, sort() { return this; }, maxTimeMS() { return this; }, [Symbol.asyncIterator]: async function* () { throw err; } };
        }
        return saved[name].apply(this, args);
      };
      Object.assign(proto, { find: fail('find'), findOne: fail('findOne'), aggregate: fail('aggregate') });
      try {
        await assert.rejects(mod.versionText(S, X.fp), 'a store failure was answered as a version not held');
      } finally { Object.assign(proto, saved); }
    });
  });

  /**
   * The type forms (Q-744, bundle-268 design r4 §5 and §10 T6): the dispatch table on both doors, the echo, every new refusal, the 503s,
   * and the shared answer fixture in check mode. Seen red at 327b105e: REST ignores `kind`, `type` and `fps` and answers the version list;
   * MCP refuses them as unknown arguments.
   */
  describe('the type forms', () => {
    const FIXTURE = new URL('../../client/src/app/testing/fixtures/schema-type-answers.json', import.meta.url);
    const both = async (key, space, params) => {
      const { typeDoors } = await import('./_type-history.mjs');
      const doors = typeDoors(d);
      return [await doors.REST(key, space, params), await doors.MCP(key, space, params)];
    };

    it('the dispatch table: kind, kind+type, fps+kind+type and fp+against+kind+type each answer their form, echoing kind and type', async () => {
      for (const r of await both(local.key, S, { kind: 'entity' })) {
        assert.ok(!r.refused && Array.isArray(r.body.types), `${r.door} kind: ${r.text.slice(0, 300)}`);
        assert.equal(r.body.kind, 'entity');
        assert.ok(r.body.types.some(t => t.type === 'A' && t.declared === 'own'), `${r.door}: A is not an own row`);
      }
      for (const r of await both(local.key, S, { kind: 'entity', type: 'A' })) {
        assert.ok(!r.refused && Array.isArray(r.body.definitions), `${r.door} kind+type: ${r.text.slice(0, 300)}`);
        assert.deepEqual({ kind: r.body.kind, type: r.body.type }, { kind: 'entity', type: 'A' });
      }
      for (const r of await both(local.key, S, { fps: [v1.fp, v2.fp, NOT_HELD], kind: 'entity', type: 'A' })) {
        assert.ok(!r.refused && Array.isArray(r.body.standings), `${r.door} fps: ${r.text.slice(0, 300)}`);
        assert.deepEqual(new Map(r.body.standings.map(s => [s.fp, s.standing])), new Map([[v1.fp, 'older'], [v2.fp, 'current'], [NOT_HELD, 'notHeld']]));
      }
      for (const r of await both(local.key, S, { fp: v1.fp, against: 'current', kind: 'entity', type: 'A' })) {
        assert.ok(!r.refused, `${r.door} narrowed: ${r.text.slice(0, 300)}`);
        assert.deepEqual({ kind: r.body.kind, type: r.body.type }, { kind: 'entity', type: 'A' }, `${r.door}: the narrowed comparison does not echo`);
        assert.ok((r.body.types ?? []).length > 0 && r.body.types.every(t => t.kind === 'entity' && t.type === 'A'), `${r.door}: the comparison is not narrowed to A`);
      }
    });

    it('every new refusal, on both doors, named by its code', async () => {
      const fps = (n) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, '0'));
      for (const [params, code] of [
        [{ kind: 'nonsense' }, 'bad_kind'],
        [{ type: 'A' }, 'type_needs_kind'],
        [{ fps: [v1.fp], kind: 'entity' }, 'kind_needs_type'],
        [{ fp: v1.fp, kind: 'entity', type: 'A' }, 'kind_needs_type'],
        [{ fps: [v1.fp] }, 'fps_needs_type'],
        [{ fps: fps(101), kind: 'entity', type: 'A' }, 'too_many_fps'],
        [{ fps: [v1.fp, 'abc'], kind: 'entity', type: 'A' }, 'bad_fingerprint'],
        // Q-744 fix round 2, S7: the two refusals no code of the list names are refused by their message alone, on both doors.
        [{ kind: 'entity', type: 'T'.repeat(201) }, 'type name of 1 to'],
        [{ fps: [v1.fp], fp: v1.fp, against: 'current', kind: 'entity', type: 'A' }, 'two forms'],
      ]) {
        for (const r of await both(local.key, S, params)) {
          assert.ok(r.refused, `${r.door} ${JSON.stringify(params).slice(0, 120)} was answered`);
          if (r.door === 'REST') assert.equal(r.status, 400, `${JSON.stringify(params).slice(0, 120)}: ${r.text.slice(0, 200)}`);
          assert.match(r.text, new RegExp(code), `${r.door} ${JSON.stringify(params).slice(0, 120)}: not refused as ${code}: ${r.text.slice(0, 200)}`);
        }
      }
      for (const r of await both(local.key, S, { fps: fps(100), kind: 'entity', type: 'A' })) assert.ok(!r.refused, `${r.door}: 100 fps, the bound, was refused: ${r.text.slice(0, 200)}`);
    });

    it('a pass past its deadline answers 503 schema_versions_busy with no store text, on both doors and on the filter', async () => {
      const proto = Object.getPrototypeOf(d.door.mongo.col(`${S}_entities`));
      const saved = { find: proto.find, aggregate: proto.aggregate, distinct: proto.distinct, findOne: proto.findOne };
      const expired = () => Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired' });
      const slow = (name) => function slowRead(...args) {
        if (String(this.collectionName) !== `${S}_entities`) return saved[name].apply(this, args);
        if (name === 'distinct' || name === 'findOne') return Promise.reject(expired());
        const err = expired();
        return { toArray: () => Promise.reject(err), next: () => Promise.reject(err), project() { return this; }, limit() { return this; }, sort() { return this; }, hint() { return this; }, maxTimeMS() { return this; }, [Symbol.asyncIterator]: async function* () { throw err; } };
      };
      Object.assign(proto, { find: slow('find'), aggregate: slow('aggregate'), distinct: slow('distinct'), findOne: slow('findOne') });
      try {
        for (const r of await both(local.key, S, { kind: 'entity' })) {
          assert.ok(r.refused, `${r.door}: a pass past its deadline was answered`);
          if (r.door === 'REST') assert.equal(r.status, 503, r.text.slice(0, 200));
          assert.match(r.text, /schema_versions_busy/, `${r.door}: ${r.text.slice(0, 200)}`);
          assert.doesNotMatch(r.text, /MaxTimeMS|exceeded time limit/, `${r.door}: the store's own words reached the caller`);
        }
        const f = await d.rest(local.key, 'POST', '/api/filter', { space: S, collection: 'entities', schemaVersion: 'older' });
        assert.equal(f.status, 503, `the filter answered ${f.status}: ${f.text.slice(0, 200)}`);
        assert.match(f.text, /schema_versions_busy/);
        assert.doesNotMatch(f.text, /MaxTimeMS|exceeded time limit/);
      } finally { Object.assign(proto, saved); }
    });

    it('the answers have the shapes of the shared fixture (check mode): every key and every enumerated value is one the fixture holds', async () => {
      const { readFileSync } = await import('node:fs');
      const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
      const keysOf = (rows) => new Set(rows.flatMap(r => Object.keys(r)));
      const top = (ex) => new Set([...Object.keys(ex.answer), 'nextSkip', 'cut', 'recordFacts']);
      const [kind] = await both(local.key, S, { kind: 'entity' });
      const [hist] = await both(local.key, S, { kind: 'entity', type: 'A' });
      const [st] = await both(local.key, S, { fps: [v1.fp, v2.fp, NOT_HELD], kind: 'entity', type: 'A' });
      const checks = [
        ['kind', kind, fx.kind, 'types'], ['history', hist, fx.history, 'definitions'], ['fps', st, fx.fps, 'standings'],
      ];
      for (const [name, live, ex, list] of checks) {
        assert.ok(!live.refused && Array.isArray(live.body[list]), `${name}: ${live.text.slice(0, 200)}`);
        const extra = Object.keys(live.body).filter(k => !top(ex).has(k) && !k.startsWith('budget') && !['charsReturned', 'bytesReturned', 'tokensReturned'].includes(k));
        assert.deepEqual(extra, [], `${name}: the answer has keys the fixture does not: the fixture and the client spec are out of date`);
        const rowExtra = [...keysOf(live.body[list])].filter(k => !keysOf(ex.answer[list]).has(k));
        assert.deepEqual(rowExtra, [], `${name}: a row has keys the fixture does not`);
      }
      const declared = new Set(fx.kind.answer.types.map(t => t.declared));
      assert.ok(kind.body.types.every(t => declared.has(t.declared)), 'a declared value the fixture does not hold');
      const standing = new Set(fx.fps.answer.standings.map(s => s.standing));
      assert.ok(st.body.standings.every(s => standing.has(s.standing)), 'a standing the fixture does not hold');
      assert.deepEqual([...fx.refusals.codes].sort(), ['bad_fingerprint', 'bad_kind', 'fps_needs_type', 'kind_needs_type', 'schema_index_building', 'schema_versions_busy', 'too_many_fps', 'type_needs_kind', 'unknown_fingerprint']);
    });

    it('a collection with no stamp index answers the kind read 503 schema_index_building (last: it drops S\'s index)', async () => {
      await d.door.coll(S, 'entities').dropIndexes();
      for (const r of await both(local.key, S, { kind: 'entity' })) {
        assert.ok(r.refused, `${r.door}: a kind read without the stamp index was answered`);
        if (r.door === 'REST') assert.equal(r.status, 503, r.text.slice(0, 200));
        assert.match(r.text, /schema_index_building/, `${r.door}: ${r.text.slice(0, 200)}`);
      }
    });
  });
});
