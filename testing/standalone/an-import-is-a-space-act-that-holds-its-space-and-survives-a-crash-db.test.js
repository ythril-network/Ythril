/**
 * An import is a space act: while it stands its space refuses a local write and a second import, a crash before its completion is resumed from
 * the spool it kept, a spool that is gone completes the act as failed, and a spool no act names is swept at boot (bundle-40 slice b, `Q-267`;
 * plan 2R R1 as amended by 2R3).
 *
 * ## The rules this file holds
 *
 *  1. **While an import act stands, `space_being_imported` refuses a local write (409) and a second import (409).** The import is registered as
 *     an act of kind `import` (the runner's own list, `SPACE_ACT_KINDS`), so the write gate that closes a space for a wipe closes it for this.
 *  2. **A crash before the completion leaves the act on disk and its spool in `<data root>/import-spool/`; the resume re-runs the import FROM THE
 *     SPOOL** (the rows the first run landed are removed before the resume, so only a re-run from the body can bring them back, with the same
 *     ids and seqs), and the act and its spool are gone when it completes.
 *  3. **A resumed act whose spool is missing completes as failed and removes itself**, with the runner's completion row (`space.act_completed`,
 *     path `internal:space-act:import:...`), and lands nothing: its input was validated before it was registered, so no abandon door is owed.
 *  4. **A spool no standing act names is swept by the boot's `resumeSpaceActs`**, and the spool a standing act does name is kept.
 *  5. **A resumed act whose spool can no longer be read completes as failed (422) with its row and removes itself and its spool** (bundle-40
 *     pre-ship R1): a spool written through the master secret that is read with the secret removed, and a spool corrupted on disk. Red on
 *     505b5790c: the read threw an ordinary error, the runner retried it for ever, and the space stayed held.
 *  6. **Two imports sent at once: one is let in, the other is answered 409 `space_being_imported`** (pre-ship R2). Red on 505b5790c: the
 *     one-at-a-time check ran before the body was spooled, so both doors spooled, both registered and both landed.
 *
 * ## How it is driven
 *
 * The runner's own seams (`setSpaceActHooksForTest`: `afterDrain` parks the act, `beforeComplete` throwing is the crash), the restart the in-process
 * boot can do (flush the config, reopen the runner, reload, resume: as `a-restore-resumes-after-a-crash-and-a-failure-stays-owed-db`), the real
 * import route over HTTP (`_import-door.mjs`). Nothing is ordered by a sleep: a latch and the runner's idle wait.
 *
 * ## Seen red
 *
 * On 6c64a7112 the import is inline in the request: no act of kind `import` ever stands, so every rule below fails at "no import act".
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/an-import-is-a-space-act-that-holds-its-space-and-survives-a-crash-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { ADMIN_TOKEN, build } from './_push-door.mjs';
import { openImportDoor, exportText, fact, idsOf, paddedFacts } from './_import-door.mjs';
import { clearActEntries, deferred, resetRunnerForTest, untilRunnerIdle, auditRowsOf } from './_space-act-harness.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();
const SPACE = 'importact';
const T = { timeout: 90_000 };
const DAY = 86_400_000;
const IDS = ['act-1', 'act-2', 'act-3'];
const BODY = () => exportText({ facts: IDS.map((id, i) => fact(id, 10 + i)) });

let door, runner, writers;

const rowsOf = async () => (await door.coll(SPACE, 'facts').find({}).sort({ _id: 1 }).toArray()).map(d => ({ _id: d._id, seq: d.seq, fact: d.fact }));
const restart = async () => { await door.loader.flushConfig(); runner.reopenSpaceActsForTest(); door.loader.loadConfig(); };

/** An import whose completion crashes: the act stays on disk with its spool, and the route's answer is whatever the door says of it. */
async function crashedImport() {
  runner.setSpaceActHooksForTest({ beforeComplete: (e) => { if (e.kind === 'import') throw new Error('crash before the completion'); } });
  try { await door.post(SPACE, BODY()); } finally { runner.setSpaceActHooksForTest(null); }
  assert.equal(door.importActs().length, 1, 'the crashed import left no act on disk: nothing says an import is owed');
}

describe('an import is a space act: it holds its space, resumes from its spool and sweeps what no act names (real MongoDB, real route)', { skip }, () => {
  before(async () => {
    door = await openImportDoor({ suite: 'importact', spaces: [{ id: SPACE, label: 'Act', folders: [] }] });
    runner = await import('../../server/dist/spaces/space-act-runner.js');
    writers = { fact: await import('../../server/dist/brain/fact.js') };
  });
  after(async () => { try { resetRunnerForTest(runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(async () => {
    resetRunnerForTest(runner);
    clearActEntries(door.loader);
    await door.wipe(SPACE);
    fs.rmSync(door.spoolDir, { recursive: true, force: true });
  });

  it('while an import act stands, a local write and a second import are refused with space_being_imported (409)', T, async () => {
    const parked = deferred();
    runner.setSpaceActHooksForTest({ afterDrain: async (e) => { if (e.kind === 'import') { parked.arrive(); await parked.promise; } } });
    const first = door.post(SPACE, BODY());
    const seen = await Promise.race([parked.reached.then(() => 'parked'), first.then(r => `answered ${r.status} before any import act stood`)]);
    try {
      assert.equal(seen, 'parked', `the import never stood as an act: ${seen}`);
      assert.equal(door.importActs().length, 1, 'a parked import is not an act of kind import on disk');
      const write = await writers.fact.saveFact(SPACE, 'a local write while the import stands', [], [], undefined, undefined, 'note').then(() => null, e => e);
      assert.ok(write, 'a space whose import stands took a local write');
      assert.equal(write.code, 'space_being_imported', `the write was refused with ${write.code}: ${write.message}`);
      const push = await door.push('/batch-upsert', { facts: [build.fact(SPACE, 'cccccccc-0000-4000-8000-0000000c0aaa', 1)] }, { spaceId: SPACE, token: ADMIN_TOKEN });
      assert.deepEqual([push.code, push.body?.code], [409, 'space_being_imported'], `an admin push was answered ${push.code}: ${JSON.stringify(push.body)}`);
      const second = await door.post(SPACE, exportText({ facts: [fact('second-import', 1)] }));
      assert.equal(second.status, 409, `a second import was answered ${second.status}: ${second.text.slice(0, 160)}`);
      assert.equal(second.json?.code, 'space_being_imported', `the second import's code is ${JSON.stringify(second.json?.code)}`);
    } finally {
      parked.release();
      runner.setSpaceActHooksForTest(null);
      await first;
    }
    await untilRunnerIdle(runner, door.loader);
    assert.deepEqual(await idsOf(door, SPACE), IDS, 'the second import or the refused writes changed what the first import landed');
  });

  it('a crash before the completion: the act and its spool stand, and the resume re-runs the import from the spool', T, async () => {
    await crashedImport();
    assert.equal(door.spoolFiles().length, 1, `a standing import act has no spool: ${JSON.stringify(door.spoolFiles())}`);
    const landed = await rowsOf();
    assert.deepEqual(landed.map(r => r._id), IDS, 'fixture check: the first run did not land the rows before it crashed');
    // The rows are removed, so only a re-run from the spooled body can bring them back.
    await door.coll(SPACE, 'facts').deleteMany({});
    const actId = door.importActs()[0].id;
    await restart();
    const later = Date.now() + DAY;
    await runner.resumeSpaceActs(later);
    await untilRunnerIdle(runner, door.loader, { now: later });
    assert.deepEqual(door.importActs(), [], 'the resume did not complete the crashed import');
    assert.deepEqual(await rowsOf(), landed, 'the resumed import did not land the same rows from its spool');
    assert.deepEqual(door.spoolFiles(), [], 'a completed import left its spool on disk');
    // Nobody waited for this import, so its completion row is the only place its result is told: it carries the import's totals.
    const own = (await auditRowsOf(door.mongo, 'space.act_completed')).filter(r => String(r.path).includes(actId));
    assert.equal(own.length, 1, `want one completion row for the resumed import ${actId}: ${JSON.stringify(own.map(r => r.path))}`);
    const inserted = (own[0].changes ?? []).find(c => c.field === 'inserted');
    assert.equal(inserted?.to, IDS.length, `the resumed import's completion row does not say how many records it stored: ${JSON.stringify(own[0].changes)}`);
  });

  it('a resumed act whose spool is missing completes as failed with its audit row, lands nothing and removes itself', T, async () => {
    await crashedImport();
    await door.coll(SPACE, 'facts').deleteMany({});
    for (const f of door.spoolFiles()) fs.rmSync(path.join(door.spoolDir, f), { force: true });
    const actId = door.importActs()[0].id;
    await restart();
    const later = Date.now() + DAY;
    const { lines } = await logLinesDuring(() => runner.resumeSpaceActs(later));
    await untilRunnerIdle(runner, door.loader, { now: later });
    assert.deepEqual(door.importActs(), [], 'an import act whose spool is gone stays on disk: it can never complete and nothing abandons it');
    // The act ended: the resume's walk does not report it as a failure "retried next cycle" (CI run 41329371938 said so).
    const retried = lines.filter(l => l.includes('Resume of space acts failed'));
    assert.deepEqual(retried, [], `the resume reported an act that ended as a failure it retries: ${JSON.stringify(retried)}`);
    assert.deepEqual(await idsOf(door, SPACE), [], 'an import with no spool landed rows');
    const rows = (await auditRowsOf(door.mongo, 'space.act_completed')).filter(r => String(r.path).startsWith('internal:space-act:import:'));
    assert.ok(rows.some(r => String(r.path).includes(actId)), `no completion row names the import act ${actId}: ${JSON.stringify(rows.map(r => r.path))}`);
    // It was failed, not completed: the row says so by its status. Only THIS act's rows: the audit log of the file's database also holds the
    // successful completion of the resumed import the test before this one ran.
    const own = rows.filter(r => String(r.path).includes(actId));
    assert.ok(own.every(r => typeof r.status === 'number' && r.status >= 400), `the completion row of an import with no spool reads as a success: ${JSON.stringify(own.map(r => [r.path, r.status]))}`);
  });

  describe('a resumed act whose spool can no longer be read completes as failed (422), lands nothing and removes itself and its spool', () => {
    const unreadable = {
      'written through a master secret that is now removed': async (file) => {
        // The door writes the spool through the chunked envelope when a secret is configured; the secret is gone at the resume.
        const box = await import('../../server/dist/config/secretbox.js');
        const enc = box.createChunkedEncryptor(box.deriveKey({ kind: 'key', key: Buffer.alloc(32, 9) }));
        const sealed = await new Promise((resolve, reject) => {
          const parts = [];
          enc.on('data', c => parts.push(c)); enc.on('end', () => resolve(Buffer.concat(parts))); enc.on('error', reject);
          enc.end(fs.readFileSync(file));
        });
        fs.writeFileSync(file, sealed);
      },
      'corrupted on disk': async (file) => { fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 40)); },
    };
    for (const [how, spoil] of Object.entries(unreadable)) {
      it(how, T, async () => {
        await crashedImport();
        await door.coll(SPACE, 'facts').deleteMany({});
        const [spool] = door.spoolFiles();
        await spoil(path.join(door.spoolDir, spool));
        const actId = door.importActs()[0].id;
        await restart();
        await runner.resumeSpaceActs(Date.now() + DAY);
        // `now` is the real clock: an act the runner failed and owes again is not due yet, so idle is reached and the act is still read.
        await untilRunnerIdle(runner, door.loader);
        assert.deepEqual(door.importActs().map(e => [e.state, e.lastError]), [], 'an import whose spool cannot be read stays standing: it is retried for ever and its space stays held');
        assert.deepEqual(door.spoolFiles(), [], 'the unreadable spool of a failed import was left on disk');
        assert.deepEqual(await idsOf(door, SPACE), [], 'an import whose spool cannot be read landed rows');
        const own = (await auditRowsOf(door.mongo, 'space.act_completed')).filter(r => String(r.path).includes(actId));
        assert.deepEqual(own.map(r => r.status), [422], `want one completion row with status 422 for ${actId}: ${JSON.stringify(own.map(r => [r.path, r.status]))}`);
      });
    }
  });

  it('two imports sent at once: one is let in, the other is answered 409 space_being_imported', T, async () => {
    // Bodies of about 12 MB each: both doors are past their headers long before either body is spooled and validated.
    const body = (prefix) => exportText({ facts: paddedFacts(3000, 4000, { idPrefix: prefix }) });
    const [a, b] = await Promise.all([door.post(SPACE, body('one')), door.post(SPACE, body('two'))]);
    await untilRunnerIdle(runner, door.loader);
    const statuses = [a.status, b.status].sort();
    const refused = [a, b].find(r => r.status === 409);
    assert.ok(refused, `two concurrent imports were answered ${JSON.stringify(statuses)}: both were let in`);
    assert.equal(refused.json?.code, 'space_being_imported', `the refused import's code is ${JSON.stringify(refused.json?.code)}`);
    const taken = [a, b].find(r => r !== refused);
    assert.ok(taken.status === 200 || taken.status === 202, `the import that was let in was answered ${taken.status}: ${taken.text.slice(0, 160)}`);
    const prefixes = new Set((await idsOf(door, SPACE)).map(id => id.split('-')[0]));
    assert.deepEqual([...prefixes], [taken === a ? 'one' : 'two'], `the space holds the records of ${JSON.stringify([...prefixes])}, not only those of the import let in`);
    assert.deepEqual(door.spoolFiles(), [], 'a spool was left behind');
  });

  it('a spool no act names is swept at boot, and the spool a standing act names is kept', T, async () => {
    await crashedImport();
    const kept = door.spoolFiles();
    assert.equal(kept.length, 1, 'fixture check: the standing act has no single spool');
    const orphan = path.join(door.spoolDir, 'orphan-0000.json');
    fs.writeFileSync(orphan, '{"facts":[]}');
    await restart();
    // `now` is before the owed act's retry: the act is NOT due, so the only work the boot call can do is the sweep.
    await runner.resumeSpaceActs(Date.now());
    assert.equal(fs.existsSync(orphan), false, 'a spool no standing act names was not swept at boot');
    assert.deepEqual(door.spoolFiles(), kept, 'the sweep removed the spool a standing act still names');
  });
});
