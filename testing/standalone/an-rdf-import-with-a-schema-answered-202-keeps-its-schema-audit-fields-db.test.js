/**
 * An RDF import with a schema that outlives its door's answer (202) still audits the schema step (bundle-270, Q-955 fix round: finding F5).
 *
 * ## What it holds
 *
 * The completion row of the act (`space.act_completed`, the only place a queued act's result is told) carries the schema step's fingerprints
 * (`schemaFingerprintBefore`, `schemaFingerprintAfter`) and whether it wrote, as the `rdf.import` row of a 200 answer does.
 *
 * Run: node --test testing/standalone/an-rdf-import-with-a-schema-answered-202-keeps-its-schema-audit-fields-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { elapse } from '../_shared/sleep.mjs';
import { openRdfImportSchemaDoors, spaceWith, fileOf } from './_rdf-import-schema-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfisaudit202';

describe('an RDF import with a schema answered 202 keeps its schema audit fields (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, runner;
  before(async () => {
    d = await openRdfImportSchemaDoors({ suite: 'rdf_import_schema_audit202', spaces: [spaceWith(SPACE, undefined, { validationMode: 'strict' })] });
    writer = await d.mint('rdf-import-schema-audit202-writer', { [SPACE]: d.row({ knowledge: 'write', schema: 'write' }) });
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); runner?.setSpaceActKnobsForTest?.(null); await d?.close(); });

  it('F5: the act\'s completion row names the schema\'s fingerprints before and after', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    act.setRdfImportKnobsForTest({ hooks: { beforeCommit: () => gate } });
    runner.setSpaceActKnobsForTest({ SPACE_ACT_ANSWER_MS: 300 });
    const r = await d.importRestOne(writer.key, SPACE, fileOf(), { schema: 'expand' });
    assert.equal(r.status, 202, r.text.slice(0, 300));
    release();
    for (let i = 0; i < 100 && d.actsOf(SPACE).length > 0; i++) await elapse(100, 'pacing: the standing act to complete');
    assert.deepEqual(d.actsOf(SPACE), [], 'the act completed');
    await untilAuditWritesLanded();
    const rows = await d.col('audit_log').find({ operation: 'space.act_completed', spaceId: SPACE }).toArray();
    const row = rows.find(x => (x.changes ?? []).some(c => c.field === 'inserted'));
    assert.ok(row, `the act's completion row: ${JSON.stringify(rows.map(x => x.changes?.map(c => c.field)))}`);
    const field = (f) => row.changes.find(c => c.field === f)?.to;
    assert.match(String(field('schemaFingerprintBefore')), /^[0-9a-f]{64}$/, `the row's fields: ${JSON.stringify(row.changes)}`);
    assert.match(String(field('schemaFingerprintAfter')), /^[0-9a-f]{64}$/);
    assert.equal(field('schemaWritten'), true);
    assert.equal(field('schemaTypesAdded'), 1, `the row's fields: ${JSON.stringify(row.changes)}`);
  });
});
