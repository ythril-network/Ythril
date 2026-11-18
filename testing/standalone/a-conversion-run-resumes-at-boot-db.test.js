/**
 * A conversion run a restart cut short is continued by the boot resume to `complete` (Q-746, bundle-284 design r5 section 5.2 "Resume" and
 * "Lease", findings N8, S13).
 *
 * ## The rule
 *
 * A `running` run document whose lease is stale (its process died) is taken by `resumeSchemaConvertRuns`, the call every configured start makes,
 * and continued until every record of its types is converted and the run reads `complete`. A run whose lease is fresh is another process's and
 * is left alone. Nothing but the document says what to do: no schema write is needed to wake it.
 *
 * ## Why a database test
 *
 * The source half (`a-conversion-run-resumes-at-boot`) proves the call is wired; only a real store proves the call finds a run it did not
 * create, takes it by the lease and finishes it (S13: a wiring test cannot fail when the resume does nothing).
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-conversion-run-resumes-at-boot-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const DEAD = 'resume-dead';
const HELD = 'resume-held';

/** A run document as a process that died mid-run left it: running, its lease older than any live sweeper's. */
const runLeftBy = (toFp, leaseAt) => ({
  _id: 'run', toFp, types: [{ kind: 'entity', type: 'person', done: false }], steps: [], stepsRefused: [], splitDeclared: {},
  sources: [{ kind: 'act', at: '2026-11-18T10:00:00.000Z' }], owed: false, syncedFirst: { asked: 0, answered: 0 },
  startedAt: '2026-11-18T10:00:00.000Z', cursor: null, counts: { stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 },
  state: 'running', failures: 0, sweepLeaseAt: leaseAt,
});

describe('a conversion run resumes at boot (real MongoDB)', { skip }, () => {
  let door, run;
  before(async () => {
    door = await openConvertDoor({ name: 'b284resume', spaces: [DEAD, HELD] });
    run = await door.runModule();
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('a running document with a stale lease is continued by the boot resume to complete', async () => {
    const people = await door.seed(DEAD, 'entities', [1, 2, 3].map(n => ({ _id: `p-${n}`, name: `P${n}`, type: 'person', properties: { age: n } })));
    const toFp = door.fp(DEAD);
    await door.mongo.col(door.spaceCollection(DEAD, 'schemaConvertRun')).insertOne(runLeftBy(toFp, Date.now() - 10 * 60_000));

    await run.resumeSchemaConvertRuns();
    const done = await waitForValue(async () => {
      const d = await door.runDoc(DEAD);
      return d?.state === 'complete' ? d : null;
    }, 20_000, 100, undefined, { what: 'the resumed run to read complete' });

    for (const p of people) {
      const row = await door.coll(DEAD, 'entities').findOne({ _id: p._id });
      assert.equal(row.schemaFingerprint, toFp, `${p._id} was not stamped by the resumed run`);
    }
    assert.equal(done.counts.stamped, people.length);
  });

  it('a run whose lease is fresh is another process\'s: the boot resume leaves it alone', async () => {
    await door.seed(HELD, 'entities', [{ _id: 'h-1', name: 'H', type: 'person', properties: { age: 1 } }]);
    await door.mongo.col(door.spaceCollection(HELD, 'schemaConvertRun')).insertOne(runLeftBy(door.fp(HELD), Date.now() + 60 * 60_000));
    await run.resumeSchemaConvertRuns();
    await new Promise(r => setTimeout(r, 500));
    const row = await door.coll(HELD, 'entities').findOne({ _id: 'h-1' });
    assert.equal(row.schemaFingerprint, undefined, 'a run another process holds was swept here');
    assert.equal((await door.runDoc(HELD)).state, 'running');
  });
});
