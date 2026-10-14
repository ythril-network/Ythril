/**
 * The history row of a sync cycle says, per space, what the pulled pages stored that the local schema does not accept — in names and counts,
 * and only when there is something to say (R6-9, "sync history per space {records with violations, top keys/rules by count}").
 *
 * ## Why a row, when the log line is already said
 *
 * The pull has no structured answer a caller reads: a push answers its sender per document, an import answers its operator, a pull answers nobody.
 * The log line is one per (space, peer) per window, and a window hides every cycle after the first. What an operator of a network reads afterwards is
 * `GET /api/networks/:id/sync-history` (and MCP `network_sync_history`), one row per cycle: so the cycle's recording belongs on it, bounded —
 * the documents counted, the field names that most of them carried, each with how many — and never a value or a document id.
 *
 * ## What holds
 *
 *  - a cycle that pulled a document carrying an undeclared key into a `warn` space has `schemaViolations: [{ spaceId, records, top }]`, `top`
 *    naming `properties.<key>` once, with its count;
 *  - the row carries NO value of the key and no document id (a name is the sender's, a value is its data);
 *  - a cycle that stored nothing of the kind writes the row it always wrote: no `schemaViolations` key at all;
 *  - an `off` space records nothing, and a document the plan skipped (already held at that seq) records nothing a second time.
 *
 * ## Seen red
 *
 * By mutation, each put back by hand: the `schemaViolations` the engine hands `recordSyncResult` made unreachable, and the pull family's merge of a
 * page's summary replaced by a merge of nothing — three of the five cases fail each time (the row has no field, so the naming, the value-free
 * row and the replay cases have nothing to read). The `off` and `clean` cases are controls for what must stay absent, and stay green by design.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/a-pull-says-what-it-stored-against-the-schema-in-its-sync-history-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { undeclaredKeySpaces, spaceOf } from './_undeclared-key-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SECRET = 'SECRET-VALUE-4c1d';
const SPACES = Object.freeze({ warn: 'pullhistwarn', off: 'pullhistoff', replay: 'pullhistreplay', clean: 'pullhistclean' });
const metaOf = (mode) => structuredClone(undeclaredKeySpaces().find(s => s.id === spaceOf(mode)).meta);
const META = { [SPACES.warn]: metaOf('warn'), [SPACES.off]: metaOf('off'), [SPACES.replay]: metaOf('warn'), [SPACES.clean]: metaOf('warn') };

let door, engine;

/** A `service` entity (its type declares `status` only), carrying `extra` beside a declared `status`. */
const entity = (space, id, seq, extra = {}) => build.entity(space, id, seq, { type: 'service', properties: { status: 'up', ...extra } });

/** One real sync cycle against the fake peer, and the history row it wrote (written without the cycle awaiting it). */
async function cycle() {
  const since = new Date().toISOString();
  const out = await engine.runSyncForNetwork(door.NET);
  await door.settled();
  let row;
  await waitFor(async () => {
    row = (await door.mongo.col('_sync_history').find({ networkId: door.NET, triggeredAt: { $gte: since } }).toArray())[0];
    return row !== undefined;
  }, 10_000, 100, undefined, { what: 'the sync history row of the cycle' });
  assert.equal(out.errors, 0, `the cycle failed: ${JSON.stringify(out)}`);
  return row;
}
const rowFor = (row, space) => (row.schemaViolations ?? []).find(r => r.spaceId === space);

describe('a pull says what it stored against the local schema in its sync history', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'pullhistory', spaces: Object.values(SPACES), meta: META });
    engine = await import('../../server/dist/sync/engine.js');
  });
  after(async () => { await door?.close(); });

  it('names the documents and the field, once, with its count', async () => {
    door.state.records = { [SPACES.warn]: { entities: [
      entity(SPACES.warn, 'e1', 5, { zzHistKey: SECRET }), entity(SPACES.warn, 'e2', 5, { zzHistKey: SECRET }), entity(SPACES.warn, 'e3', 5),
    ] } };
    const row = await cycle();
    const mine = rowFor(row, SPACES.warn);
    assert.ok(mine, `the row has no entry for the space: ${JSON.stringify(row.schemaViolations ?? null)}`);
    assert.equal(mine.records, 2, 'two documents carry the key and one is clean');
    assert.deepEqual(mine.top, [{ name: 'properties.zzHistKey', count: 2 }]);
  });

  it('carries no value and no document id', async () => {
    door.state.records = { [SPACES.warn]: { entities: [entity(SPACES.warn, 'e-secret-id', 7, { zzValueKey: SECRET })] } };
    const row = await cycle();
    const text = JSON.stringify(row);
    assert.ok(rowFor(row, SPACES.warn)?.top.some(t => t.name === 'properties.zzValueKey'), `the key is not named: ${text}`);
    assert.ok(!text.includes(SECRET), 'the history row carries the VALUE of an undeclared key');
    assert.ok(!text.includes('e-secret-id'), 'the history row carries a document id');
  });

  it('a cycle that stored nothing of the kind writes the row it always wrote', async () => {
    door.state.records = { [SPACES.clean]: { entities: [entity(SPACES.clean, 'c1', 5)] } };
    const row = await cycle();
    assert.equal(Object.hasOwn(row, 'schemaViolations'), false, `a clean cycle grew a schemaViolations field: ${JSON.stringify(row.schemaViolations)}`);
  });

  it('an off space records nothing', async () => {
    door.state.records = { [SPACES.off]: { entities: [entity(SPACES.off, 'o1', 5, { zzOffKey: SECRET })] } };
    const row = await cycle();
    assert.equal(rowFor(row, SPACES.off), undefined, `an off space was recorded: ${JSON.stringify(row.schemaViolations)}`);
    assert.ok(await door.coll(SPACES.off, 'entities').findOne({ _id: 'o1' }), 'the off space did not store the document: the case is not about it');
  });

  it('a document already held at that seq is not recorded a second time', async () => {
    door.state.records = { [SPACES.replay]: { entities: [entity(SPACES.replay, 'r1', 5, { zzReplayKey: SECRET })] } };
    assert.ok(rowFor(await cycle(), SPACES.replay), 'the first arrival was not recorded, so a replay has nothing to repeat');
    const again = await cycle();
    assert.equal(rowFor(again, SPACES.replay), undefined, `the replay recorded the key again: ${JSON.stringify(again.schemaViolations)}`);
  });
});
