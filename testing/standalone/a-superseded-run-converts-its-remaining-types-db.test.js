/**
 * A run whose fingerprint moves under it restarts toward the new one and still converts the records it had not reached (Q-746, bundle-284 design
 * r5 sections 2.1 note and 5.2 "Restart instead of supersede", finding B2).
 *
 * ## The rule
 *
 * Before each page the run asks the space's fingerprint. A door that converts nothing (here a schema write of another type, as a single-type PUT,
 * a library edit or a layer pull would make) moves it while the run is part-way through type T: the run is restarted in place toward the new
 * fingerprint, and every record of T, those already stamped toward the old fingerprint included, ends carrying the new one. Nothing is left
 * stranded on a fingerprint the space no longer has.
 *
 * ## What was wrong
 *
 * r3's next run superseded the first one, and the records the first had not reached were converted by nobody (B2).
 *
 * The move is made from the run's page hook (`afterPage`), after the first page of three, so the case is deterministic.
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-superseded-run-converts-its-remaining-types-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'superseded';
/** More than two pages of the run's page size (100), so the move lands with records of T still unread. */
const RECORDS = 250;
const MOVED = structuredClone(CONVERT_META);
MOVED.typeSchemas.chrono.event.propertySchemas.place = { type: 'string' };

describe('a superseded run converts its remaining types (real MongoDB)', { skip }, () => {
  let door, run;
  before(async () => {
    door = await openConvertDoor({ name: 'b284superseded', spaces: [S] });
    run = await door.runModule();
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('a fingerprint moved after the first page restarts the run, and every record of T ends on the new fingerprint', async () => {
    await door.seed(S, 'entities', Array.from({ length: RECORDS }, (_, i) => ({
      _id: `p-${String(i).padStart(4, '0')}`, name: `P${i}`, type: 'person', properties: { age: i },
    })));
    const firstFp = door.fp(S);
    let pages = 0;
    const afterPage = async () => {
      pages++;
      if (pages === 1) door.setMeta(S, MOVED);
    };
    const started = await run.startSchemaConvertRun({ spaceId: S, types: [{ kind: 'entity', type: 'person' }], steps: [], source: { kind: 'act' } },
      { afterPage });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await waitForValue(async () => { const d = await door.runDoc(S); return d?.state === 'complete' ? d : null; },
      30_000, 100, undefined, { what: 'the run to complete' });

    const newFp = door.fp(S);
    assert.notEqual(newFp, firstFp, 'precondition: the schema write moved the fingerprint');
    assert.ok(pages >= 2, 'precondition: the run read more than one page');
    assert.equal(done.toFp, newFp, 'the run was restarted toward the fingerprint the space has now');
    const stranded = await door.coll(S, 'entities').countDocuments({ type: 'person', schemaFingerprint: { $ne: newFp } });
    assert.equal(stranded, 0, `${stranded} record(s) of T were left on another fingerprint`);
  });
});
