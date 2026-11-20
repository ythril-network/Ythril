/**
 * What the RDF import keeps on disk, and what its status door says of it (bundle-270, second review F8, F9 and F12).
 *
 * ## What it holds
 *
 * - F8: the start's sweep never removes the folder of an upload a door is still reading or has just received (a client that re-sends its
 *   upload right after a restart): the folders it removes are the ones no standing import names AND no door holds.
 * - F9: a report past its keep window is not served; the reports of a space go with the space when it is deleted.
 * - F12: the status door never says "running" for an import no act holds (a door that failed between keeping its report and registering the act).
 *
 * Run: node --test testing/standalone/an-rdf-import-keeps-its-files-and-reports-honestly-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, goodTurtle } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const until = (what, fn, ms = 30_000) => waitFor(fn, ms, 50, undefined, { what });
const SWEEP = 'rdfimpf8';
const OLD = 'rdfimpf9old';
const GONE = 'rdfimpf9gone';
const CRASH = 'rdfimpf12';
const SPACES = [SWEEP, OLD, GONE, CRASH];
const DAY = 24 * 60 * 60 * 1000;

describe('the RDF import keeps its files and reports honestly (real routes, real MongoDB)', { skip, timeout: 240_000 }, () => {
  let d, writer, act, runner, lifecycle;
  const root = () => path.join(d.loader.getDataRoot(), 'rdf-import');
  const reports = () => path.join(d.loader.getDataRoot(), 'rdf-import-reports');
  const listed = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_files', spaces: SPACES.map(id => ({ id, meta: personMeta(id, 'warn') })) });
    writer = await d.mint('rdf-import-files-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); runner?.setSpaceActKnobsForTest?.(null); await d?.close(); });

  it('F8: the start\'s sweep leaves the folder of an upload a door holds', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    let reachedIt;
    const reached = new Promise(r => { reachedIt = r; });
    act.setRdfImportKnobsForTest({ hooks: { beforeRegister: () => { reachedIt(); return gate; } } });
    // A report past its keep window: the sweep's last step, so its removal says the sweep has ended.
    fs.mkdirSync(reports(), { recursive: true });
    const stale = path.join(reports(), 'a-stale-report.spool');
    fs.writeFileSync(stale, 'x');
    fs.utimesSync(stale, new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));
    const answer = d.importRest(writer.key, SWEEP, goodTurtle(SWEEP));
    try {
      await reached;
      assert.equal(listed(root()).length, 1, 'the door holds one folder');
      const [held] = listed(root());
      const files = listed(path.join(root(), held)).sort();
      assert.ok(files.length > 0, 'the door has written its sorted file');
      await runner.resumeSpaceActs();
      await until('the sweep to end', () => !fs.existsSync(stale));
      assert.deepEqual(listed(root()), [held], 'the folder of the upload the door holds is still there');
      assert.deepEqual(listed(path.join(root(), held)).sort(), files, 'with every file the door wrote');
    } finally {
      release();
      act.setRdfImportKnobsForTest(null);
    }
    const r = await answer;
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual((await d.records(SWEEP, 'entities')).map(e => e.name).sort(), ['Alice', 'Bob']);
  });

  it('F9: a report past its keep window is not served', async () => {
    const r = await d.importRest(writer.key, OLD, goodTurtle(OLD));
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const id = r.body.importId;
    assert.equal((await d.statusRest(writer.key, OLD, id)).status, 200, 'served while it is young');
    const file = path.join(reports(), `${id}.spool`);
    fs.utimesSync(file, new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));
    const aged = await d.statusRest(writer.key, OLD, id);
    assert.equal(aged.status, 404, `a report older than its keep window is answered as one that does not exist: ${aged.text.slice(0, 200)}`);
    assert.equal((await d.statusMcp(writer.key, { space: OLD, importId: id })).isError, true, 'the tool answers alike');
  });

  it('F9: the reports of a space go with the space', async () => {
    const r = await d.importRest(writer.key, GONE, goodTurtle(GONE));
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const file = path.join(reports(), `${r.body.importId}.spool`);
    assert.ok(fs.existsSync(file), 'the report is kept');
    await lifecycle.removeSpace(GONE);
    assert.equal(fs.existsSync(file), false, 'the deleted space\'s report is gone with it');
  });

  it('F12: the status door never says running for an import no act holds', async () => {
    const before = new Set(listed(reports()));
    act.setRdfImportKnobsForTest({ hooks: { beforeRegister: () => { throw new Error('planted: the door fails after keeping its report'); } } });
    let r;
    try { r = await d.importRest(writer.key, CRASH, goodTurtle(CRASH)); } finally { act.setRdfImportKnobsForTest(null); }
    assert.ok(r.status >= 500, `the door failed: ${r.status} ${r.text.slice(0, 200)}`);
    assert.deepEqual(d.actsOf(CRASH), [], 'no act holds it');
    const made = listed(reports()).filter(n => !before.has(n));
    assert.equal(made.length, 1, 'the door kept one report before it failed');
    const status = await d.statusRest(writer.key, CRASH, made[0].replace(/\.spool$/, ''));
    assert.notEqual(status.body?.status, 'running', `an import nobody holds is never reported running: ${status.text.slice(0, 300)}`);
    const tool = await d.statusMcp(writer.key, { space: CRASH, importId: made[0].replace(/\.spool$/, '') });
    assert.doesNotMatch(tool.text, /"status":"running"/, 'the tool answers alike');
  });
});
