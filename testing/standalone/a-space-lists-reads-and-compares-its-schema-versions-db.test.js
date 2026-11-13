/**
 * A space lists, reads and compares the schema versions its records carry, alike on both doors (Q-742 without names; bundle-267 design
 * r3 §4, §7 "-db, versions"; r2 "Q-742 without names"; vet S1/S3, I2, R2, T3, docs 9/10).
 *
 * ## The contract (written before the code)
 *
 * - `GET /api/spaces/:id/schema-versions` answers `{ versions: [{ fp, current, held, origin?, since?, counts: { entities, facts,
 *   edges, chrono } }], nextSkip? }`: current first (read from the config, row or no row), then the held rows by `at` descending, then
 *   the fingerprints records carry with no row (`held: false`). It takes `skip` and the shared budget (`maxChars`, `maxBytes`,
 *   `maxTokens`); a cut page answers `nextSkip`.
 * - `GET .../schema-versions?fp=<fp>` answers `{ fp, current, held, schema: { typeSchemas, rules } }`.
 * - `GET .../schema-versions?fp=<fp>&against=current|<fp>` answers the per-type diff (from = fp, to = against).
 * - MCP `space_schema_versions { space, fp?, against?, skip?, maxChars... }` takes the same parameters: no fp the list, fp the
 *   version, fp + against the diff. One route and one tool, one shape (one-capability-is-one-shape).
 * - Refusals: `404 unknown_fingerprint` (not held, or not one this caller may have), `400 bad_fingerprint`, and on both doors
 *   `400 against_needs_fp`.
 * - A peer-bound token sees only the versions `servableTo` lets the sync door serve it; a local token sees all.
 * - A personal view on these routes is an unknown space, answered as `GET /meta` answers it.
 * - `versionText(spaceId, fp)` (`spaces/schema-version-text.js`): a row that is gone is not held (`null`); a store failure throws.
 *
 * ## Seen red at b299cde3
 *
 * The routes answer 404 with no code (no such route), the tool does not exist, `schema-version-text.js` does not exist (new code).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openViewDoors } from './_view-doors.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { snapshotNamed, snapshotRow, snapshotsOf, linksOf } from './_schema-snapshot-peer.mjs';
import { recordOf, saveVersion, heldRows, undocumentedKeys } from './_schema-version-fixtures.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SUITE = 'svversions';
const S = 'svver';
const LAG = 'svverlag';
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
      suite: SUITE, spaces: [S, LAG], type: 'club', direction: 'both', meta: { [S]: META, [LAG]: META },
    }) });
    local = await d.mint('svv-local', { [S]: d.row({ schema: 'read', knowledge: 'read' }), [LAG]: d.row({ schema: 'read' }) });
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

    it('the tool answers the same list', async () => {
      const mcp = await d.mcp(local.key, 'space_schema_versions', { space: S });
      assert.ok(!mcp.isError, mcp.text.slice(0, 300));
      assert.deepEqual(versionsOf(mcp), versionsOf(await listRest(local.key)));
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
      const next = await listRest(local.key, S, `?skip=${cut.body.nextSkip}`);
      assert.equal(versionsOf(next)[0]?.fp, whole[cut.body.nextSkip]?.fp);
      const mcp = await d.mcp(local.key, 'space_schema_versions', { space: S, maxBytes: 300 });
      assert.equal(typeof mcp.structured?.nextSkip, 'number', 'the tool ignores the budget');
    });

    it('every key of an entry is named in the integration guide (06a, Schema versions)', async () => {
      const list = versionsOf(await listRest(local.key));
      const keys = ['versions', 'nextSkip', ...new Set(list.flatMap(e => Object.keys(e))), ...Object.keys(list[0]?.counts ?? {})];
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
    it('a peer-bound token sees only what the sync door would serve it; a local token sees all', async () => {
      const mine = versionsOf(await listRest(local.key)).map(e => e.fp);
      assert.ok(mine.includes(X.fp), 'a local token does not see a held version');
      const r = await listRest(peer.key);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const theirs = versionsOf(r).map(e => e.fp);
      assert.ok(theirs.includes(v1.fp), 'the peer does not see a version it shares');
      assert.ok(!theirs.includes(X.fp), 'the peer sees a version built from a network it is not in');
      for (const path of [`?fp=${X.fp}`, `?fp=${X.fp}&against=current`]) {
        const read = await listRest(peer.key, S, path);
        assert.equal(read.status, 404, `${path}: ${read.text.slice(0, 200)}`);
        assert.equal(read.body?.code, 'unknown_fingerprint', `${path}: a version the peer may not have is not answered as one it does not know`);
      }
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
});
