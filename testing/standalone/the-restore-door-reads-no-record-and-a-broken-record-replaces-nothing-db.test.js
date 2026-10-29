/**
 * `POST /api/admin/data/restore` answers within a bound that does not grow with the backup, and nothing is replaced over a backup
 * with a broken record (Q-565; owner decision D-66, 2026-10-29: "checked whole before anything is replaced" replaces "before anything
 * is registered" in decision 13 section 2).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * The door used to decrypt, parse and count EVERY record of the backup inside the request, so a large backup could outlast a proxy's
 * timeout while the server went on. The door now checks the MANIFEST: it parses, every file it names is present, and the first line of
 * each file decrypts (so a secret that is missing or wrong is still refused at the door). It reads no record. The whole-backup check -
 * every record decrypts and parses, every count is the manifest's - runs once per restore SET, in the first act's body and before any
 * space is replaced, and a backup it finds broken fails EVERY member through the act's own input-failure path with nothing dropped.
 *
 * - a backup whose files are all present but whose LAST record in one space is garbage answers 202 (a door that reads a record cannot
 *   know), every member is owed with `needsAbandon`, and neither space has changed - including the space that sorts BEFORE the broken
 *   one, which a per-space check alone would already have replaced;
 * - a manifest that does not parse, a file it names that is missing, and an encrypted backup with no secret are still `400 backup_not_whole`
 *   at the door, registering nothing (controls: green before and after);
 * - a collection file that is EMPTY while the manifest says it holds records is `400 backup_not_whole` at the door (truncated);
 * - a file-system error while the backup is read (a directory where a collection file should be, EISDIR) is the file system's and not the
 *   backup's: the members are owed WITH a retry time and no `needsAbandon`, nothing is replaced, and the retry completes the restore once
 *   the file is back. It was cached as the backup's verdict, so every member needed an abandon.
 *
 * ## Seen red
 *
 * On ab3bc6365 the garbage-record case answers 400 `backup_not_whole` at the door, because the door reads every record. On 2f584d7f2 the
 * truncated file answers 202 and the directory case leaves every member `needsAbandon` with no retry time.
 *
 * Run: `node --test testing/standalone/the-restore-door-reads-no-record-and-a-broken-record-replaces-nothing-db.test.js` (a Mongo the
 * harness accepts, a prior `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { clearActEntries, resetRunnerForTest, untilRunnerIdle } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, requestRestore, restoreEntries, startRestoreActs, restoreReportBody, spaceRowsOfReport } from './_restore-act.mjs';

const skip = await mongoSkipReason();

const SUITE = 'restoredoor';
const SPACES = ['door-a', 'door-b'];
const T = { timeout: 90_000 };

let door, mods;

const ids = async (space) => (await door.coll(space, 'facts').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();

/** Two facts in each space, a backup, then a third fact in each: what the backup holds, and what is live afterwards. */
async function seedAndBackup(label) {
  for (const space of SPACES) {
    await door.coll(space, 'facts').deleteMany({});
    await door.coll(space, 'facts').insertMany([1, 2].map(n => ({ _id: `${space}-${n}`, spaceId: space, fact: `${space} ${n}`, tags: [], seq: n })));
    await door.setCounter(space, 2);
  }
  const backup = await takeBackup(SUITE, `${label}-${Date.now()}`);
  for (const space of SPACES) {
    await door.coll(space, 'facts').insertOne({ _id: `${space}-3`, spaceId: space, fact: `${space} 3`, tags: [], seq: 3 });
  }
  return { backup, live: Object.fromEntries(SPACES.map(s => [s, [`${s}-1`, `${s}-2`, `${s}-3`]])) };
}

describe('the restore door reads no record, and a broken record replaces nothing (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    mods = await restoreModules();
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(() => { resetRunnerForTest(mods.runner); clearActEntries(mods.loader); });

  it('a backup whose files are all present but whose last record of one space is garbage answers 202, fails every member needing an abandon, and replaces neither space', T, async () => {
    const { backup, live } = await seedAndBackup('garbage');
    const file = path.join(backup.dir, 'door-b_facts.ndjson');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length >= 2, 'the fixture is wrong: the backup must hold at least two facts of door-b');
    fs.writeFileSync(file, [...lines.slice(0, -1), '{ this is not a record'].join('\n') + '\n');

    const answer = await requestRestore(mods.dataRouter, { backupId: backup.id });
    assert.equal(answer.status, 202, `the door answered ${answer.status} for a backup whose files are present: it read a record. ${JSON.stringify(answer.body)}`);
    await Promise.all(startRestoreActs(mods.runner, mods.loader));

    const rows = spaceRowsOfReport(await restoreReportBody(mods.dataRouter));
    for (const space of SPACES) {
      assert.equal(rows[space]?.state, 'owed', `${space} is not owed after the broken record: ${JSON.stringify(rows[space])}`);
      assert.equal(rows[space]?.needsAbandon, true, `${space} is not marked needing an abandon (it would be retried over the same input): ${JSON.stringify(rows[space])}`);
      assert.match(String(rows[space]?.lastError), /door-b_facts/, `${space}'s failure does not name the collection: ${JSON.stringify(rows[space])}`);
    }
    for (const space of SPACES) assert.deepEqual(await ids(space), live[space], `${space} was replaced (or emptied) over a backup with a broken record`);
  });

  it('control: a backup whose manifest names a file it lacks, and one whose manifest does not parse, are still 400 backup_not_whole at the door and register nothing', T, async () => {
    const { backup } = await seedAndBackup('missingfile');
    fs.rmSync(path.join(backup.dir, 'door-a_facts.ndjson'));
    let answer = await requestRestore(mods.dataRouter, { backupId: backup.id });
    assert.equal(answer.status, 400, `a backup lacking a named file was answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body?.code, 'backup_not_whole');
    fs.writeFileSync(path.join(backup.dir, 'manifest.json'), '{ not a manifest');
    answer = await requestRestore(mods.dataRouter, { backupId: backup.id });
    assert.equal(answer.status, 400, `a backup with an unreadable manifest was answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body?.code, 'backup_not_whole');
    assert.deepEqual(restoreEntries(mods.loader), [], 'a refused restore registered acts');
  });

  it('a collection file that is empty while the manifest says it holds records is 400 backup_not_whole at the door, naming the collection and no path, and registers nothing', T, async () => {
    const { backup } = await seedAndBackup('truncated');
    const file = path.join(backup.dir, 'door-b_facts.ndjson');
    assert.ok(fs.readFileSync(file, 'utf8').trim().length > 0, 'the fixture is wrong: the backup holds no facts of door-b');
    fs.writeFileSync(file, '');
    const answer = await requestRestore(mods.dataRouter, { backupId: backup.id });
    assert.equal(answer.status, 400, `a truncated collection file was answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body?.code, 'backup_not_whole');
    assert.match(String(answer.body?.error), /door-b_facts/, `the refusal does not name the collection: ${JSON.stringify(answer.body)}`);
    assert.ok(!String(answer.body?.error).includes(backup.dir), `the refusal names a path: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(restoreEntries(mods.loader), [], 'a refused restore registered acts');
  });

  it('a file-system error while the backup is read (a directory where a collection file should be) is owed with a retry time, not needsAbandon, replaces nothing, and the retry completes once the file is back', T, async () => {
    const { backup, live } = await seedAndBackup('fserror');
    const file = path.join(backup.dir, 'door-b_facts.ndjson');
    const original = fs.readFileSync(file);
    // After the door answered, as the body is about to run: the file becomes a directory, which a read refuses with EISDIR.
    mods.runner.setSpaceActHooksForTest({
      afterDrain: (e) => { if (e.kind === 'restore' && fs.statSync(file).isFile()) { fs.rmSync(file); fs.mkdirSync(file); } },
    });
    const answer = await requestRestore(mods.dataRouter, { backupId: backup.id });
    assert.equal(answer.status, 202, `the door answered ${answer.status}: ${JSON.stringify(answer.body)}`);
    await Promise.all(startRestoreActs(mods.runner, mods.loader));

    const rows = spaceRowsOfReport(await restoreReportBody(mods.dataRouter));
    for (const space of SPACES) {
      assert.equal(rows[space]?.state, 'owed', `${space} is not owed after the file-system error: ${JSON.stringify(rows[space])}`);
      assert.ok(rows[space]?.retryAt, `${space} has no retry time (a file-system error is retried): ${JSON.stringify(rows[space])}`);
      assert.ok(!rows[space]?.needsAbandon, `${space} needs an abandon over a file-system error the backup did not cause: ${JSON.stringify(rows[space])}`);
    }
    for (const space of SPACES) assert.deepEqual(await ids(space), live[space], `${space} was replaced over a backup that could not be read`);

    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, original);
    mods.runner.setSpaceActHooksForTest(null);
    const at = Math.max(...SPACES.map(s => Date.parse(rows[s].retryAt))) + 1000;
    await mods.runner.retryOwedSpaceActs(at);
    await untilRunnerIdle(mods.runner, mods.loader, { now: at });
    assert.deepEqual(restoreEntries(mods.loader), [], 'the retry did not complete the restore');
    for (const space of SPACES) assert.deepEqual(await ids(space), [`${space}-1`, `${space}-2`], `${space} is not the backup after the retry`);
  });

  it('control: an encrypted backup with no master secret configured is still 400 backup_not_whole at the door, naming the secret', T, async () => {
    const { getDataRoot } = await import('../../server/dist/config/loader.js');
    const { dumpDatabase } = await import('../../server/dist/db/dump.js');
    const had = { key: process.env['YTHRIL_MASTER_KEY'], pass: process.env['YTHRIL_MASTER_PASSPHRASE'] };
    const dir = path.join(getDataRoot(), 'backups', `encrypted-${Date.now()}`);
    process.env['YTHRIL_MASTER_KEY'] = randomBytes(32).toString('base64');
    delete process.env['YTHRIL_MASTER_PASSPHRASE'];
    try {
      await dumpDatabase(testMongoUri(`ythril_harness_${SUITE}`), dir, { encrypt: true });
      delete process.env['YTHRIL_MASTER_KEY'];
      const answer = await requestRestore(mods.dataRouter, { backupId: path.basename(dir) });
      assert.equal(answer.status, 400, `an encrypted backup with no secret was answered ${answer.status}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body?.code, 'backup_not_whole');
      assert.match(String(answer.body?.error), /master secret/i, `the refusal does not name the missing secret: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(restoreEntries(mods.loader), [], 'a refused restore registered acts');
    } finally {
      if (had.key === undefined) delete process.env['YTHRIL_MASTER_KEY']; else process.env['YTHRIL_MASTER_KEY'] = had.key;
      if (had.pass === undefined) delete process.env['YTHRIL_MASTER_PASSPHRASE']; else process.env['YTHRIL_MASTER_PASSPHRASE'] = had.pass;
    }
  });
});
