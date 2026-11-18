/**
 * A run restarted by a door while a pass is sweeping it is taken up again at once, and the pass that was sweeping writes nothing more for the
 * generation the restart replaced (`Q-746`, bundle-284 design r5 section 5.2; slice 5b's finding on `restartSchemaConvertRun`).
 *
 * ## What it prevents
 *
 * A door that changes a schema and takes no `convertRecords` restarts an unfinished run toward the schema it leaves (`restartSchemaConvertRun`).
 * The restart rewrote the run in place and KEPT the lease of the pass that was sweeping it. That pass then stopped, because the run's generation
 * moved under it, and nobody could take the run until its lease went stale: a minute with no conversion, after every schema edit made while a
 * run was going.
 *
 * ## What holds
 *
 * - restarted while a pass holds the lease (the pass is parked in its page hook), the run completes well inside the stale-lease time;
 * - the restarted generation is the one that completes, and the counts say the old pass converted nothing more once the restart replaced it:
 *   the page it had finished, and then every record once more toward the new fingerprint, nothing else.
 *
 * Run: node --test testing/standalone/a-restarted-run-is-swept-again-at-once-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'restarted';
/** More than two pages of the run's page size, so the restart lands with records still unread. */
const RECORDS = 250;
/** The page size of a run (`SCHEMA_CONVERT_PAGE_SIZE`), read from the module in `before`. */
let PAGE;
/** Well inside the lease's stale time (a minute): a restart that left the run to the stale lease cannot complete in it. */
const WITHIN_MS = 15_000;
const MOVED = structuredClone(CONVERT_META);
MOVED.typeSchemas.chrono.event.propertySchemas.place = { type: 'string' };

describe('a restarted run is swept again at once (real MongoDB)', { skip }, () => {
  let door, run;
  before(async () => {
    door = await openConvertDoor({ name: 'b284restarted', spaces: [S] });
    run = await door.runModule();
    PAGE = run.SCHEMA_CONVERT_PAGE_SIZE;
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('a restart while a pass holds the lease: the restarted run completes at once, and the old pass writes nothing more', async () => {
    await door.seed(S, 'entities', Array.from({ length: RECORDS }, (_, i) => ({
      _id: `p-${String(i).padStart(4, '0')}`, name: `P${i}`, type: 'person', properties: { age: i },
    })));
    let release;
    const parked = new Promise(r => { release = r; });
    let reached;
    const atFirstPage = new Promise(r => { reached = r; });
    let pages = 0;
    // The pass parks after its first page, holding the lease, until the test has restarted the run.
    const afterPage = async () => { pages++; if (pages === 1) { reached(); await parked; } };
    const started = await run.startSchemaConvertRun({ spaceId: S, types: [{ kind: 'entity', type: 'person' }], steps: [], source: { kind: 'act' } },
      { afterPage });
    assert.equal(started.ok, true, JSON.stringify(started));
    await atFirstPage;

    door.setMeta(S, MOVED);
    const newFp = door.fp(S);
    assert.equal(await run.restartSchemaConvertRun(S), true, 'there was no unfinished run to restart');
    const restarted = await door.runDoc(S);
    assert.equal(restarted.toFp, newFp);
    const generation = restarted.generation;
    release();

    const done = await waitForValue(async () => { const d = await door.runDoc(S); return d?.state === 'complete' ? d : null; },
      WITHIN_MS, 100, async () => `the restarted run was not taken up: ${JSON.stringify(await door.runDoc(S))}`, { what: 'the restarted run to complete' });
    assert.equal(done.generation, generation, 'the run was rewritten again after the restart');
    assert.equal(done.toFp, newFp);
    assert.equal(done.counts.stamped, PAGE + RECORDS, `the old pass converted more after the restart replaced it: ${JSON.stringify(done.counts)}`);
    const stale = await door.coll(S, 'entities').countDocuments({ schemaFingerprint: { $ne: newFp } });
    assert.equal(stale, 0, 'records were left on a fingerprint other than the new one');
  });
});
