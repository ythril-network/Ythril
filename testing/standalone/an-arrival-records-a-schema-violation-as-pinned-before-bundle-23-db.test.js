/**
 * How a record that ARRIVES — by sync push, by sync pull, by the admin import — is reported when it breaks this instance's schema:
 * a CHARACTERIZATION of the answers BEFORE bundle-23 (`Q-93`), green on base 85c4c564 and expected to be EDITED by bundle-23 where
 * it changes them.
 *
 * ## Why this file exists before the change
 *
 * An arrival RECORDS a violation and never refuses (an import is a restore; a peer's record is the peer's). Bundle-23 gives that
 * recording one site per arrival path, a sink on the sync history and the import result, and a counter — and makes the pull door
 * record at all. Each of those is only reviewable against a record of today's answer taken before the code that produced it is
 * gone. Every expectation is a literal: derived from the server it would compare the new code with itself.
 *
 * ## What it pins
 *
 *  - **Push, batch** (`POST /api/sync/batch-upsert`): `200`, and per family a COUNT — `schemaViolations: <n>` of the documents that
 *    broke the schema — with every document stored. The rows themselves are not in the batch answer.
 *  - **Push, single** (`POST /api/sync/entities|facts|edges|chrono`): `200`, `{ status, schemaViolations: [{ field, value, reason }] }`
 *    — the ROWS, on the exit that kept the document.
 *  - **Both push answers count in every `validationMode`**, `off` included: the recording does not read the mode.
 *  - **Pull** (the real engine against a fake peer): the page is stored, the cycle answers `{ networksSynced, errors: 0, notFound }`
 *    with NO violation in it, the sync history holds none, and no warning line is logged — a pulled record records nothing.
 *  - **Admin import** (`importDocuments`): `results.<family>.schemaViolations` is `[{ _id, violations: [row] }]`, in every mode; a
 *    conforming document leaves the key absent.
 *
 * ## MCP pins
 *
 * None here: no MCP tool is an arrival door. The MCP-door pins are in the three files beside this one.
 *
 * ## It needs a peer address
 *
 * The pull half stands up a fake peer on this host's private address (`_private-address.mjs`): the peer fetch refuses loopback.
 * `privateAddressSkipReason()` skips on a laptop with none and THROWS under CI, like `mongoSkipReason()`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-arrival-records-a-schema-violation-as-pinned-before-bundle-23-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const MODES = ['strict', 'warn', 'off'];
const spaceOf = (mode) => `arrive${mode}`;
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const NUMBER_GOT_STRING = "expected type 'number', got 'string'";

const meta = (validationMode) => ({
  validationMode,
  suppressEmbeddings: true,
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number', required: true } } } },
    fact: { claim: { propertySchemas: { confidence: { type: 'number', required: true } } } },
    edge: { knows: { propertySchemas: { since: { type: 'number', required: true } } } },
    chrono: { event: { propertySchemas: { priority: { type: 'string', enum: ['low', 'high'] } } } },
  },
});

/**
 * One violating document per family: how to build it, its push route, and the row it earns. `ok` is the same family conforming.
 * `collection` is where it is stored; `key` the batch body key.
 */
const FAMILIES = {
  entities: {
    key: 'entities', collection: 'entities', single: '/entities', statusOnSingle: 'ok',
    bad: (s, id, seq) => build.entity(s, id, seq, { type: 'person', properties: { age: 'old' }, author: { ...PEER_AUTHOR } }),
    ok: (s, id, seq) => build.entity(s, id, seq, { type: 'person', properties: { age: 3 }, author: { ...PEER_AUTHOR } }),
    row: { field: 'properties.age', value: 'old', reason: NUMBER_GOT_STRING },
    counts: (n) => ({ upserted: 2, skipped: 0, tombstoned: 0, schemaViolations: n, rejected: 0 }),
  },
  facts: {
    key: 'facts', collection: 'facts', single: '/facts', statusOnSingle: 'inserted',
    bad: (s, id, seq) => build.fact(s, id, seq, { type: 'claim', properties: { confidence: 'high' }, author: { ...PEER_AUTHOR } }),
    ok: (s, id, seq) => build.fact(s, id, seq, { type: 'claim', properties: { confidence: 2 }, author: { ...PEER_AUTHOR } }),
    row: { field: 'properties.confidence', value: 'high', reason: NUMBER_GOT_STRING },
    counts: (n) => ({ inserted: 2, updated: 0, forked: 0, skipped: 0, forkDepthRefused: 0, tombstoned: 0, schemaViolations: n, rejected: 0 }),
  },
  edges: {
    key: 'edges', collection: 'edges', single: '/edges', statusOnSingle: 'ok',
    bad: (s, id, seq) => build.edge(s, id, seq, { label: 'knows', properties: { since: 'long ago' }, author: { ...PEER_AUTHOR } }),
    ok: (s, id, seq) => build.edge(s, id, seq, { label: 'knows', properties: { since: 1 }, author: { ...PEER_AUTHOR } }),
    row: { field: 'properties.since', value: 'long ago', reason: NUMBER_GOT_STRING },
    counts: (n) => ({ upserted: 2, skipped: 0, tombstoned: 0, schemaViolations: n, duplicateTriplets: 0, rejected: 0 }),
  },
  chrono: {
    key: 'chrono', collection: 'chrono', single: '/chrono', statusOnSingle: 'ok',
    bad: (s, id, seq) => build.chrono(s, id, seq, { type: 'event', properties: { priority: 'urgent' }, author: { ...PEER_AUTHOR } }),
    ok: (s, id, seq) => build.chrono(s, id, seq, { type: 'event', properties: { priority: 'low' }, author: { ...PEER_AUTHOR } }),
    row: { field: 'properties.priority', value: 'urgent', reason: 'must be one of: low, high' },
    counts: (n) => ({ upserted: 2, skipped: 0, tombstoned: 0, schemaViolations: n, unknownType: 0, rejected: 0 }),
  },
};

let door;
const at = (space) => ({ spaceId: space, networkId: door.NET, token: TOKEN });
const ids = (docs) => docs.map(d => d._id).sort();

describe('an arriving record that breaks the schema, as push, pull and import report it before bundle-23', { skip }, () => {
  before(async () => {
    door = await openPullDoor({
      suite: 'pinarrival',
      spaces: MODES.map(spaceOf),
      meta: Object.fromEntries(MODES.map(m => [spaceOf(m), meta(m)])),
    });
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    for (const m of MODES) await door.wipe(spaceOf(m));
  });

  it('every family has a case (a floor)', () => {
    assert.deepEqual(Object.keys(FAMILIES).sort(), ['chrono', 'edges', 'entities', 'facts']);
  });

  describe('push, batch: a COUNT per family, every document stored, in every mode', () => {
    for (const mode of MODES) {
      for (const [name, f] of Object.entries(FAMILIES)) {
        it(`${mode}: ${name}`, async () => {
          const space = spaceOf(mode);
          const out = await door.push('/batch-upsert', { [f.key]: [f.bad(space, `${name}-bad`, 5), f.ok(space, `${name}-ok`, 6)] }, at(space));
          assert.equal(out.code, 200, JSON.stringify(out.body));
          assert.equal(out.body.status, 'ok');
          assert.deepEqual(out.body[f.key], f.counts(1));
          assert.deepEqual(ids(await door.coll(space, f.collection).find({}).toArray()), [`${name}-bad`, `${name}-ok`].sort(), 'a violating document was not stored');
        });
      }
    }
  });

  describe('push, single: the ROWS, on the exit that kept the document, in every mode', () => {
    for (const mode of MODES) {
      for (const [name, f] of Object.entries(FAMILIES)) {
        it(`${mode}: ${name}`, async () => {
          const space = spaceOf(mode);
          const bad = await door.push(f.single, f.bad(space, `${name}-bad`, 5), at(space));
          assert.equal(bad.code, 200, JSON.stringify(bad.body));
          assert.deepEqual(bad.body, { status: f.statusOnSingle, schemaViolations: [f.row] });
          const good = await door.push(f.single, f.ok(space, `${name}-ok`, 6), at(space));
          assert.deepEqual(good.body, { status: f.statusOnSingle }, 'a conforming document was reported');
          assert.equal(await door.coll(space, f.collection).countDocuments({ _id: `${name}-bad` }), 1, 'a violating document was not stored');
        });
      }
    }
  });

  describe('pull: the page is stored and nothing records the violation', () => {
    for (const [name, f] of Object.entries(FAMILIES)) {
      it(name, async () => {
        const space = spaceOf('strict');
        door.state.records[space] = { [f.key]: [f.bad(space, `${name}-pulled-bad`, 20), f.ok(space, `${name}-pulled-ok`, 21)] };
        const { result, lines } = await door.logsDuring(() => door.sync());
        assert.deepEqual(result, { networksSynced: 1, errors: 0, notFound: false });
        assert.deepEqual(ids(await door.coll(space, f.collection).find({}).toArray()), [`${name}-pulled-bad`, `${name}-pulled-ok`].sort(),
          'a pulled violating document was not stored');
        assert.deepEqual(lines.filter(l => /violat|properties[.]|expected type|pulled-bad/i.test(l)), [], 'a pull logged the violation');
      });
    }

    it('the sync history of the cycle holds no violation', async () => {
      const space = spaceOf('strict');
      const f = FAMILIES.entities;
      door.state.records[space] = { entities: [f.bad(space, 'hist-bad', 30)] };
      // The history row is written by the NETWORK cycle (`runSyncForNetwork`), not the per-peer one the door's `sync` runs, and it is
      // persisted without being awaited — so the row is waited for, never slept for.
      const { runSyncForNetwork } = await import('../../server/dist/sync/engine.js');
      const { getSyncHistory } = await import('../../server/dist/sync/history.js');
      await runSyncForNetwork(door.NET);
      await waitFor(async () => (await getSyncHistory(door.NET)).length > 0, 15_000, 100, undefined, { what: 'the cycle\'s sync history row' });
      const history = await getSyncHistory(door.NET);
      assert.equal(await door.coll(space, 'entities').countDocuments({ _id: 'hist-bad' }), 1, 'the cycle did not pull the page (the pin would pass on nothing)');
      assert.doesNotMatch(JSON.stringify(history), /schemaViolation/);
    });
  });

  describe('admin import: `schemaViolations` is `[{ _id, violations }]`, in every mode', () => {
    let importDocuments;
    before(async () => { ({ importDocuments } = await import('../../server/dist/api/admin-import.js')); });

    for (const mode of MODES) {
      it(`${mode}: a violating document is stored and reported; a conforming one leaves the key absent`, async () => {
        const space = spaceOf(mode);
        const out = await importDocuments(space, {
          entities: [{ _id: 'imp-bad', name: 'Bad', type: 'person', properties: { age: 'old' }, tags: [], seq: 30 }],
          facts: [{ _id: 'imp-ok', fact: 'fine', type: 'claim', properties: { confidence: 2 }, tags: [], seq: 31 }],
        });
        assert.deepEqual(out.results.entities, {
          inserted: 1, updated: 0, errors: 0,
          schemaViolations: [{ _id: 'imp-bad', violations: [{ field: 'properties.age', value: 'old', reason: NUMBER_GOT_STRING }] }],
        });
        assert.deepEqual(out.results.facts, { inserted: 1, updated: 0, errors: 0 });
        assert.equal(await door.coll(space, 'entities').countDocuments({ _id: 'imp-bad' }), 1, 'a violating import document was not stored');
      });
    }
  });
});
