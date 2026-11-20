/**
 * A space's RDF import reports and import folders follow it through a rename: a space created later under the old id reads none of them
 * (bundle-270, lens finding L4).
 *
 * ## What it holds
 *
 * An import's report (kept seven days, naming the subject addresses of its records) and the folder of a standing import are files under the data
 * root keyed by import id, with the space's id inside. A rename moves the space's other files (`files/<id>`, `.chunks/<id>`) and every reference
 * to it, but not these: they stayed under the old id, which a space created afterwards can take, and its writers read them through the status door.
 * They are the renamed space's own history, so they follow it (the same rule as the files directory), by rewriting the id inside them, in the one
 * step the rename already takes, so a resumed rename does it too.
 *
 * - after the rename the report is read under the NEW id by its import id, and a space created under the OLD id answers 404 for it;
 * - the report keeps its age (the keep window does not restart), and a standing import's folder names the new id;
 * - no report or folder file names the old id any more;
 * - a report of another space is untouched.
 *
 * Run: node --test testing/standalone/an-rdf-import-follows-its-space-through-a-rename-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, personMeta, goodTurtle } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const OLD = 'rdfrenold';
const NEW = 'rdfrennew';
const OTHER = 'rdfrenother';
const DAY = 24 * 60 * 60 * 1000;

describe('an RDF import follows its space through a rename (real routes, real MongoDB)', { skip, timeout: 240_000 }, () => {
  let d, files, lifecycle, rename, spool, writer;
  const reports = () => path.join(d.loader.getDataRoot(), 'rdf-import-reports');
  const reportFile = (id) => path.join(reports(), `${id}.spool`);

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_rename', spaces: [OLD, OTHER].map(id => ({ id, meta: personMeta(id, 'warn') })) });
    writer = await d.mint('rdf-import-rename-writer', Object.fromEntries([OLD, OTHER].map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    files = await import('../../server/dist/spaces/rdf-import-files.js');
    spool = await import('../../server/dist/rdf/import-spool.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    rename = await import('../../server/dist/spaces/rename.js');
  });
  after(async () => { await d?.close(); });

  it('the report and the folder go to the new id, and a space created under the old id reads neither', async () => {
    const made = await d.importRest(writer.key, OLD, goodTurtle(OLD));
    assert.equal(made.status, 200, made.text.slice(0, 300));
    const importId = made.body.importId;
    const other = await d.importRest(writer.key, OTHER, goodTurtle(OTHER));
    assert.equal(other.status, 200, other.text.slice(0, 300));
    // The report is three days old: the rename must not make it young again.
    const aged = new Date(Date.now() - 3 * DAY);
    fs.utimesSync(reportFile(importId), aged, aged);
    // A standing import's folder, as a door leaves it.
    const standingId = crypto.randomUUID();
    const dir = files.folderPathOf(standingId);
    await files.writeState(await spool.openImportFolder(dir), {
      importId: standingId, space: OLD, options: { format: 'turtle', mode: 'warn', blankNodes: 'refuse', graphBases: {} }, sortedFile: 'sorted.spool',
      phase: 'received', committed: 0, report: { importId: standingId, space: OLD, status: 'running' },
    });

    await rename.renameSpace(OLD, NEW);

    assert.equal((await d.statusRest(writer.key, NEW, importId)).status, 200, 'the renamed space\'s own report is not read under its new id');
    const state = await files.readState(await spool.openImportFolder(dir));
    assert.equal(state.space, NEW, 'the standing import\'s folder names the old id');
    assert.equal(state.report.space, NEW, 'the report the folder carries names the old id');
    assert.ok(Math.abs(fs.statSync(reportFile(importId)).mtimeMs - aged.getTime()) < 2000, 'the rename restarted the report\'s keep window');

    // A space is created under the old id; its writer reads nothing of the old space's imports.
    await lifecycle.createSpace({ id: OLD, label: OLD }, { tokenId: null });
    const second = await d.mint('rdf-import-rename-second', { [OLD]: d.row({ knowledge: 'write', schema: 'admin' }) });
    const seen = await d.statusRest(second.key, OLD, importId);
    assert.equal(seen.status, 404, `a space created under the old id reads the old space's report: ${seen.text.slice(0, 300)}`);
    assert.equal((await d.statusMcp(second.key, { space: OLD, importId })).isError, true, 'the tool answers alike');

    // Nothing on disk names the old id.
    const named = [];
    const walked = [];
    for (const name of fs.readdirSync(reports())) {
      const report = await files.readReport(name.replace(/\.spool$/, ''), 0).catch(() => null);
      walked.push(report?.space);
      if (report?.space === OLD) named.push(name);
    }
    for (const name of fs.readdirSync(path.join(d.loader.getDataRoot(), 'rdf-import'))) {
      const dirOf = files.folderPathOf(name);
      const st = dirOf ? await files.readState(await spool.openImportFolder(dirOf)).catch(() => null) : null;
      walked.push(st?.space);
      if (st?.space === OLD) named.push(name);
    }
    assert.ok(walked.length >= 3 && walked.includes(NEW) && walked.includes(OTHER), `the walk saw the renamed space's and the other space's files (${JSON.stringify(walked)})`);
    assert.deepEqual(named, [], 'files that name the old id are left');
    assert.equal((await d.statusRest(writer.key, OTHER, other.body.importId)).status, 200, 'another space\'s report was touched');
  });
});
