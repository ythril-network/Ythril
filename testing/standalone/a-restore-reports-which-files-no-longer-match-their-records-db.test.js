/**
 * A restore says, per space, which files no longer match their records (bundle-111, Q-557; design rev 3 steps 6-9, V-S5 to V-S7, V-S11).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * A backup carries the database and not the bytes under `<DATA_ROOT>/files`, so a restore puts back the records of the backup's moment
 * over the bytes of THIS moment. Nothing says which files then disagree with their rows; the restore reports success. The design's answer
 * is a report and no repair (a tombstone written by a restore would delete a peer's copy): `restoreSpace` classifies the space's files
 * once the records are loaded, and the per-space report of `GET /api/admin/data/restore` carries
 * `files: { checked, classes: { <class>: { count, paths } } }`:
 *
 * - `missing_row`: bytes that no live row names (created after the backup);
 * - `stale_row`: a live row whose sha256 is not the bytes' (rewritten after the backup);
 * - `unprocessed`: a live row of a class that processes, with no processing state;
 * - `row_without_bytes`: a live row that records bytes (a sha256) and has none on disk (deleted after the backup);
 * - `soft_deleted_with_bytes`: a soft-deleted row whose path has bytes again (re-uploaded after the backup).
 *
 * ## What is asserted
 *
 * 1. Every class is named by its files, with the count, and the paths stay at most `REPORT_PATHS_PER_CLASS` per class; a TOTAL cap binds
 *    across spaces too, so the set stored in the config stays bounded. A path is `peerText`-bounded: a name that is long or carries an
 *    escape sequence is quoted bounded and escaped.
 * 2. The derived trees give no false positive (spill, chunk row, sidecar row and bytes, instance-local copies, an imported row that
 *    records no bytes, a soft-deleted row with no bytes), and an NFD name on disk with an NFC row is one file: in step, or reported once.
 * 3. The pull's classifier and the restore's answer the same for the same input (`repairReasonOf` is compared with the report, case by
 *    case); `row_without_bytes` and `soft_deleted_with_bytes` are NOT pull repair reasons (V-S7; the pull's counters never produce them).
 * 4. A forced classifier failure, and one that outlasts the file-system bound, leave the restore SUCCEEDING with `files.checked: false`
 *    and a reason of ours (no driver text, no credentials), for that space only.
 * 5. The completion line carries the mismatch totals; "not checked" is warned ONCE per restore, and not at all when every space checked.
 * 6. The pass changes nothing: bytes, rows, tombstones and the hash cache are as the restore left them.
 *
 * The shape of `files` is this suite's reading of rev 3 step 8 (`classOf` in `_restore-act.mjs` is the one place that reads it). The
 * classes, the cap of ten and the three `checked: false` causes are the design's; the totals wording and the total cap's number are not
 * fixed by it, so the suite asserts what a reader of the line or the config needs (the digits; a cap that binds) and no more.
 *
 * ## Seen red
 *
 * On 3a117862 no space row carries `files`: every case below that reads it fails on "the space's report carries no files". The cases that
 * hold what the pass must NOT do (controls, the pull's reasons, report-only) are green there and say so in their titles.
 *
 * Run: `node --test testing/standalone/a-restore-reports-which-files-no-longer-match-their-records-db.test.js` (a Mongo the harness
 * accepts; a prior `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { build } from './_push-door.mjs';
import { clearActEntries, deferred, resetRunnerForTest } from './_space-act-harness.mjs';
import {
  restoreModules, takeBackup, restoreThenReport, spaceRowsOfReport, classOf, reportedPaths, FILE_CLASSES, REPORT_PATHS_PER_CLASS,
} from './_restore-act.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const SUITE = 'restorefilesreport';
const T = { timeout: 180_000 };
const CAP_SPACES = ['rf-c1', 'rf-c2', 'rf-c3'];
const SPACES = ['rf-a', 'rf-b', 'rf-n', 'rf-q', ...CAP_SPACES];
const SPILL = (n) => `_tmp/graph-0000000${n}-0000-4000-8000-000000000000.json`;

let door, mods, ranges;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const dirOf = (space) => join(process.env['DATA_ROOT'], 'files', space);
let seq = 1000;

/** Bytes at `rel` of `space`, written as an arriving file would be, with no row. */
function bytes(space, rel, content) {
  const abs = join(dirOf(space), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A file row of `space` (what the server's own write leaves of a file), with `extra` over it. `content` makes the size and sha256 true. */
async function row(space, id, content, extra = {}) {
  const sizes = content === undefined ? {} : { sizeBytes: Buffer.byteLength(content), sha256: sha(content) };
  // An undefined key is a key the row does not have (the driver would store it as null, which is a value).
  const doc = build.filemeta(space, id, ++seq, { embeddingStatus: 'done', ...sizes, ...extra });
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  await door.coll(space, 'files').insertOne(doc);
}

/** A file of `space` as the server's own write leaves it: bytes and a row that describes them. */
async function file(space, id, content, extra) { bytes(space, id, content); await row(space, id, content, extra); }

/** Every space as a fresh test starts it: no file rows, tombstones or hash cache, and no bytes. */
async function clean() {
  for (const s of SPACES) {
    for (const part of ['files', 'tombstones', 'file_hashes']) await door.coll(s, part).deleteMany({});
    rmSync(dirOf(s), { recursive: true, force: true });
  }
}

/** Every file under `space`'s directory with the sha256 of its bytes: what a pass that changes nothing leaves as it found it. */
function bytesOf(space) {
  if (!existsSync(dirOf(space))) return {};
  return Object.fromEntries(readdirSync(dirOf(space), { recursive: true, withFileTypes: true })
    .filter(e => e.isFile()).map(e => { const abs = join(e.parentPath ?? e.path, e.name); return [abs, sha(readFileSync(abs))]; }));
}

/** The log lines (level and text) a call emits while it runs. */
async function withLog(fn) {
  const { subscribeLogLines } = await import('../../server/dist/util/log.js');
  const lines = [];
  const stop = subscribeLogLines(l => lines.push(l));
  try { return { value: await fn(), lines }; } finally { stop(); }
}

/** The moment of the backup, then what happens after it, then the restore: the report the operator reads. */
async function scenario(atBackup, afterBackup, { hooks, knobs } = {}) {
  await clean();
  await atBackup();
  // Letters and digits in one word: a total read out of the completion line can never match a piece of the backup's id.
  const backup = await takeBackup(SUITE, `rfb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  await afterBackup();
  const disk = Object.fromEntries(SPACES.map(s => [s, bytesOf(s)]));
  if (hooks) mods.runner.setSpaceActHooksForTest(hooks);
  if (knobs) mods.runner.setSpaceActKnobsForTest(knobs);
  const out = await withLog(() => restoreThenReport(mods, backup.id));
  return { body: out.value, lines: out.lines, rows: spaceRowsOfReport(out.value), backup, disk };
}

/** The space's `files` report, asserted present: the red of every case that reads it. */
function filesOf(rows, space) {
  const f = rows[space]?.files;
  assert.ok(f && typeof f === 'object', `the report of space '${space}' carries no files: ${JSON.stringify(rows[space])}`);
  return f;
}

describe('a restore reports which files no longer match their records (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: SPACES.map(id => ({ id, label: id, folders: [] })) });
    mods = await restoreModules();
    ranges = await import('../../server/dist/sync/file-sync.js');
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(() => { resetRunnerForTest(mods.runner); clearActEntries(mods.loader); });

  // ── 1. the classes, the derived trees, the pull's reasons, and "change nothing" ──────────────────────────────────────────

  describe('one space holding every class and every derived tree', () => {
    let run;
    const LITERAL = {
      missing_row: ['new.json'],
      stale_row: ['stale.json'],
      unprocessed: ['raw.pdf'],
      row_without_bytes: ['gone.json'],
      soft_deleted_with_bytes: ['resoft.json'],
    };

    before(async () => {
      run = await scenario(async () => {
        const S = 'rf-a';
        await file(S, 'ok.json', '{"in":"step"}');
        await file(S, 'stale.json', '{"v":1}');
        await file(S, 'gone.json', '{"was":"here"}');
        await file(S, 'raw.pdf', '%PDF-1.4 raw', { embeddingStatus: undefined });
        await file(S, 'ok.pdf', '%PDF-1.4 ok');
        await row(S, 'resoft.json', undefined, { deletedAt: '2026-10-01T00:00:00.000Z', sizeBytes: 3, sha256: sha('old') });
        await row(S, 'soft-only.json', undefined, { deletedAt: '2026-10-01T00:00:00.000Z' });
        // What the derived trees hold: none of it may be reported, whichever way it disagrees.
        await row(S, SPILL(1), '{"spill":"row, bytes gone"}');
        bytes(S, SPILL(2), '{"spill":"bytes, no row"}');
        bytes(S, '_converted/ok.pdf.md', 'converted text, no row');
        bytes(S, '_extracted/ok/inner.txt', 'extracted, no row');
        await row(S, '_converted/gone.pdf.md', 'sidecar row, bytes gone', { parentFileId: 'gone.pdf' });
        await row(S, 'ok.pdf#1', 'chunk row, no bytes of its own', { parentFileId: 'ok.pdf' });
        bytes(S, 'notes_2026-10-01T10-00-00-000Z_peer.json', 'a conflict copy');
        bytes(S, 'schemas/rf-a_fact_note.json', '{"schema":"snapshot"}');
        await row(S, 'imported.json', undefined);   // an import drops size and sha256: it records no bytes
      }, async () => {
        const S = 'rf-a';
        bytes(S, 'stale.json', '{"v":2, "and":"a good deal longer"}');
        unlinkSync(join(dirOf(S), 'gone.json'));
        bytes(S, 'new.json', '{"written":"after the backup"}');
        bytes(S, 'resoft.json', '{"uploaded":"again"}');
      });
    });

    it('control: the restore itself landed (the rows are the backup\'s) and every space is done', T, async () => {
      assert.equal(run.body.state, 'completed', JSON.stringify(run.body));
      assert.equal(spaceRowsOfReport(run.body)['rf-a']?.state, 'done');
      const stale = await door.coll('rf-a', 'files').findOne({ _id: 'stale.json' });
      assert.equal(stale?.sha256, sha('{"v":1}'), 'the restore did not put the backup\'s row back: the fixture is wrong');
      assert.equal(existsSync(join(dirOf('rf-a'), 'gone.json')), false, 'the fixture is wrong: the bytes of gone.json must be absent');
    });

    it('names every class by its files, with the count', T, () => {
      const f = filesOf(run.rows, 'rf-a');
      assert.equal(f.checked, true, `the pass did not run: ${JSON.stringify(f)}`);
      for (const cls of FILE_CLASSES) {
        assert.deepEqual([...classOf(f, cls).paths].sort(), LITERAL[cls], `class ${cls}: ${JSON.stringify(f)}`);
        assert.equal(classOf(f, cls).count, LITERAL[cls].length, `class ${cls} counts ${classOf(f, cls).count}`);
      }
    });

    it('gives no false positive: in-step files, derived trees, instance-local copies, chunk rows, imported and soft-deleted-without-bytes rows are not named', T, () => {
      const f = filesOf(run.rows, 'rf-a');
      const named = new Set(reportedPaths(f));
      const expected = new Set(Object.values(LITERAL).flat());
      const strangers = [...named].filter(p => !expected.has(p));
      assert.deepEqual(strangers, [], `named though they are not out of step: ${strangers.join(', ')}`);
      assert.ok(named.size >= 5, 'the derivation found nothing to compare: the pass reported no file at all');
    });

    it('the pull\'s classifier and the restore answer the same for the same input (rev 3.1: file-sync keeps its repair reasons)', T, () => {
      const f = filesOf(run.rows, 'rf-a');
      const named = (p) => FILE_CLASSES.find(c => classOf(f, c).paths.includes(p)) ?? null;
      // The state each case is in on disk NOW: the row the restore put back, the bytes' sha256, the path.
      const cases = [
        ['ok.json', sha('{"in":"step"}'), { sha256: sha('{"in":"step"}'), embeddingStatus: 'done' }],
        ['stale.json', sha('{"v":2, "and":"a good deal longer"}'), { sha256: sha('{"v":1}'), embeddingStatus: 'done' }],
        ['new.json', sha('{"written":"after the backup"}'), undefined],
        ['raw.pdf', sha('%PDF-1.4 raw'), { sha256: sha('%PDF-1.4 raw') }],
        ['ok.pdf', sha('%PDF-1.4 ok'), { sha256: sha('%PDF-1.4 ok'), embeddingStatus: 'done' }],
      ];
      for (const [p, diskSha, held] of cases) {
        assert.equal(named(p), ranges.repairReasonOf(held, diskSha, p), `${p}: the pull's classifier and the restore disagree`);
      }
      // A soft-deleted row is not the pull's to repair (the file is deleted here); the restore reports it as its own class.
      assert.equal(ranges.repairReasonOf({ deletedAt: '2026-10-01T00:00:00.000Z', sha256: sha('old') }, sha('{"uploaded":"again"}'), 'resoft.json'), null);
      assert.equal(named('resoft.json'), 'soft_deleted_with_bytes');
    });

    it('control (green at base): the two classes only the restore has are not pull repair reasons - repairReasonOf never answers them', T, () => {
      const shas = ['a'.repeat(64), 'b'.repeat(64)];
      const rows = [undefined, {}, { sha256: shas[0] }, { sha256: shas[1] }, { sha256: shas[0], embeddingStatus: 'done' }, { deletedAt: 'x', sha256: shas[0] }, { embeddingStatus: 'done' }];
      const answers = new Set();
      for (const r of rows) for (const d of shas) for (const key of ['a.json', 'a.pdf', 'a.md', 'a.docx']) answers.add(ranges.repairReasonOf(r, d, key));
      assert.ok(answers.size >= 3, `the grid reached only ${[...answers].join(', ')}: the derivation is too narrow`);
      assert.deepEqual([...answers].filter(a => a !== null && !['missing_row', 'stale_row', 'unprocessed'].includes(a)), [], 'the pull answered a class that is the restore\'s');
    });

    it('control (green at base): the pass changes nothing - bytes, the rows\' count, tombstones and the hash cache are as the restore left them', T, async () => {
      assert.deepEqual(bytesOf('rf-a'), run.disk['rf-a'], 'the pass added, removed or rewrote bytes');

      assert.equal(await door.coll('rf-a', 'tombstones').countDocuments({}), 0, 'a tombstone appeared: it would delete a peer\'s copy');
      assert.equal(await door.coll('rf-a', 'file_hashes').countDocuments({}), 0, 'the pass wrote the hash cache (rev 3 step 7: no bulkWrite inside the hold)');
      assert.equal(await door.coll('rf-a', 'files').countDocuments({ _id: 'new.json' }), 0, 'the pass made a row for bytes nothing names (it would name this instance their author)');
    });

    it('the completion line carries the mismatch total, and nothing is warned as not checked', T, () => {
      const total = Object.values(LITERAL).flat().length;   // the fixture's own count of files out of step, not read from the report
      assert.equal(total, 5, 'the fixture is wrong: five files are out of step');
      const done = run.lines.filter(l => /restore of backup .* completed/.test(l));
      assert.equal(done.length, 1, `the restore said its completion ${done.length} times: ${done.join(' | ')}`);
      assert.ok(Object.keys(run.rows).length !== total, 'the fixture is wrong: the total would be read from the space count');
      assert.match(done[0], new RegExp(`\\b${total}\\b`), `the completion line carries no mismatch total (${total}): ${done[0]}`);
      assert.deepEqual(run.lines.filter(l => /\[WARN/.test(l) && /not checked/i.test(l)), [], 'a restore that checked every space warned that files were not checked');
    });
  });

  // ── 2. the caps ────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('what is quoted is bounded', () => {
    it('keeps ten paths per class and the exact count, quotes a long or escaping name bounded, and caps the paths across spaces', T, async () => {
      const N = 12;
      const long = `${'d'.repeat(90)}/${'e'.repeat(90)}/${'f'.repeat(90)}/${'g'.repeat(90)}.json`;   // 363 characters
      const escaping = 'x\u001b[2J\nFORGED restore line.json';
      const out = await scenario(async () => {
        for (const S of CAP_SPACES) {
          for (let i = 0; i < N; i++) {
            await row(S, `gone-${i}.json`, `row ${S} ${i}`);          // row_without_bytes (bytes never written)
            await file(S, `stale-${i}.json`, `one ${S} ${i}`);        // stale_row after the rewrite below
            await file(S, `raw-${i}.pdf`, `%PDF ${S} ${i}`, { embeddingStatus: undefined });   // unprocessed
            await row(S, `soft-${i}.json`, undefined, { deletedAt: '2026-10-01T00:00:00.000Z', sizeBytes: 3, sha256: sha('x') });
          }
        }
        await row('rf-q', long, 'long name');           // alone in its class in its space, so it is always among the paths shown
        await row('rf-q', escaping, 'escaping name');
      }, async () => {
        for (const S of CAP_SPACES) {
          for (let i = 0; i < N; i++) {
            bytes(S, `stale-${i}.json`, `two, longer ${S} ${i}`);
            bytes(S, `new-${i}.json`, `new ${S} ${i}`);              // missing_row
            bytes(S, `soft-${i}.json`, `again ${S} ${i}`);           // soft_deleted_with_bytes
          }
        }
      });
      let allPaths = 0;
      for (const S of CAP_SPACES) {
        const f = filesOf(out.rows, S);
        for (const cls of FILE_CLASSES) {
          const c = classOf(f, cls);
          assert.ok(c.count >= N, `${S}/${cls}: counts ${c.count}, not every file of the class (${N})`);
          assert.ok(c.paths.length <= REPORT_PATHS_PER_CLASS, `${S}/${cls}: ${c.paths.length} paths, over the cap of ${REPORT_PATHS_PER_CLASS}`);
          allPaths += c.paths.length;
        }
      }
      assert.ok(allPaths < CAP_SPACES.length * FILE_CLASSES.length * REPORT_PATHS_PER_CLASS,
        `${allPaths} paths across ${CAP_SPACES.length} spaces: no total cap binds, so the set stored in the config is bounded by the number of spaces only`);
      const q = filesOf(out.rows, 'rf-q');
      assert.equal(classOf(q, 'row_without_bytes').count, 2, `the long and the escaping names are two rows without bytes: ${JSON.stringify(q)}`);
      assert.equal(classOf(q, 'row_without_bytes').paths.length, 2);
      for (const p of classOf(q, 'row_without_bytes').paths) {
        assert.ok(p.length <= 256 + 40, `a path is quoted ${p.length} characters long: not peerText-bounded`);
        assert.doesNotMatch(p, /[\u0000-\u001f]/, 'a path carries a raw control character: it can start a line of its own');
      }
      assert.ok(classOf(q, 'row_without_bytes').paths.some(p => p.startsWith('ddd') && p.length < long.length), 'the 363-character name was quoted whole');
    });
  });

  // ── 3. an NFD name ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a name spelled NFD on disk and NFC in its row is one file', () => {
    it('is not reported when its row and bytes agree, and is reported once - as one class - when only its bytes exist', T, async () => {
      const nfd = (s) => s.normalize('NFD');
      const nfc = (s) => s.normalize('NFC');
      const S = 'rf-n';
      const out = await scenario(async () => {
        bytes(S, nfd('café-same.json'), '{"same":true}');                       // on disk NFD
        await row(S, nfc('café-same.json'), '{"same":true}');                   // row id NFC (toDocId)
      }, async () => {
        bytes(S, nfd('café-new.json'), '{"after":"backup"}');
      });
      const onDisk = readdirSync(dirOf(S));
      assert.ok(onDisk.includes(nfd('café-same.json')), `the filesystem here does not keep NFD names (${onDisk.join(', ')}): the premise this case needs is absent`);
      const f = filesOf(out.rows, S);
      const named = reportedPaths(f).filter(p => nfc(p).startsWith('café'));
      assert.deepEqual(named.map(nfc), ['café-new.json'], `the NFD names were reported as: ${JSON.stringify(f)}`);
      assert.equal(classOf(f, 'missing_row').count, 1, 'the NFD file with no row is counted other than once');
      assert.equal(classOf(f, 'row_without_bytes').count, 0, 'an NFC row whose bytes are spelled NFD was reported as a row without bytes');
    });
  });

  // ── 4. the pass can never fail the restore ─────────────────────────────────────────────────────────────────────────────

  describe('a pass that cannot run leaves the restore succeeding', () => {
    const atBackup = async () => { await file('rf-a', 'ok.json', '{}'); await file('rf-b', 'stale.json', '{"v":1}'); };
    const afterBackup = async () => { bytes('rf-b', 'stale.json', '{"v":2, "longer":true}'); };

    it('a throw inside the file-tree step is files.checked false with our reason (no driver text), for that space only; the restore is done (not owed for a retry that would drop and reload the space again)', T, async () => {
      const out = await scenario(atBackup, afterBackup, {
        hooks: { atFileTree: (id) => { if (id === 'rf-a') throw new Error('EIO: mongodb://admin:hunter2@db.internal:27017 unreadable'); } },
      });
      assert.equal(out.rows['rf-a'].state, 'done', `a classifier failure failed the restore: ${JSON.stringify(out.rows['rf-a'])}`);

      const a = filesOf(out.rows, 'rf-a');
      assert.equal(a.checked, false, JSON.stringify(a));
      assert.ok(typeof a.reason === 'string' && a.reason.length > 0, 'a space that was not checked says no reason');
      assert.doesNotMatch(a.reason, /hunter2|mongodb:\/\//, `the reason carries credentials: ${a.reason}`);
      assert.equal(a.reasonCode, 'failed', 'a client cannot word the reason in its own language without its code');
      assert.match(a.reason, /restoring the backup again/i, `the reason does not say what to do: ${a.reason}`);
      const b = filesOf(out.rows, 'rf-b');
      assert.equal(b.checked, true, 'one space\'s failure stopped the check of the next');
      assert.deepEqual(classOf(b, 'stale_row').paths, ['stale.json']);
    });

    it('a pass that outlasts the file-system bound is files.checked false saying it took longer; the restore is done', T, async () => {
      const park = deferred();
      let out;
      try {
        out = await scenario(atBackup, afterBackup, {
          hooks: { atFileTree: (id) => (id === 'rf-a' ? park.promise : undefined) },
          // The parked hook is what outlasts the bound; at the floor, rf-b's real walk finishes well inside it.
          knobs: { SPACE_ACT_FS_MS: 1000 },
        });
      } finally { park.release(); }
      assert.equal(out.rows['rf-a'].state, 'done', JSON.stringify(out.rows['rf-a']));
      const a = filesOf(out.rows, 'rf-a');
      assert.equal(a.checked, false, JSON.stringify(a));
      assert.match(a.reason ?? '', /took longer than/i, `the reason does not say the bound ended it: ${a.reason}`);
      assert.equal(a.reasonCode, 'timeout', JSON.stringify(a));
      assert.equal(a.limitMs, 1000, 'the bound the client words is not the one that ended the check');
      assert.equal(filesOf(out.rows, 'rf-b').checked, true);
    });

    it('"not checked" is warned once per restore however many spaces were not checked, and the totals line still comes once', T, async () => {
      const out = await scenario(atBackup, afterBackup, { hooks: { atFileTree: () => { throw new Error('the mount is gone'); } } });
      for (const S of ['rf-a', 'rf-b']) assert.equal(filesOf(out.rows, S).checked, false, `${S} was checked`);
      const warned = out.lines.filter(l => /\[WARN/.test(l) && /not checked/i.test(l));
      assert.equal(warned.length, 1, `warned ${warned.length} times: ${warned.join(' | ')}`);
      assert.equal(out.lines.filter(l => /restore of backup .* completed/.test(l)).length, 1);
    });
  });
});
