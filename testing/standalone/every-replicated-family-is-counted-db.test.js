/**
 * Every replicated family is counted: in a cycle's history row and in the item metrics, from ONE list (bundle-39, Q-265; plan D3).
 *
 * ## The defect
 *
 * `SyncCounts` (the `pulled` / `pushed` of a history row) named six keys by hand: facts, entities, edges, files, chrono, links. The family
 * list has six rows too, but they are not the same six: file METADATA (`payloadKey: 'filemeta'`, collection `files`) is a family, and the
 * `files` key was fed by something else, the file ROUTES (`syncFiles`). So a cycle that moved only file-metadata records pulled and pushed them
 * and counted nothing, in the history and in `ythril_sync_items_{pulled,pushed}_total{type}`; and the one label `files` meant file bytes on a
 * stored count and file-metadata rows on a refused or held one. Seven hand-written count literals (`space-exchange.ts`, `engine.ts`,
 * `history.ts`, `cycle-outcome.ts`, the client) each had to be edited for a family, and one was always missed (Q-59 was `links`).
 *
 * ## The rule
 *
 *  1. A cycle that moves only file metadata records a `filemeta` count in the history row's `pulled` / `pushed` and in
 *     `ythril_sync_items_pulled_total{type="filemeta",outcome="stored"}` / `…_pushed_total`; every other count of that cycle is 0.
 *  2. `files` counts the FILES the file routes moved (not their bytes), in the history and under `type="files"`; it is not the file-metadata count.
 *  3. The keys a cycle counts are exactly each family's count key (`countKey` on its row of `REPLICATED_FAMILIES`) plus `files`, in the history row and
 *     in the metric's `type` labels. The expected set is DERIVED from the family list at run time: a seventh family is counted by being listed, and a
 *     test that spelled the keys by hand would pass while the seventh went uncounted.
 *
 * ## How red shows
 *
 * Base: the file-metadata cycle's history has `filemeta` undefined and the metric no `filemeta` series; `countKey` is not a field of the family rows,
 * so the derived set cannot be built and the key-set cases fail on that first; the history rows have six keys and no `filemeta`. Rule 2 holds at
 * the base (the files count is already files moved), and is here so it keeps holding when the list drives the counts.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/every-replicated-family-is-counted-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { build, derivedLinkBuilder } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { clearPositionMarks, positioned } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'everyfamily';
const BASE = 100;

let door, engine, FAMILIES, itemsPulled, itemsPushed, linkOf, ME;

/** Each family's count key as the list names it, or an assertion that it names none (the derived set cannot be built without it). */
function countKeys() {
  const keys = FAMILIES.map(f => f.countKey);
  const missing = FAMILIES.filter(f => typeof f.countKey !== 'string' || f.countKey === '').map(f => f.payloadKey);
  assert.deepEqual(missing, [], `these rows of REPLICATED_FAMILIES name no count key (countKey): ${missing.join(', ')}. The counts are derived from the list, so every row must say what it is counted as`);
  assert.equal(new Set(keys).size, keys.length, `two families share a count key: ${keys.join(', ')}`);
  return keys;
}
/** The keys a cycle counts: every family's, and the file routes' own. */
const expectedKeys = () => [...countKeys(), 'files'].sort();

/** Every `type` label of `counter`'s stored series with its value now, as { type -> value }. */
async function stored(counter) {
  const { values } = await counter.get();
  const out = {};
  for (const v of values) if (v.labels.outcome === 'stored' && v.labels.type) out[v.labels.type] = (out[v.labels.type] ?? 0) + v.value;
  return out;
}
const grown = (before, after) => Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - (before[k] ?? 0)]).filter(([, d]) => d !== 0));

/** One network cycle as the scheduler runs it: the history row it wrote and what the item metrics gained. */
async function cycle() {
  const since = new Date().toISOString();
  const before = { pulled: await stored(itemsPulled), pushed: await stored(itemsPushed) };
  const out = await engine.runSyncForNetwork(door.NET);
  await door.settled();
  let row;
  await waitFor(async () => {
    row = (await door.mongo.col('_sync_history').find({ networkId: door.NET, triggeredAt: { $gte: since } }).toArray())[0];
    return row !== undefined;
  }, 10_000, 100, undefined, { what: 'the sync history row of the cycle' });
  return { out, row, metric: { pulled: grown(before.pulled, await stored(itemsPulled)), pushed: grown(before.pushed, await stored(itemsPushed)) } };
}

/** A count object with every key but `moved` at 0 (a key an old row lacks reads as undefined and is not what this asserts). */
const only = (keys, moved) => Object.fromEntries(keys.map(k => [k, moved[k] ?? 0]));

describe('every replicated family is counted, from the family list', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b39A_counts', spaces: [S], direction: 'pull', files: true });
    engine = await import('../../server/dist/sync/engine.js');
    ({ REPLICATED_FAMILIES: FAMILIES } = await import('../../server/dist/sync/replicated-families.js'));
    ({ syncItemsPulledTotal: itemsPulled, syncItemsPushedTotal: itemsPushed } = await import('../../server/dist/metrics/registry.js'));
    linkOf = await derivedLinkBuilder();
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'pull' });
    clearPositionMarks(door);
    door.member().consecutiveFailures = 0;
    door.state.family = door.serveFamily;
  });

  it('a cycle that PULLS only file metadata counts it as `filemeta`, in the history and in the metric', async () => {
    await door.seedPeerRecords(S, 'filemeta', [positioned(build.filemeta(S, 'meta-only.txt', BASE + 1, { author: PEER_AUTHOR }))]);
    const { row, metric } = await cycle();
    assert.ok(await door.coll(S, 'files').findOne({ _id: 'meta-only.txt' }), 'fixture check: the file-metadata row did not land, so there was nothing to count');
    const keys = expectedKeys();
    assert.deepEqual(only(keys, row.pulled), { ...only(keys, {}), filemeta: 1 },
      `the history's pulled counts are ${JSON.stringify(row.pulled)}: a cycle that stored one file-metadata record must count it as filemeta and count nothing else`);
    assert.deepEqual(only(keys, row.pushed), only(keys, {}), `the history's pushed counts are ${JSON.stringify(row.pushed)}: nothing was pushed`);
    assert.deepEqual(metric.pulled, { filemeta: 1 }, `ythril_sync_items_pulled_total{outcome="stored"} grew by ${JSON.stringify(metric.pulled)}: the file-metadata record is not under type="filemeta"`);
    assert.deepEqual(metric.pushed, {}, `ythril_sync_items_pushed_total grew by ${JSON.stringify(metric.pushed)} in a cycle that pushed nothing`);
  });

  it('a cycle that PUSHES only file metadata counts it as `filemeta`, in the history and in the metric', async () => {
    door.configure({ direction: 'both' });
    door.member().direction = 'both';
    await door.coll(S, 'files').insertOne(positioned(build.filemeta(S, 'push-meta.txt', 30, { author: ME }), { writtenHere: true }));
    await door.raiseVersionTo(S, 30);
    const { row, metric } = await cycle();
    assert.deepEqual(door.state.pushedRecords.map(r => `${r.key}/${r._id}`), ['filemeta/push-meta.txt'], 'fixture check: the file-metadata row was not pushed');
    const keys = expectedKeys();
    assert.deepEqual(only(keys, row.pushed), { ...only(keys, {}), filemeta: 1 },
      `the history's pushed counts are ${JSON.stringify(row.pushed)}: a cycle that pushed one file-metadata record must count it as filemeta and count nothing else`);
    assert.deepEqual(only(keys, row.pulled), only(keys, {}), `the history's pulled counts are ${JSON.stringify(row.pulled)}: nothing was pulled`);
    assert.deepEqual(metric.pushed, { filemeta: 1 }, `ythril_sync_items_pushed_total{outcome="stored"} grew by ${JSON.stringify(metric.pushed)}: the file-metadata record is not under type="filemeta"`);
    assert.deepEqual(metric.pulled, {}, `ythril_sync_items_pulled_total grew by ${JSON.stringify(metric.pulled)} in a cycle that pulled nothing`);
  });

  it('`files` counts the FILES the file routes moved, not their bytes, and is not the file-metadata count', async () => {
    door.seedPeerFile(S, 'short.txt', 'a');
    door.seedPeerFile(S, 'longer.txt', 'a considerably longer body, so a count of bytes cannot be taken for a count of files'.repeat(4));
    const { row, metric } = await cycle();
    assert.ok(door.localFileExists(S, 'short.txt') && door.localFileExists(S, 'longer.txt'), 'fixture check: the two files did not arrive');
    assert.equal(row.pulled.files, 2, `the history counts ${row.pulled.files} files pulled: two files moved (not their bytes)`);
    assert.ok(!(row.pulled.filemeta > 0), `the history counts ${row.pulled.filemeta} file-metadata records pulled in a cycle whose peer served none (a file moved is not a metadata record)`);
    assert.equal(metric.pulled.files, 2, `ythril_sync_items_pulled_total{type="files"} grew by ${metric.pulled.files}: it must count the two files moved`);
    assert.ok(!(metric.pulled.filemeta > 0), 'type="filemeta" grew in a cycle that moved only file bytes');
  });

  it('the keys a cycle counts equal the family list\'s count keys plus `files`, in the history and in the metric labels', async () => {
    const keys = expectedKeys();
    door.configure({ direction: 'both' });
    door.member().direction = 'both';
    // One record of EVERY family on each side, and a file each way: whatever the list says, something of it moves and must be counted.
    const peerRows = {
      facts: build.fact(S, 'in-fact', BASE + 1, { author: PEER_AUTHOR }),
      entities: build.entity(S, 'in-entity', BASE + 2, { author: PEER_AUTHOR }),
      chrono: build.chrono(S, 'in-chrono', BASE + 3, { author: PEER_AUTHOR }),
      filemeta: build.filemeta(S, 'in-meta.txt', BASE + 4, { author: PEER_AUTHOR }),
      edges: build.edge(S, 'in-edge', BASE + 5, { author: PEER_AUTHOR }),
      links: linkOf(S, 'in-link', BASE + 6, { author: PEER_AUTHOR }),
    };
    const localRows = {
      facts: build.fact(S, 'out-fact', 31, { author: ME }),
      entities: build.entity(S, 'out-entity', 32, { author: ME }),
      chrono: build.chrono(S, 'out-chrono', 33, { author: ME }),
      filemeta: build.filemeta(S, 'out-meta.txt', 34, { author: ME }),
      edges: build.edge(S, 'out-edge', 35, { author: ME }),
      links: linkOf(S, 'out-link', 36, { author: ME }),
    };
    assert.deepEqual(Object.keys(peerRows).sort(), FAMILIES.map(f => f.payloadKey).sort(),
      'fixture check: the fixtures do not cover every family of the list, so a family added to it would be counted by nothing here');
    for (const f of FAMILIES) {
      await door.seedPeerRecords(S, f.payloadKey, [positioned(peerRows[f.payloadKey])]);
      await door.coll(S, f.collection).insertOne(positioned(localRows[f.payloadKey], { writtenHere: true }));
    }
    await door.raiseVersionTo(S, 40);
    door.seedPeerFile(S, 'in-file.txt', 'bytes in');
    door.writeLocalFile(S, 'out-file.txt', 'bytes out');
    const { row, metric } = await cycle();
    // What went on the wire per family, from the fake peer's own log: a pubsub peer is also sent what it handed over, so the expected push count is what the
    // peer RECEIVED of the family (identities, not a hand count), and it must include the record written here.
    const sentOf = (f) => door.state.pushedRecords.filter(r => r.key === f.payloadKey);
    for (const f of FAMILIES) {
      assert.ok(sentOf(f).some(r => r._id === localRows[f.payloadKey]._id), `fixture check: the ${f.payloadKey} record written here was not pushed (${JSON.stringify(sentOf(f).map(r => r._id))})`);
    }
    for (const f of FAMILIES) assert.ok(await door.coll(S, f.collection).findOne({ _id: peerRows[f.payloadKey]._id }), `fixture check: the pulled ${f.payloadKey} row did not land`);

    assert.deepEqual(Object.keys(row.pulled).sort(), keys, 'the history row\'s pulled counts are not keyed by the family list\'s count keys plus files');
    assert.deepEqual(Object.keys(row.pushed).sort(), keys, 'the history row\'s pushed counts are not keyed by the family list\'s count keys plus files');
    for (const f of FAMILIES) {
      assert.equal(row.pulled[f.countKey], 1, `the history counts ${row.pulled[f.countKey]} pulled for ${f.countKey}: one record of the family moved`);
      assert.equal(row.pushed[f.countKey], sentOf(f).length, `the history counts ${row.pushed[f.countKey]} pushed for ${f.countKey}: the peer received ${sentOf(f).length} records of the family`);
    }
    assert.equal(row.pulled.files, 1, `the history counts ${row.pulled.files} files pulled: one file moved in`);
    assert.equal(row.pushed.files, 1, `the history counts ${row.pushed.files} files pushed: one file moved out`);
    assert.deepEqual(Object.keys(metric.pulled).sort(), keys, 'ythril_sync_items_pulled_total{outcome="stored"} has not gained exactly the list\'s count keys plus files as `type` labels');
    assert.deepEqual(Object.keys(metric.pushed).sort(), keys, 'ythril_sync_items_pushed_total{outcome="stored"} has not gained exactly the list\'s count keys plus files as `type` labels');
  });
});
