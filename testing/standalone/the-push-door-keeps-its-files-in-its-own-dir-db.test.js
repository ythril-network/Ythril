/**
 * The push-door harness keeps every file a space writes inside its own temporary directory.
 *
 * ## Why this exists
 *
 * `initSpace` creates the space's files directory under `DATA_ROOT`, which defaults to `/data`. The harness set
 * `CONFIG_PATH` for each door but never `DATA_ROOT`, so on Windows the space directories quietly appeared at the
 * drive root and every push-door test passed, while on the Linux CI runner `mkdir /data` was refused with EACCES
 * and every push-door test's setup failed (PR #1475's second Build & Test). Each other database test that needs a
 * data root sets it by hand; this harness is where that step belongs, so no test that opens a door can forget it.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-push-door-keeps-its-files-in-its-own-dir-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'ownfiles';
let door, dataRoot;

describe('the push door keeps its files in its own directory', { skip }, () => {
  before(async () => {
    // As CI starts: nothing in the environment says where data lives, so the server would fall back to /data.
    delete process.env['DATA_ROOT'];
    door = await openPushDoor({ suite: 'pushownfiles', spaces: [{ id: S, label: 'Own', folders: [], meta: {} }] });
    dataRoot = process.env['DATA_ROOT'];
  });
  after(async () => { await door?.close(); });

  it('the door sets a data root inside the system temp directory, not the /data default', () => {
    assert.ok(dataRoot, 'the door left DATA_ROOT unset, so the server writes under /data');
    const tmp = fs.realpathSync(os.tmpdir());
    assert.ok(fs.realpathSync(dataRoot).startsWith(tmp), `DATA_ROOT ${dataRoot} is outside the temp directory ${tmp}`);
  });

  it("the space's files directory was created under that data root", () => {
    const entries = fs.readdirSync(dataRoot, { recursive: true }).map(String);
    assert.ok(entries.some(e => e.split(path.sep).includes(S) || e.split('/').includes(S)),
      `no directory for space ${S} under ${dataRoot}: ${JSON.stringify(entries)}`);
  });
});
