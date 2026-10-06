/**
 * A space rename that fails on the file system answers by its code, not by the absolute path (`Q-386`, the 5.6.6 patch).
 *
 * ## The defect it prevents
 *
 * A space rename moves the space's files directory. When that move failed, `moveSpaceData` put `caughtFailureText(err, …)` into the
 * step's message — and that function answers an error that is not the driver's by ITS OWN message, which for a Node file-system error is
 * the runtime's: `EPERM: operation not permitted, rename '/data/files/old' -> '/data/files/new'`. The step message went into the
 * rename's "incomplete" error, and `renameSpaceAct` answered it as the `500` body of `PATCH /api/spaces/:id/rename` and of the
 * `space_rename` tool: the instance's absolute data path in the hands of whoever asked. A file-system error thrown by another step (the
 * write-ahead config save) took the same road through the act's own catch.
 *
 * ## What is held
 *
 * For a Node file-system error (an `Error` with a string `syscall` and `code`), at both places it can reach an answer:
 *  - the answer carries the CODE, in our words, and no path;
 *  - the runtime's message — path and all — is in the server log, where an operator reads it.
 * The same call still answers a refusal of ours (`not found`) as it always did.
 *
 * ## One door, three cases in order
 *
 * The config loader fixes its path when it is first imported, so a second door in this file would still write the first one's config.
 * The cases run on one door and put back what each one changed: the refusal (changes nothing), the config save (leaves the in-memory
 * write-ahead marker, which is removed with the directory that broke it), then the files directory.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-rename-answer-names-no-path-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();
const CODE = /\b(?:ENOTEMPTY|EPERM|EEXIST|EACCES|EISDIR|ENOTDIR|EBUSY)\b/;

/** Does this text name the temp directory this run's config and data live under? */
const leaked = (text, root) => text.includes(root) || text.includes(root.replace(/\\/g, '/'));

describe('a rename that fails on the file system names no path in its answer', { skip }, () => {
  let door; let rename; let loader; let root;
  before(async () => {
    door = await openPushDoor({ suite: 'renamefs', spaces: [
      { id: 'rn-a', label: 'A', folders: [] },
      { id: 'rn-c', label: 'C', folders: [] },
    ] });
    ({ renameSpaceAct: rename } = await import('../../server/dist/spaces/rename.js'));
    loader = await import('../../server/dist/config/loader.js');
    root = path.dirname(process.env['CONFIG_PATH']);
  });
  after(async () => { await door?.close(); });

  it('still answers its own refusals in its own words', async () => {
    const answer = await rename('no-such-space', { newId: 'rn-e' });
    assert.equal(answer.status, 404);
    assert.match(answer.error, /not found/);
  });

  it('the write-ahead config save cannot be written: 500, the code, no path', { timeout: 60_000 }, async () => {
    // The save writes `config.json.tmp` first: a directory in its place fails the open with a code and the path.
    const blocker = `${process.env['CONFIG_PATH']}.tmp`;
    fs.mkdirSync(blocker);
    try {
      const { result: answer, lines } = await logLinesDuring(() => rename('rn-c', { newId: 'rn-d' }));
      assert.equal(answer.status, 500, JSON.stringify(answer));
      assert.ok(!leaked(answer.error, root), `the answer names the instance's directory: ${answer.error}`);
      assert.match(answer.error, CODE, `the answer carries no code: ${answer.error}`);
      assert.ok(lines.some(l => leaked(l, root)), `the runtime's message is nowhere in the log: ${lines.join(' | ')}`);
    } finally {
      fs.rmdirSync(blocker);
      delete loader.getConfig().pendingSpaceOp;   // the marker the failed save left in memory
    }
  });

  it('the files directory cannot be moved: 500, the code, no path, and the log carries the runtime\'s own message', { timeout: 60_000 }, async () => {
    // The target directory exists and holds a file: renaming a directory onto it fails with a code and two paths.
    const files = path.join(process.env['DATA_ROOT'], 'files');
    fs.mkdirSync(path.join(files, 'rn-a'), { recursive: true });
    fs.writeFileSync(path.join(files, 'rn-a', 'x.txt'), 'x');
    fs.mkdirSync(path.join(files, 'rn-b'), { recursive: true });
    fs.writeFileSync(path.join(files, 'rn-b', 'y.txt'), 'y');
    const { result: answer, lines } = await logLinesDuring(() => rename('rn-a', { newId: 'rn-b' }));
    assert.equal(answer.status, 500, JSON.stringify(answer));
    assert.ok(!leaked(answer.error, root), `the answer names the instance's directory: ${answer.error}`);
    assert.match(answer.error, CODE, `the answer carries no code: ${answer.error}`);
    assert.ok(lines.some(l => leaked(l, root) && /files directory/i.test(l)),
      `the runtime's message is nowhere in the log: ${lines.join(' | ')}`);
  });
});
