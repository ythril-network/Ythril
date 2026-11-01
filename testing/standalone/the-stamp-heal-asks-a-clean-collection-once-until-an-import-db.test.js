/**
 * The heal of stored retention stamps asks a collection with nothing to heal ONCE, and again only after an import (Q-223; bundle-40
 * plan R3: "a per-process latch per (space, collection) is set by an empty pass and reset by any import, so a healed collection
 * costs nothing per cycle").
 *
 * ## The defect it prevents
 *
 * The sweep runs every five minutes over every collection of every space. A heal that asks the store "is any stamp here not a Date?"
 * on every one of those runs, for ever, is a standing cost on every space of every instance for a question whose answer can only
 * change when something that can store a non-Date stamp runs: an import (a peer's arrival never carries a stamp, and a local write
 * stamps a Date). Without the latch the pass is correct and permanent noise: five reads per space per five minutes.
 *
 * ## The rule, counted from the store's own command log
 *
 * A "heal query" is a read command (find, aggregate, count, distinct) on a space's collection whose filter or pipeline names
 * `_expireAt` or `_contentExpireAt` AND the BSON-type operator `$type`, and no range operator: the question "is this stamp a Date".
 * The expiry pass (`$lte`) and the backfills (`$exists`) never carry `$type`.
 *
 *  - the first cycle over a space with nothing to heal asks every swept collection (`TTL_COLLECTIONS`, derived) at least once: the
 *    pass ran and found nothing, which is what sets the latch (a floor, so a heal that never asks cannot pass the rest);
 *  - the next two cycles ask none of them again;
 *  - an import into the space resets the latch: the next cycle asks the collection the import wrote to again, and the cycle after
 *    asks it no more.
 *
 * ## Seen red
 *
 * On the base nothing asks the type question at all, so the first cycle's floor fails ("no collection was asked").
 *
 * Run: node --test testing/standalone/the-stamp-heal-asks-a-clean-collection-once-until-an-import-db.test.js
 * (requires a prior `npm run build:server` and the harness Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'stamp-heal-latch';
const READS = new Set(['find', 'aggregate', 'count', 'distinct']);

let acts, door, ttl, importMod, ttlCollections, client, dbName, onStarted;
/** [collection part, text] of every heal query seen so far. */
let asked = [];

const safe = (v) => { try { return JSON.stringify(v); } catch { return ''; } };
/** Is this command the question "is a stamp of this collection not a Date"? */
function healQuery(ev) {
  if (ev.databaseName !== dbName || !READS.has(ev.commandName)) return null;
  const coll = String(ev.command?.[ev.commandName] ?? '');
  if (!coll.startsWith(`${S}_`)) return null;
  const { lsid: _lsid, $db: _db, $clusterTime: _ct, ...body } = ev.command;
  const text = safe(body);
  if (!/_expireAt|_contentExpireAt/.test(text) || !/\$type/.test(text) || /\$lte|\$gte|\$lt\b|\$gt\b/.test(text)) return null;
  return coll.slice(S.length + 1);
}
/** Run one real cycle and say which collections of S it asked the type question of. */
async function cycle() {
  asked = [];
  await ttl.sweepExpired(new Date());
  return [...new Set(asked)].sort();
}

describe('the stamp heal asks a clean collection once, until an import resets it (Q-223)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'stamp-heal-latch', space: S, monitorCommands: true });
    ({ door } = acts);
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    importMod = await import('../../server/dist/api/admin-import.js');
    ({ TTL_COLLECTIONS: ttlCollections } = await import('../../server/dist/brain/ttl.js'));
    client = door.mongo.getMongo();
    dbName = door.mongo.getDb().databaseName;
    onStarted = (ev) => { const part = healQuery(ev); if (part) asked.push(part); };
    client.on('commandStarted', onStarted);
    await door.wipe(S);
  });
  after(async () => {
    client?.off('commandStarted', onStarted);
    await acts?.close();
  });

  it('the swept collections are derived, and the command log can see a heal query (the matcher is exercised, not trusted)', () => {
    assert.ok(ttlCollections.length >= 5, `only ${ttlCollections.length} swept collections`);
    const q = (command) => healQuery({ databaseName: dbName, commandName: 'find', command: { find: `${S}_facts`, ...command } });
    assert.equal(q({ filter: { _expireAt: { $exists: true, $not: { $type: 'date' } } } }), 'facts');
    assert.equal(q({ filter: { $expr: { $ne: [{ $type: '$_expireAt' }, 'date'] } } }), 'facts');
    assert.equal(q({ filter: { _expireAt: { $lte: new Date() } } }), null, 'the expiry page is not a heal query');
    assert.equal(q({ filter: { _expireAt: { $exists: false } } }), null, 'the backfill is not a heal query');
    assert.equal(q({ filter: { name: { $type: 'string' } } }), null, 'a type test on another field is not a heal query');
  });

  it('the first cycle over a space with nothing to heal asks every swept collection at least once, and the next two ask none of them again', async () => {
    const first = await cycle();
    assert.deepEqual(first, [...ttlCollections].sort(),
      `the first cycle asked ${first.length === 0 ? 'no collection' : first.join(', ')} whether a stamp is not a Date, want every swept collection`);
    for (const n of [2, 3]) {
      const again = await cycle();
      assert.deepEqual(again, [], `cycle ${n} asked ${again.join(', ')} again although the first found nothing to heal and nothing was imported`);
    }
  });

  it('an import into the space resets the latch: the next cycle asks the collection it wrote to again, and the one after asks it no more', async () => {
    await importMod.importDocuments(S, { facts: [build.fact(S, 'latch-fact', 40)] });
    const afterImport = await cycle();
    assert.ok(afterImport.includes('facts'), `the cycle after an import into ${S}_facts asked ${afterImport.join(', ') || 'nothing'}: the latch was not reset`);
    const quiet = await cycle();
    assert.deepEqual(quiet, [], `the cycle after that asked ${quiet.join(', ')} again: the latch was not set by the second empty pass`);
  });
});
