/**
 * The lines, operations and answers a canary run is told to look for are BYTE-IDENTICAL on 5.6.4 (`Q-361`, the
 * observability lens' S-O4: "a pin for 'canary-checked lines byte-identical' is not in the plan's test list").
 *
 * ## Why they are pinned
 *
 * The 5.6.2 and 5.6.3 release notices handed the canary operator steps that name a log line, an audit operation and an
 * answer shape — "find the `merged N file metadata record(s)` line", "Settings, then Audit log, shows
 * `file.stray_filemeta.drain`", "the import log names any extra chunks it removed", "`POST /api/sync/tombstones` answers
 * `{ applied, refused }` … at most 5000 tombstones per request". They check these by TEXT. This patch ports a renderer over
 * every one of those lines' interpolations (`logSafe` becomes the bounded `peerText`), changes how `fmt` builds a line, and
 * moves the store-failure answers; an ordinary line must come out of all of that exactly as it went in, or the run that
 * checks it reports a defect that is only a rewording. Held here by running the real code and comparing the line to a
 * GOLDEN string — a fixture that states what the notices promised, never derived from the code under test.
 *
 * ## What is pinned
 *
 *  1. **the stray-filemeta drain line** (Q-219, including the 5.6.3 suffix with its five counts): `Space '<id>': merged N
 *     file metadata record(s) a 4.0-5.6.1 pull left in '<collection>' (M already complete here, K newer here, D for files
 *     deleted since, W waiting for their file, R refused), and dropped the collection (Q-219).`;
 *  2. **the audit operation** `file.stray_filemeta.drain`, written when the collection is dropped;
 *  3. **the import line**: `Import into space '<id>': entities: +N ~N !N, facts: …, edges: …, chrono: …, files: …, links: …;
 *     removed N derived file row(s) the backup does not hold`, the sentence a restore's canary step reads for "extra chunks removed";
 *  4. **the tombstone answer**: `{ applied, refused }` and the 5000 cap, said as `At most 5000 tombstones per request`.
 *
 * Seen red by mutating one: a changed word in the drain line (`merged` to `merged:`) and the dropped `refused` key of the
 * tombstone answer both fail here, and the original string was put back by hand.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-canary-checked-lines-are-byte-identical-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

const SUITE = 'canarylines';
const LOCAL = { instanceId: `${SUITE}-receiver`, instanceLabel: 'Receiver' };
const PEER = { instanceId: 'canary-peer', instanceLabel: 'Peer' };
const DRAIN = 'canary-drain';
const IMPORT = 'canary-import';
const STAMPED_AT = '2025-01-01T00:00:00.000Z';

let door, drainStrayFileMeta, importDocuments;

/** One emitted line without its `[timestamp] [LEVEL] ` lead — what a canary reader matches on. */
const bare = line => line.replace(/^\[[^\]]+\] \[[A-Z ]+\](?: \[[^\]]+\])? /, '');

const stampedRow = (space, id, seq) =>
  build.filemeta(space, id, seq, { author: LOCAL, createdAt: STAMPED_AT, updatedAt: STAMPED_AT });
const stray = (space, id, seq, extra = {}) =>
  ({ ...build.filemeta(space, id, seq, { author: PEER }), sizeBytes: 999, sha256: 'sender-hash', ...extra });

describe('the canary-checked lines are byte-identical', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: SUITE, spaces: [DRAIN, IMPORT].map(id => ({ id, label: id, folders: [] })),
    });
    ({ drainStrayFileMeta } = await import('../../server/dist/sync/stray-filemeta-drain.js'));
    ({ importDocuments } = await import('../../server/dist/api/admin-import.js'));
  });
  after(async () => { await door?.close(); });

  it('the stray-filemeta drain line, with the 5.6.3 counts, and the audit operation written beside it', async () => {
    await door.coll(DRAIN, 'files').insertOne(stampedRow(DRAIN, 'stamped.md', 900));
    await door.mongo.getDb().collection(`${DRAIN}_file_tombstones`).insertOne(
      { _id: 'tomb-1', spaceId: DRAIN, path: 'deleted-since.md', deletedAt: STAMPED_AT });
    await door.coll(DRAIN, 'filemeta').insertMany([
      stray(DRAIN, 'stamped.md', 20, { description: 'described upstream', tags: ['onboarding'] }),
      stray(DRAIN, 'deleted-since.md', 21, { description: 'a file this instance deleted' }),
    ]);

    const { lines, result: dropped } = await logLinesDuring(() => drainStrayFileMeta());
    assert.ok(dropped.includes(DRAIN), `fixture check: the drain did not drop the collection (dropped: ${JSON.stringify(dropped)})`);
    const line = lines.map(bare).find(l => l.includes('file metadata record(s)'));
    assert.equal(line,
      `Space '${DRAIN}': merged 1 file metadata record(s) a 4.0-5.6.1 pull left in '${DRAIN}_filemeta' `
      + '(0 already complete here, 0 newer here, 1 for files deleted since, 0 waiting for their file, 0 refused), '
      + 'and dropped the collection (Q-219).');

    const audit = door.mongo.getDb().collection('audit_log');
    let entry = null;
    for (let i = 0; i < 50 && !entry; i++) {              // the audit write is fire-and-forget: poll rather than sleep once
      entry = await audit.findOne({ spaceId: DRAIN, operation: 'file.stray_filemeta.drain' });
      if (!entry) await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(entry, 'no audit entry named `file.stray_filemeta.drain` — Settings, then Audit log, would show nothing');
  });

  it('the import line names the derived rows it removed', async () => {
    const file = (id, seq = 5) => build.filemeta(IMPORT, id, seq);
    const chunk = (parent, n, seq = 5) => ({ ...build.filemeta(IMPORT, `${parent}#chunk-${n}`, seq), parentFileId: parent });
    await door.coll(IMPORT, 'files').insertMany([file('f.md'), ...[0, 1, 2, 3].map(n => chunk('f.md', n))]);
    const { lines, result } = await logLinesDuring(() => importDocuments(IMPORT, { files: [file('f.md', 9), chunk('f.md', 0, 9), chunk('f.md', 1, 9)] }));
    assert.equal(result.results.files.errors, 0, JSON.stringify(result.results.files));
    const line = lines.map(bare).find(l => l.startsWith('Import into space'));
    assert.equal(line,
      `Import into space '${IMPORT}': entities: +0 ~0 !0, facts: +0 ~0 !0, edges: +0 ~0 !0, chrono: +0 ~0 !0, `
      + 'files: +0 ~3 !0, links: +0 ~0 !0; removed 2 derived file row(s) the backup does not hold');
  });

  it('the tombstone answer is { applied, refused }, and a request holds at most 5000', async () => {
    const { MAX_TOMBSTONES_PER_REQUEST } = await import('../../server/dist/sync/tombstone-apply.js');
    assert.equal(MAX_TOMBSTONES_PER_REQUEST, 5000, 'the cap the notices promised');
    const ok = await door.push('/tombstones', { tombstones: [build.tombstone(IMPORT, 'canary-fact', 'fact', 5)] }, { spaceId: IMPORT });
    assert.equal(ok.code, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { applied: 1, refused: 0 });
    const tooMany = await door.push('/tombstones', {
      tombstones: Array.from({ length: 5001 }, (_, i) => build.tombstone(IMPORT, `canary-${i}`, 'fact', 5 + i)),
    }, { spaceId: IMPORT });
    assert.equal(tooMany.code, 400);
    assert.deepEqual(tooMany.body, { error: 'At most 5000 tombstones per request' });
  });
});
