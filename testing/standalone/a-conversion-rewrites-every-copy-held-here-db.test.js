/**
 * A conversion rewrites every copy of its types this instance holds, whoever last wrote it (Q-746, bundle-284 design r5 sections 0, 5.1
 * "Records", 5.3; amendments A1 and A2: owner, 2026-11-18, "yes, as always data that arrives on my instance is mine to manage").
 *
 * ## The rule
 *
 * - A row written here, a row a peer delivered and a row whose author left the network are all rewritten by the steps: the written-here bit is
 *   not read.
 * - A fork row (an unresolved version of a record) is never touched: not rewritten, not stamped.
 * - A copy that already carries what the steps would make of it (another member converted it and it arrived) is not rewritten again: the steps
 *   change nothing on it, so it is stamped quietly and its version does not move.
 *
 * Replaces r4's `a-conversion-rewrites-only-records-written-here-db`.
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-conversion-rewrites-every-copy-held-here-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META, SEEDED_AT } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'every-copy';
const RENAME = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' };
const AFTER = structuredClone(CONVERT_META);
AFTER.typeSchemas.entity.person.propertySchemas = { age: { type: 'number' }, alias: { type: 'string' } };
const OLD_FP = 'd'.repeat(64);

describe('a conversion rewrites every copy held here (real MongoDB)', { skip }, () => {
  let door, run;
  before(async () => {
    door = await openConvertDoor({ name: 'b284everycopy', spaces: [S] });
    run = await door.runModule();
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('written here, delivered by a peer and authored by a departed instance: all rewritten; a fork untouched; a converted copy stamped quietly', async () => {
    const seeded = await door.seed(S, 'entities', [
      { _id: 'here', name: 'Here', type: 'person', properties: { nick: 'h' } },
      { _id: 'peer', name: 'Peer', type: 'person', properties: { nick: 'p' }, deliveredBy: 'peer-a', author: { instanceId: 'peer-a', instanceLabel: 'A' } },
      { _id: 'gone', name: 'Gone', type: 'person', properties: { nick: 'g' }, deliveredBy: 'departed', author: { instanceId: 'departed', instanceLabel: 'D' } },
      { _id: 'fork-of-here', forkOf: 'here', name: 'Here (theirs)', type: 'person', properties: { nick: 'fork' }, deliveredBy: 'peer-a',
        author: { instanceId: 'peer-a', instanceLabel: 'A' } },
      { _id: 'converted', name: 'Converted', type: 'person', properties: { alias: 'c' }, deliveredBy: 'peer-a',
        author: { instanceId: 'peer-a', instanceLabel: 'A' }, schemaFingerprint: OLD_FP },
    ]);
    const before = Object.fromEntries(seeded.map(r => [r._id, r]));
    door.setMeta(S, AFTER);
    const toFp = door.fp(S);

    const started = await run.startSchemaConvertRun({ spaceId: S, types: [{ kind: 'entity', type: 'person' }], steps: [RENAME], source: { kind: 'act' } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await waitForValue(async () => { const d = await door.runDoc(S); return d?.state === 'complete' ? d : null; },
      20_000, 100, undefined, { what: 'the run to complete' });

    for (const [id, nick] of [['here', 'h'], ['peer', 'p'], ['gone', 'g']]) {
      const row = await door.coll(S, 'entities').findOne({ _id: id });
      assert.deepEqual(row.properties, { alias: nick }, `${id}: the copy held here was not rewritten`);
      assert.equal(row.schemaFingerprint, toFp, `${id}: the rewrite carries no stamp`);
      assert.ok(row.seq > before[id].seq, `${id}: a rewrite is a new version`);
    }
    const fork = await door.coll(S, 'entities').findOne({ _id: 'fork-of-here' });
    assert.deepEqual(fork, { ...before['fork-of-here'] }, 'a fork row was touched');

    const converted = await door.coll(S, 'entities').findOne({ _id: 'converted' });
    assert.deepEqual(converted.properties, { alias: 'c' });
    assert.equal(converted.schemaFingerprint, toFp, 'a copy already converted is stamped');
    assert.equal(converted.seq, before.converted.seq, 'a copy already converted is not rewritten: its version does not move');
    assert.equal(converted.updatedAt, SEEDED_AT);

    assert.equal(done.counts.rewritten, 3);
    assert.equal(done.counts.stamped, 1);
    assert.deepEqual(await door.itemRows(S), []);
  });
});
