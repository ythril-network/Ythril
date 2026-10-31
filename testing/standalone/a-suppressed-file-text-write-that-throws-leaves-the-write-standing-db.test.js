/**
 * A suppressed file's lexical text is a best-effort tail of a write that already landed: when its write throws, the caller's write
 * stands and ONE warning says what is left undone (bundle-49 review, #7).
 *
 * ## The defect
 *
 * `storeSuppressedFileText` runs after a peer's file metadata has been merged (`ingestFileMeta`, and the stray drain's fill through
 * the arrival writer). Its last step stores the receiver's own `matchedText` on a file it suppresses. A database error there escaped
 * into those callers: the merge had landed, and the arrival writer reported the wrong cause for the page. Retries are idempotent, so
 * nothing was lost, but the failure named something that did not happen.
 *
 * ## The rule
 *
 * The step catches its own failure, warns once naming the files and the repair (`reembed` finds a row without its text), and returns.
 *
 * Run: node --test testing/standalone/a-suppressed-file-text-write-that-throws-leaves-the-write-standing-db.test.js
 * (requires a prior `npm run build:server`, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-suppressed-file-text-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const NOW = '2026-01-01T00:00:00.000Z';
const AUTHOR = { instanceId: 'peer', instanceLabel: 'Peer' };
const row = (id, extra = {}) => ({ _id: id, spaceId: SPACE, path: id, tags: [], createdAt: NOW, updatedAt: NOW, sizeBytes: 3, seq: 1, ...extra });

let mongo, text, shared, log, proto, realUpdateOne;
let failTextWrite = false;

/** Every warning the server logs while `fn` runs, with the file text write failing. */
async function warningsWhileFailing(fn) {
  const warned = [];
  const was = log.warn;
  log.warn = (m) => { warned.push(String(m)); };
  failTextWrite = true;
  try { await fn(); } finally { failTextWrite = false; log.warn = was; }
  return warned;
}

describe('a throw from a suppressed file\'s text write', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('suppressedfiletext');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'suppressed-file-text-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    text = await import('../../server/dist/sync/suppressed-file-text.js');
    shared = await import('../../server/dist/api/sync/_shared.js');
    log = (await import('../../server/dist/util/log.js')).log;
    proto = Object.getPrototypeOf(mongo.col('probe'));
    realUpdateOne = proto.updateOne;
    proto.updateOne = async function maybeFail(filter, update, ...rest) {
      if (failTextWrite && this.collectionName === `${SPACE}_files` && update?.$set && 'matchedText' in update.$set) {
        throw new Error('simulated text write failure');
      }
      return realUpdateOne.call(this, filter, update, ...rest);
    };
  });

  after(async () => {
    if (proto && realUpdateOne) proto.updateOne = realUpdateOne;
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('lets the caller go on, and warns once naming the files and the repair', async () => {
    const files = mongo.col(`${SPACE}_files`);
    await files.deleteMany({});
    await files.insertMany([
      row('docs/quiet-1.md', { suppressEmbeddings: true, description: 'kept out of semantic search' }),
      row('docs/quiet-2.md', { suppressEmbeddings: true, description: 'also kept out' }),
      row('docs/loud.md'),
    ]);
    const warned = await warningsWhileFailing(() => text.storeSuppressedFileText(SPACE, ['docs/quiet-1.md', 'docs/quiet-2.md', 'docs/loud.md']));
    assert.equal(warned.length, 1, `one warning for the whole step, not ${warned.length}: ${JSON.stringify(warned)}`);
    for (const needle of ['docs/quiet-1.md', 'docs/quiet-2.md', 'reembed']) {
      assert.ok(warned[0].includes(needle), `the warning does not name ${needle}: ${warned[0]}`);
    }
    assert.equal(await files.countDocuments({}), 3);
    assert.equal((await files.findOne({ _id: 'docs/quiet-1.md' })).matchedText, undefined, 'the simulated failure did not apply: the test checks nothing');
  });

  it('a peer\'s file metadata merged onto a row this instance suppresses lands although its text write fails', async () => {
    const files = mongo.col(`${SPACE}_files`);
    await files.deleteMany({});
    await files.insertOne(row('docs/merged.md', { description: 'before', author: AUTHOR }));
    let landed;
    const warned = await warningsWhileFailing(async () => {
      landed = await shared.ingestFileMeta(SPACE, {
        _id: 'docs/merged.md', spaceId: SPACE, path: 'docs/merged.md', tags: [], description: 'after', suppressEmbeddings: true,
        seq: 2, author: AUTHOR, createdAt: NOW, updatedAt: NOW,
      });
    });
    assert.equal(landed, true, 'the merge did not answer that it landed');
    const stored = await files.findOne({ _id: 'docs/merged.md' });
    assert.equal(stored.seq, 2, 'the merge did not land');
    assert.equal(stored.matchedText, undefined, 'the simulated failure did not apply: the test checks nothing');
    assert.equal(warned.length, 1, JSON.stringify(warned));
    assert.ok(warned[0].includes('docs/merged.md') && warned[0].includes('reembed'), warned[0]);
  });
});
