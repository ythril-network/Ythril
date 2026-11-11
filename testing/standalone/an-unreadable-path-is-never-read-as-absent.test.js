/**
 * A path the process may not look at is never read as "not there" by a synchronous existence check (Q-350 a, bundle-70 S1).
 *
 * ## The defect
 *
 * `fs.existsSync` answers `false` for ANY failure: a missing path and a path the process may not look at (EACCES, a directory on the
 * way without search permission) read the same. Every caller below asked it "is it here", and turned a permission failure into "no":
 *
 * - the offsite copy of the uploaded files (`copyFilesOffsite`) returned `null` for a files directory it could not look at, so a
 *   backup that was meant to carry users' files carried none and said nothing; `pruneBackups` pruned nothing;
 * - `backupDirOf` / `removeBackup` answered "no such backup" for a backup directory they could not look at;
 * - the restore's three checks (`backupManifestHolds`, `backupIsWhole`, `backupLoader`) condemned a backup as "holds no file for
 *   collection X" (a verdict on the BACKUP, a 400 that is never retried) when the file system refused the look;
 * - `loadBackupConfig` answered "backup not configured" for a backup config it could not look at, so scheduled backups stopped silently;
 * - `loadSecrets` / `loadSchemaLibrary` / `loadSchemaCatalogs` answered "no such file" (an empty secrets file, an empty library) for a
 *   state file they could not look at, and `migrateStateFilesAtRest` skipped it: a plaintext secrets file stayed plaintext.
 *
 * Same rule, other shape: `listFilesRecursive` swallowed a failing `readdir`, so a directory delete or move over an unreadable subtree
 * acted on a partial list; the at-rest walk skipped an unreadable subtree without a word.
 *
 * ## The rule
 *
 * A look that fails for any reason but "the path does not exist" is thrown (or, for a walk that must go on, reported), never answered
 * as "absent". The one answer is `pathPresentSync` in `util/path-present.ts`; the gate over every tracked source is in
 * `are-the-bytes-here-has-one-answer.test.js`.
 *
 * ## How the refusal is staged
 *
 * `_unreadable-paths.mjs`: every fs call naming the path fails with EACCES and `existsSync` answers `false`, as the OS does. `chmod`
 * cannot stage it on Windows or as root (the Docker runner's user), and a directory at a file's path (EISDIR) fails a READ but not an
 * existence check. Each case also asserts the refusal was REACHED (`hits`), so a case whose path is never looked at cannot pass, and
 * runs the unblocked twin (missing path, readable path) so a fix that refuses everything fails too.
 *
 * Run: node --test testing/standalone/an-unreadable-path-is-never-read-as-absent.test.js   (requires `npm run build -w @ythril/server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withBlockedPaths } from './_unreadable-paths.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-unreadable-'));
const CONFIG_DIR = path.join(root, 'config');
const DATA_ROOT = path.join(root, 'data');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(DATA_ROOT, { recursive: true });
process.env['CONFIG_PATH'] = path.join(CONFIG_DIR, 'config.json');
process.env['DATA_ROOT'] = DATA_ROOT;

const SECRETS = path.join(CONFIG_DIR, 'secrets.json');
const LIBRARY = path.join(CONFIG_DIR, 'schema-library.json');
const CATALOGS = path.join(CONFIG_DIR, 'schema-catalogs.json');
const BACKUP_JSON = path.join(CONFIG_DIR, 'backup.json');

/** Run `fn`; answer what it returned or what it threw, so a case says which. */
async function outcome(fn) {
  try { return { returned: await fn() }; } catch (error) { return { threw: error }; }
}
const refused = (o, what) => assert.ok(o.threw, `${what}: answered ${JSON.stringify(o.returned)} instead of refusing`);

describe('an unreadable path is never read as absent by an existence check', () => {
  let offsite, location, restore, loader, backupConfig, files, atRest;
  before(async () => {
    offsite = await import('../../server/dist/db/offsite.js');
    location = await import('../../server/dist/db/backup-location.js');
    restore = await import('../../server/dist/db/restore.js');
    loader = await import('../../server/dist/config/loader.js');
    backupConfig = await import('../../server/dist/db/backup-config.js');
    files = await import('../../server/dist/files/files.js');
    atRest = await import('../../server/dist/files/at-rest-migration.js');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('the offsite copy', () => {
    it('copyFilesOffsite: a files directory it cannot look at is refused, not "no files"; a missing one is still null', async () => {
      const filesDir = path.join(root, 'offsite-files');
      fs.mkdirSync(filesDir);
      fs.writeFileSync(path.join(filesDir, 'a.txt'), 'users file');
      const dest = path.join(root, 'offsite-dest');
      fs.mkdirSync(dest);
      assert.equal(offsite.copyFilesOffsite(path.join(root, 'no-such-files'), dest, 'b0'), null, 'a files directory that does not exist is no files');
      await withBlockedPaths([filesDir], async (hits) => {
        const o = await outcome(() => offsite.copyFilesOffsite(filesDir, dest, 'b1'));
        assert.ok(hits.count > 0, 'the files directory was never looked at: the case checks nothing');
        refused(o, 'copyFilesOffsite over a files directory the OS refuses');
      });
      assert.deepEqual(fs.readdirSync(dest), [], 'a refused copy left something at the destination');
    });

    it('pruneBackups: a backup directory it cannot look at is refused, not "nothing to prune"; a missing one prunes 0', async () => {
      const dir = path.join(root, 'offsite-backups');
      fs.mkdirSync(dir);
      assert.equal(offsite.pruneBackups(path.join(root, 'no-such-backups'), 1), 0);
      await withBlockedPaths([dir], async (hits) => {
        const o = await outcome(() => offsite.pruneBackups(dir, 1));
        assert.ok(hits.count > 0, 'the backup directory was never looked at: the case checks nothing');
        refused(o, 'pruneBackups over a directory the OS refuses');
      });
    });
  });

  describe('the local backup location', () => {
    const backupsRoot = () => path.join(DATA_ROOT, 'backups');

    it('backupDirOf: a backup whose manifest it cannot look at is refused, not "no such backup"', async () => {
      const id = '2026-01-01T00-00-00-000Z';
      fs.mkdirSync(path.join(backupsRoot(), id), { recursive: true });
      fs.writeFileSync(path.join(backupsRoot(), id, 'manifest.json'), '{"collections":[]}');
      assert.equal(location.backupDirOf(id), path.join(backupsRoot(), id), 'a backup with a manifest is found');
      assert.equal(location.backupDirOf('2026-01-02T00-00-00-000Z'), null, 'a backup that does not exist is null');
      await withBlockedPaths([path.join(backupsRoot(), id, 'manifest.json')], async (hits) => {
        const o = await outcome(() => location.backupDirOf(id));
        assert.ok(hits.count > 0, 'the manifest was never looked at: the case checks nothing');
        refused(o, 'backupDirOf over a manifest the OS refuses');
      });
    });

    it('removeBackup: a backup directory it cannot look at is refused, not "nothing removed"', async () => {
      const id = '2026-02-01T00-00-00-000Z';
      fs.mkdirSync(path.join(backupsRoot(), id), { recursive: true });
      assert.equal(location.removeBackup('2026-02-02T00-00-00-000Z'), false, 'a backup that does not exist removes nothing');
      await withBlockedPaths([path.join(backupsRoot(), id)], async (hits) => {
        const o = await outcome(() => location.removeBackup(id));
        assert.ok(hits.count > 0, 'the backup directory was never looked at: the case checks nothing');
        refused(o, 'removeBackup over a directory the OS refuses');
      });
    });
  });

  describe('the restore: a collection file the OS refuses is a read failure, not "the backup holds no file"', () => {
    /** A backup directory whose manifest names one collection, `sub/c`, whose file would be `<dir>/sub/c.ndjson`. */
    function backupDir(name) {
      const dir = path.join(root, name);
      fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ collections: [{ name: 'sub/c', count: 1 }] }));
      return dir;
    }
    const verdictOnTheBackup = (o) => o.threw && o.threw instanceof restore.BackupNotWhole;

    for (const [label, ask] of [
      ['backupManifestHolds', (dir) => restore.backupManifestHolds(dir)],
      ['backupIsWhole', (dir) => restore.backupIsWhole(dir)],
      ['backupLoader', (dir) => restore.backupLoader()({}, dir, { name: 'sub/c', count: 1 })],
    ]) {
      it(`${label}: the file system's refusal is thrown as itself; a file that is not there is still the backup's verdict`, async () => {
        const dir = backupDir(`restore-${label}`);
        const missing = await outcome(() => ask(dir));
        assert.ok(verdictOnTheBackup(missing), `${label}: a collection file that is not there must stay BackupNotWhole (got ${missing.threw ?? JSON.stringify(missing.returned)})`);
        await withBlockedPaths([path.join(dir, 'sub')], async (hits) => {
          const o = await outcome(() => ask(dir));
          assert.ok(hits.count > 0, 'the collection file was never looked at: the case checks nothing');
          assert.ok(o.threw, `${label}: answered ${JSON.stringify(o.returned)} for a file the OS refuses`);
          assert.equal(verdictOnTheBackup(o), false,
            `${label}: a file the OS refused to look at was condemned as "the backup holds no file" (${o.threw.message}); a restore act retries a read failure and abandons a verdict`);
        });
      });
    }
  });

  describe('the backup configuration', () => {
    it('loadBackupConfig: a backup.json it cannot look at is refused or said, not silently "backup not configured"', async () => {
      const absent = await logLinesDuring(() => backupConfig.loadBackupConfig());
      assert.equal(absent.result, null, 'no backup.json is "not configured"');
      assert.deepEqual(absent.lines.filter(l => /backup\.json/.test(l)), [], 'an absent backup.json is the normal state and says nothing');
      await withBlockedPaths([BACKUP_JSON], async (hits) => {
        const o = await logLinesDuring(() => outcome(() => backupConfig.loadBackupConfig()));
        assert.ok(hits.count > 0, 'backup.json was never looked at: the case checks nothing');
        const said = o.lines.some(l => /backup\.json/.test(l));
        assert.ok(o.result.threw || said,
          `loadBackupConfig answered ${JSON.stringify(o.result.returned)} for a backup.json the OS refuses, and logged nothing naming it: scheduled backups stop and nobody is told`);
      });
    });
  });

  describe('the state files of the config directory', () => {
    it('loadSecrets / loadSchemaLibrary / loadSchemaCatalogs: a file the OS refuses stops the load naming the file; an absent one loads empty', async () => {
      assert.deepEqual(loader.loadSecrets(), { peerTokens: {} }, 'no secrets.json is the pre-setup shell');
      assert.deepEqual(loader.loadSchemaLibrary(), [], 'no schema-library.json is an empty library');
      assert.deepEqual(loader.loadSchemaCatalogs(), [], 'no schema-catalogs.json is no catalogs');
      for (const [file, load] of [[SECRETS, () => loader.loadSecrets()], [LIBRARY, () => loader.loadSchemaLibrary()], [CATALOGS, () => loader.loadSchemaCatalogs()]]) {
        await withBlockedPaths([file], async (hits) => {
          const o = await outcome(load);
          assert.ok(hits.count > 0, `${path.basename(file)} was never looked at: the case checks nothing`);
          refused(o, `loading ${path.basename(file)} the OS refuses (an empty answer replaces the file's content)`);
          assert.match(String(o.threw?.message), new RegExp(path.basename(file).replace('.', '\\.')), 'the refusal does not name the file');
        });
      }
    });

    it('migrateStateFilesAtRest: a state file the OS refuses is not skipped as "not there" (its plaintext would stay)', async () => {
      process.env['YTHRIL_MASTER_KEY'] = Buffer.alloc(32, 7).toString('base64');
      try {
        await withBlockedPaths([SECRETS], async (hits) => {
          const o = await outcome(() => loader.migrateStateFilesAtRest());
          assert.ok(hits.count > 0, 'secrets.json was never looked at: the case checks nothing');
          refused(o, 'migrateStateFilesAtRest over a secrets.json the OS refuses');
          assert.match(String(o.threw?.message), /secrets\.json/);
        });
      } finally {
        delete process.env['YTHRIL_MASTER_KEY'];
      }
    });
  });

  describe('the walks that swallowed a failing readdir', () => {
    it('listFilesRecursive: an unreadable subtree refuses the listing; a complete tree is listed, a missing directory is []', async () => {
      const space = path.join(DATA_ROOT, 'files', 'sp');
      fs.mkdirSync(path.join(space, 'sub', 'locked'), { recursive: true });
      fs.writeFileSync(path.join(space, 'sub', 'b.txt'), 'b');
      fs.writeFileSync(path.join(space, 'sub', 'locked', 'x.txt'), 'x');
      assert.deepEqual((await files.listFilesRecursive('sp', 'sub')).sort(), ['sub/b.txt', 'sub/locked/x.txt'], 'a readable tree is listed whole');
      assert.deepEqual(await files.listFilesRecursive('sp', 'nothing-here'), [], 'a missing directory lists nothing');
      await withBlockedPaths([path.join(space, 'sub', 'locked')], async (hits) => {
        const o = await outcome(() => files.listFilesRecursive('sp', 'sub'));
        assert.ok(hits.count > 0, 'the subtree was never read: the case checks nothing');
        // A delete or a move over this list acts on `sub/b.txt` alone and takes the unlisted files' directory with it.
        refused(o, 'listFilesRecursive over an unreadable subtree (a partial list)');
      });
    });

    it('the at-rest walk: an unreadable subtree is reported by name and the pass goes on (never a silent skip)', async () => {
      const space = path.join(DATA_ROOT, 'files', 'atrest');
      fs.mkdirSync(path.join(space, 'walled'), { recursive: true });
      fs.writeFileSync(path.join(space, 'ok.txt'), 'ok');
      fs.writeFileSync(path.join(space, 'walled', 'y.txt'), 'y');
      await withBlockedPaths([path.join(space, 'walled')], async (hits) => {
        const { lines, result } = await logLinesDuring(() => atRest.runAtRestMigration());
        assert.ok(hits.count > 0, 'the subtree was never read: the case checks nothing');
        assert.equal(result.phase, 'finished', 'one unreadable subtree stopped the whole pass');
        const named = lines.some(l => /walled/.test(l)) || JSON.stringify(result).includes('walled');
        assert.ok(named, `the pass skipped the unreadable subtree 'walled' without a word (log: ${JSON.stringify(lines)}; state: ${JSON.stringify(result)})`);
      });
    });
  });
});
