/**
 * A conversion with no steps (`convertRecords: {}`) stamps every conforming copy of its types QUIETLY (Q-746, bundle-284 design r5 sections 0
 * "Quiet stamp" and 5.3 step 3, decision 1, findings B1, S4, S14, N2).
 *
 * ## The rule
 *
 * Every conforming record of the run's type that this instance holds gets the run's fingerprint, whoever wrote it: a row written here, one a
 * peer delivered, one whose author left the network. The write is the stamp alone: its version (`seq`), its position (`pos`, `posAtSeq`) and its
 * `updatedAt` stay as they were, no embed job is queued and no change is published (no webhook, no live update), so nothing replicates and no
 * list reorders. A record that does not conform is not written at all (its old stamp still names the version it conforms to) and becomes an
 * item.
 *
 * ## What was wrong
 *
 * r3 stamped through the update path, which moved every record's version and position: a schema save reordered every list on every member and
 * re-sent every record (B1, S14).
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-conforming-record-is-stamped-quietly-on-every-copy-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, SEEDED_AT } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'quiet';
const OLD_FP = 'c'.repeat(64);

describe('a conforming record is stamped quietly on every copy (real MongoDB)', { skip }, () => {
  let door, run, events, unsubscribe;
  before(async () => {
    door = await openConvertDoor({ name: 'b284quiet', spaces: [S] });
    run = await door.runModule();
    const { subscribeBrainChanges } = await import('../../server/dist/brain/brain-events.js');
    events = [];
    unsubscribe = subscribeBrainChanges(S, ev => events.push(ev));
  });
  after(async () => { unsubscribe?.(); run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('stamps every conforming copy with seq, position and updatedAt unchanged, no embed job, no change published; the rest is an item', async () => {
    const seeded = await door.seed(S, 'entities', [
      { _id: 'here', name: 'Here', type: 'person', properties: { age: 1 } },
      { _id: 'peer', name: 'Peer', type: 'person', properties: { age: 2 }, deliveredBy: 'peer-a', author: { instanceId: 'peer-a', instanceLabel: 'A' } },
      { _id: 'gone', name: 'Gone', type: 'person', properties: { age: 3 }, deliveredBy: 'departed', author: { instanceId: 'departed', instanceLabel: 'D' },
        schemaFingerprint: OLD_FP },
      { _id: 'bad', name: 'Bad', type: 'person', properties: { age: 'old' }, schemaFingerprint: OLD_FP },
    ]);
    const jobsBefore = await door.coll(S, 'embed_jobs').countDocuments({});
    const toFp = door.fp(S);

    const started = await run.startSchemaConvertRun({ spaceId: S, types: [{ kind: 'entity', type: 'person' }], steps: [], source: { kind: 'write' } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await waitForValue(async () => { const d = await door.runDoc(S); return d?.state === 'complete' ? d : null; },
      20_000, 100, undefined, { what: 'the run to complete' });

    for (const want of seeded.filter(r => r._id !== 'bad')) {
      const row = await door.coll(S, 'entities').findOne({ _id: want._id });
      assert.equal(row.schemaFingerprint, toFp, `${want._id}: a conforming copy was not stamped`);
      assert.equal(row.seq, want.seq, `${want._id}: the quiet stamp moved the version`);
      assert.equal(row.pos, want.pos, `${want._id}: the quiet stamp moved the position`);
      assert.equal(row.posAtSeq, want.posAtSeq, `${want._id}: the quiet stamp moved the position's version`);
      assert.equal(row.updatedAt, SEEDED_AT, `${want._id}: the quiet stamp moved updatedAt`);
    }
    const bad = await door.coll(S, 'entities').findOne({ _id: 'bad' });
    assert.equal(bad.schemaFingerprint, OLD_FP, 'a record that does not conform is not written: its old stamp stays');
    assert.equal(bad.seq, seeded.find(r => r._id === 'bad').seq);
    const items = await door.itemRows(S);
    assert.deepEqual(items.map(i => [i.recordId, i.reason]), [['bad', 'not_conforming']]);

    assert.equal(await door.coll(S, 'embed_jobs').countDocuments({}), jobsBefore, 'a quiet stamp queued an embed job');
    assert.deepEqual(events, [], 'a quiet stamp published a change (a webhook or a live update)');
    assert.equal(done.counts.stamped, 3);
    assert.equal(done.counts.unconverted, 1);
  });
});
