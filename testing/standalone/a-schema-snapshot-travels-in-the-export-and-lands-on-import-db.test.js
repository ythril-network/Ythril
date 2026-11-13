/**
 * An admin export carries the schema snapshots its records use, and an import lands them (Q-740, bundle-266; design r2 D6-D8 as r3 E-1 to E-6 amend
 * them). This is the round trip the design calls G2, plus G3: the keys the export writes are the keys the documentation's example shows.
 *
 * ## The rules
 *
 *  1. **The export holds what its records need.** A top-level array `schemaSnapshots` after the family arrays: every row whose fingerprint an exported
 *     record carries, plus every row those rows link, transitively; nothing else. Each element is `{ fp, text, links }` and nothing more: origin,
 *     networkId and from name peers and networks, in a file that leaves the instance (security S4).
 *  2. **An element no importer could read is left out and counted.** Over `MAX_DOCUMENT_BYTES` minus 64 KiB it is not written; the export's audit row
 *     says `schemaSnapshotsOmitted` beside `schemaSnapshots`, and one warn line names the space and the fingerprint prefix.
 *  3. **An import lands every element as `fetched`**, from the envelope's `instanceId` when that is an instance-id-shaped string (security S2), with the
 *     links as sent; the envelope is no authority over origin (12-admin-api.md :209-214).
 *  4. **A refused element is skipped and counted; the records land anyway.** The answer says `schemaSnapshots: { landed, held, refused }`, the metric
 *     counts `imported` and `import_refused`.
 *  5. **Unknown keys are named in the answer**, the first ten, through `peerText`, with `unknownKeysTotal`; the audit row carries counts only
 *     (`snapshotsLanded`, `snapshotsRefused`, `unknownKeysTotal`), never a name.
 *  6. **A queued (202) import's counts reach its completion row.**
 *  7. **G3: the keys the export route writes equal the keys of the export example in docs/integration-guide/12-admin-api.md.** The documentation is what
 *     an integrator reads to restore; a key it does not show is one nobody knows to keep.
 *
 * ## The masking channels are held off
 *
 * The space's snapshot rows are cleared and `forgetHeld(space)` run before every import (testing lens S2): `ensureSnapshot` returns early on a fingerprint
 * known held, so a row the export's own seeding left in the cache would read as landed without a write. This door runs no housekeeping timer and the
 * space is shared with no member, so neither the cycle nor the fetch writes a row; no case makes a stamping write, so the backstop does not either.
 * Every assertion about a landed row reads it from Mongo.
 *
 * ## Seen red at 82208a6b
 *
 * The export writes no `schemaSnapshots` key and the import's answer has no `schemaSnapshots` or `unknownKeys`: every case of rules 1-6 fails on that.
 * G3 is green at the base (the example and the route agree on eleven keys); it was seen red on a planted key in the example (the bundle's Work-Log).
 *
 * Run: a Mongo the harness accepts, `npm run build -w @ythril/server`, then
 * node --test testing/standalone/a-schema-snapshot-travels-in-the-export-and-lands-on-import-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openImportDoor } from './_import-door.mjs';
import { auditRowsOf, metricSample, deferred, resetRunnerForTest, untilRunnerIdle, clearActEntries } from './_space-act-harness.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { clone } from './_schema-fingerprint.mjs';
import { REPO_ROOT } from './_sources.mjs';

const skip = await mongoSkipReason();
const SPACE = 'trip';
const T = { timeout: 120_000 };
const HEADROOM = 64 * 1024;

const META_A = { typeSchemas: { entity: { thing: { propertySchemas: { a: { type: 'string' } } } } } };
const META_B = { typeSchemas: { entity: { thing: { propertySchemas: { b: { type: 'string' } } } } } };
const META_C = { typeSchemas: { entity: { thing: { propertySchemas: { c: { type: 'string' } } } } } };
const META_U = { typeSchemas: { entity: { thing: { propertySchemas: { u: { type: 'string' } } } } } };

let door, stampMod, runner, maxDocumentBytes;
let A, B, C, U;

const snaps = () => door.coll(SPACE, 'schema_snapshots');
const stampOf = (meta) => { door.loader.getConfig().spaces.find(s => s.id === 'probe').meta = clone(meta); return stampMod.readMetaForWrite('probe').stamp; };
const fact = (id, fp) => ({ _id: id, spaceId: SPACE, fact: `fact ${id}`, tags: [], seq: 1, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
  author: { instanceId: 'origin', instanceLabel: 'Origin' }, ...(fp ? { [stampMod.SCHEMA_FINGERPRINT_FIELD]: fp } : {}) });
const elementsOf = (body) => body?.schemaSnapshots;
const fpsOf = (body) => (elementsOf(body) ?? []).map(e => e.fp).sort();

/** The space as an import finds it: no record, no snapshot row, nothing known held. */
async function emptySpace() {
  await door.wipe(SPACE);
  await snaps().deleteMany({});
  stampMod.forgetHeld(SPACE);
}

/** A carries the fact `f-a` and links B; C is carried by `f-c` and links nothing; U is held and nothing uses it. */
async function seedSpace() {
  await emptySpace();
  await snaps().insertMany([
    { _id: A.fp, text: A.text, origin: 'own', links: { own: B.fp, layers: [], served: [] }, at: '2026-06-01T00:00:00.000Z' },
    { _id: B.fp, text: B.text, origin: 'layer', networkId: 'net-elsewhere', links: null, at: '2026-06-01T00:00:00.000Z' },
    { _id: C.fp, text: C.text, origin: 'fetched', from: 'peer-somewhere', links: null, at: '2026-06-01T00:00:00.000Z' },
    { _id: U.fp, text: U.text, origin: 'own', links: null, at: '2026-06-01T00:00:00.000Z' },
  ]);
  await door.coll(SPACE, 'facts').insertMany([fact('f-a', A.fp), fact('f-c', C.fp), fact('f-plain')]);
}

async function exported() {
  const r = await door.exportSpace(SPACE);
  assert.equal(r.status, 200, `export answered ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json;
}

/** Import `body` into the emptied space; the answer, parsed. */
async function importBody(body) {
  await emptySpace();
  const r = await door.post(SPACE, typeof body === 'string' ? body : JSON.stringify(body));
  assert.equal(r.status, 200, `import answered ${r.status}: ${r.text?.slice(0, 300)}`);
  return r.json;
}
const lastAuditRow = async (operation) => (await auditRowsOf(door.mongo, operation)).sort((x, y) => String(x.timestamp ?? x._id).localeCompare(String(y.timestamp ?? y._id))).at(-1);
const changeOf = (row, field) => (row?.changes ?? []).find(c => c.field === field)?.to;

describe('a schema snapshot travels in the export and lands on import (real MongoDB, real routes)', { skip }, () => {
  before(async () => {
    door = await openImportDoor({ suite: 'b266trip', spaces: [{ id: SPACE, label: 'Trip', folders: [] }, { id: 'probe', label: 'probe', folders: [] }] });
    stampMod = await import('../../server/dist/spaces/schema-stamp.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    ({ MAX_DOCUMENT_BYTES: maxDocumentBytes } = await import('../../server/dist/sync/export-stream.js'));
    [A, B, C, U] = [META_A, META_B, META_C, META_U].map(stampOf);
  });
  beforeEach(async () => { resetRunnerForTest(runner); clearActEntries(door.loader); await seedSpace(); });
  after(async () => { try { resetRunnerForTest(runner); } catch { /* never loaded */ } await door?.close(); });

  describe('the export', () => {
    it('holds every row a record carries and every row those link, and no other; each element is {fp, text, links}', T, async () => {
      const body = await exported();
      assert.ok(Array.isArray(elementsOf(body)), `the export has no schemaSnapshots array: keys ${Object.keys(body ?? {}).join(', ')}`);
      assert.deepEqual(fpsOf(body), [A.fp, B.fp, C.fp].sort(), 'the export does not hold exactly the carried rows and the rows they link');
      const keys = [...new Set(elementsOf(body).flatMap(e => Object.keys(e)))].sort();
      assert.deepEqual(keys, ['fp', 'links', 'text'], 'an element carries more than its text and links: origin, networkId and from name peers and networks');
      const a = elementsOf(body).find(e => e.fp === A.fp);
      assert.equal(a.text, A.text);
      assert.deepEqual(a.links, { own: B.fp, layers: [], served: [] });
      assert.equal(Object.keys(body).at(-1), 'schemaSnapshots', 'schemaSnapshots is not after the family arrays');
    });

    it('leaves out an element over the limit every importer takes, counts it in the audit row and names it in one warn line', T, async () => {
      const bigFp = 'e'.repeat(64);
      const bytes = maxDocumentBytes - HEADROOM / 2;
      await snaps().insertOne({ _id: bigFp, text: 'x'.repeat(bytes), origin: 'own', links: null, at: '2026-06-01T00:00:00.000Z' });
      await door.coll(SPACE, 'facts').insertOne(fact('f-big', bigFp));
      const { lines, result: body } = await logLinesDuring(() => exported());
      assert.ok(Array.isArray(elementsOf(body)), `the export has no schemaSnapshots array: keys ${Object.keys(body ?? {}).join(', ')}`);
      assert.equal(fpsOf(body).includes(bigFp), false, 'an element no released importer can read was exported: the whole body would be refused');
      assert.deepEqual(fpsOf(body), [A.fp, B.fp, C.fp].sort(), 'leaving one out changed what else the export holds');
      const row = await lastAuditRow('space.export');
      assert.equal(changeOf(row, 'schemaSnapshotsOmitted'), 1, `the export's audit row does not count the omitted element: ${JSON.stringify(row?.changes)}`);
      assert.equal(changeOf(row, 'schemaSnapshots'), 3, `the export's audit row does not count the exported elements: ${JSON.stringify(row?.changes)}`);
      const said = lines.filter(l => l.includes(bigFp.slice(0, 12)) && l.includes(SPACE));
      assert.equal(said.length, 1, `want one warn line naming the space and the fingerprint prefix: ${JSON.stringify(lines.slice(-5))}`);
    });

    it('G3: the keys the export writes are the keys of the export example in 12-admin-api.md', T, async () => {
      const body = await exported();
      const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'integration-guide', '12-admin-api.md'), 'utf8');
      const at = doc.indexOf('GET /api/admin/spaces/:spaceId/export');
      assert.ok(at >= 0, 'the export section is gone from 12-admin-api.md');
      const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(doc.slice(at));
      assert.ok(block, 'the export section has no json example');
      const documented = Object.keys(JSON.parse(block[1])).sort();
      assert.deepEqual(Object.keys(body).sort(), documented, 'the export writes a key its documented example does not show, or the example shows one it does not write');
    });
  });

  describe('the import', () => {
    it('lands every exported element as fetched, from the envelope\'s instance, links as sent, counted in the answer, the audit row and the metric', T, async () => {
      const body = await exported();
      assert.ok(Array.isArray(elementsOf(body)), 'fixture: the export carries no snapshots to import');
      const before = await metricSample('ythril_schema_snapshot_total', { outcome: 'imported' });
      const answer = await importBody(body);
      assert.deepEqual(answer.schemaSnapshots, { landed: 3, held: 0, refused: 0 }, `the answer does not say what the import did with the snapshots: ${JSON.stringify(answer)}`);
      const rows = await snaps().find({}).sort({ _id: 1 }).toArray();
      assert.deepEqual(rows.map(r => r._id), [A.fp, B.fp, C.fp].sort());
      for (const r of rows) {
        assert.equal(r.origin, 'fetched', `${r._id.slice(0, 12)} landed as ${r.origin}: the envelope is no authority over origin`);
        assert.equal(r.from, door.instanceId(), `${r._id.slice(0, 12)} does not name the instance the envelope names`);
        assert.equal(r.networkId, undefined);
      }
      assert.deepEqual(rows.find(r => r._id === A.fp).links, { own: B.fp, layers: [], served: [] });
      assert.equal(rows.find(r => r._id === A.fp).text, A.text);
      assert.ok(await door.coll(SPACE, 'facts').findOne({ _id: 'f-a' }), 'the records did not land');
      assert.equal(await metricSample('ythril_schema_snapshot_total', { outcome: 'imported' }) - before, 3, 'imported rows are not counted as imported');
      const row = await lastAuditRow('space.import');
      assert.deepEqual([changeOf(row, 'snapshotsLanded'), changeOf(row, 'snapshotsRefused'), changeOf(row, 'unknownKeysTotal')], [3, 0, 0],
        `the import's audit row does not carry the snapshot counts: ${JSON.stringify(row?.changes)}`);
    });

    it('names no sender when the envelope\'s instanceId is not an instance id', T, async () => {
      for (const bad of [{ evil: true }, 'two\nlines', 'x'.repeat(400)]) {
        const body = { ...(await exported()), instanceId: bad };
        assert.ok(Array.isArray(elementsOf(body)), 'the export carries no snapshots to import');
        await importBody(body);
        const rows = await snaps().find({}).toArray();
        assert.ok(rows.length > 0, 'fixture: nothing landed');
        assert.deepEqual(rows.filter(r => 'from' in r).map(r => r.from), [], `an envelope instanceId of ${JSON.stringify(bad).slice(0, 40)} was kept as the sender`);
        await seedSpace();
      }
    });

    it('skips and counts an element whose text is not the one its fingerprint names; the records and the other elements land', T, async () => {
      const body = await exported();
      assert.ok(Array.isArray(elementsOf(body)), 'fixture: the export carries no snapshots');
      body.schemaSnapshots = body.schemaSnapshots.map(e => (e.fp === C.fp ? { ...e, text: `${e.text} ` } : e));
      const before = await metricSample('ythril_schema_snapshot_total', { outcome: 'import_refused' });
      const answer = await importBody(body);
      assert.deepEqual(answer.schemaSnapshots, { landed: 2, held: 0, refused: 1 }, `the answer does not count the refused element: ${JSON.stringify(answer?.schemaSnapshots)}`);
      assert.equal(await snaps().findOne({ _id: C.fp }), null, 'a text that is not the fingerprint\'s was landed');
      assert.ok(await door.coll(SPACE, 'facts').findOne({ _id: 'f-c' }), 'a refused snapshot kept its record from landing');
      assert.equal(await metricSample('ythril_schema_snapshot_total', { outcome: 'import_refused' }) - before, 1);
      const row = await lastAuditRow('space.import');
      assert.equal(changeOf(row, 'snapshotsRefused'), 1, `the audit row does not count the refusal: ${JSON.stringify(row?.changes)}`);
    });

    it('names the first ten unknown keys in the answer, through peerText, with their total; the audit row has the total and no name', T, async () => {
      const body = await exported();
      const keys = [...Array.from({ length: 10 }, (_, i) => `future${i}`), 'line\nbreak'];
      const text = JSON.stringify(body).replace(/}$/, `,${keys.map(k => `${JSON.stringify(k)}:[]`).join(',')}}`);
      const answer = await importBody(text);
      assert.equal(answer.unknownKeysTotal, 11, `the answer does not say how many keys were not read: ${JSON.stringify(answer)}`);
      assert.ok(Array.isArray(answer.unknownKeys) && answer.unknownKeys.length === 10, `the answer does not name the first ten: ${JSON.stringify(answer.unknownKeys)}`);
      assert.deepEqual(answer.unknownKeys, keys.slice(0, 10));
      const row = await lastAuditRow('space.import');
      assert.equal(changeOf(row, 'unknownKeysTotal'), 11);
      assert.equal(JSON.stringify(row).includes('future0'), false, 'the audit row names a key: it is counts only');
      const late = await importBody(JSON.stringify(body).replace(/}$/, ',"line\\nbreak":[]}'));
      assert.equal(late.unknownKeys.some(k => /[\r\n]/.test(k)), false, `a key name reached the answer with its line break: ${JSON.stringify(late.unknownKeys)}`);
    });

    it('a queued import (202) carries its snapshot counts to its completion row', T, async () => {
      const body = await exported();
      await emptySpace();
      runner.setSpaceActKnobsForTest({ SPACE_ACT_ANSWER_MS: 25 });
      const hold = deferred();
      runner.setSpaceActHooksForTest({ afterDrain: async (e) => { if (e.kind === 'import') { hold.arrive(); await hold.promise; } } });
      const answered = door.post(SPACE, JSON.stringify(body));
      await hold.reached;
      const r = await answered;
      assert.equal(r.status, 202, `the door did not answer queued: ${r.status} ${r.text?.slice(0, 200)}`);
      hold.release();
      await untilRunnerIdle(runner, door.loader);
      const rows = (await auditRowsOf(door.mongo, 'space.act_completed')).filter(x => String(x.path).startsWith('internal:space-act:import:'));
      const own = rows.at(-1);
      assert.equal(changeOf(own, 'snapshotsLanded'), 3, `the completion row of a queued import does not count its snapshots: ${JSON.stringify(own?.changes)}`);
    });
  });
});
