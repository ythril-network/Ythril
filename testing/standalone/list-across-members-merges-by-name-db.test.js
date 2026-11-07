/**
 * `listAcrossMembers` is the ONE merge of a directory across the members a read reaches: de-duplicated by NAME, first member wins, an absent
 * directory contributes nothing, a storage fault is a fault (bundle-62, Q-538).
 *
 * It replaces three hand-written copies (MCP `list_dir`, and the two REST listing branches), each of which swallowed every error. The de-dupe
 * assertion that pinned the copy in `mcp/tools/file.ts` lives with `read-tools-state-their-blind-spots.test.js` and now reads this module's source;
 * this file holds the behaviour, including the collision `list_dir`'s description names: a name that is a FILE in one member and a FOLDER in
 * another is one entry, the first member's.
 *
 * Red against 0ac12bdd: `server/dist/files/list-across-members.js` does not exist.
 *
 * Run: node --test testing/standalone/list-across-members-merges-by-name-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const A = 'lamembera';
const B = 'lamemberb';

let acts, listAcrossMembers;
const namesOf = (entries) => entries.map(e => `${e.type === 'dir' ? 'd' : 'f'}:${e.name}`).sort();

describe('listAcrossMembers merges the members of a read by name', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'listmembers', space: A, otherSpaces: [B] });
    ({ listAcrossMembers } = await import('../../server/dist/files/list-across-members.js'));
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); await fsp.rm(acts.rootOf(B), { recursive: true, force: true }); await fsp.mkdir(acts.rootOf(B), { recursive: true }); });

  it('a name held by two members is one entry, the first member\'s (the de-dupe the description states)', async () => {
    await acts.seedIn(A, 'dir/same.txt');
    await acts.seedIn(B, 'dir/same.txt');
    await acts.seedIn(B, 'dir/only-b.txt');
    const entries = await listAcrossMembers([A, B], 'dir');
    assert.deepEqual(namesOf(entries), ['f:only-b.txt', 'f:same.txt']);
  });

  for (const [first, second, label] of [[A, B, 'A holds the file, B the folder'], [B, A, 'B holds the file, A the folder (order reversed)']]) {
    it(`a name that is a file in one member and a folder in another: first member wins — ${label}`, async () => {
      const [fileIn, dirIn] = label.startsWith('A') ? [A, B] : [B, A];
      await acts.seedIn(fileIn, 'dir/x');
      await acts.seedIn(dirIn, 'dir/x/inner.txt');
      const entries = await listAcrossMembers([first, second], 'dir');
      assert.equal(entries.filter(e => e.name === 'x').length, 1, 'the collision produced two entries');
      assert.equal(entries.find(e => e.name === 'x').type, first === fileIn ? 'file' : 'dir', 'the later member won the collision');
    });
  }

  it('a member whose directory is absent contributes nothing, and is no error', async () => {
    await acts.seedIn(A, 'dir/a.txt');
    assert.deepEqual(namesOf(await listAcrossMembers([A, B], 'dir')), ['f:a.txt']);
    assert.deepEqual(await listAcrossMembers([A, B], 'nowhere'), []);
  });

  it('a member that FAILS (EIO) is a FileSystemFault, not an empty contribution', async () => {
    await acts.seedIn(A, 'dir/a.txt');
    await acts.seedIn(B, 'dir/b.txt');
    const real = fsp.readdir;
    const rootB = path.resolve(acts.rootOf(B));
    fsp.readdir = async function injected(...args) {
      if (typeof args[0] === 'string' && path.resolve(args[0]).startsWith(rootB + path.sep)) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
      return real.apply(this, args);
    };
    try {
      await assert.rejects(() => listAcrossMembers([A, B], 'dir'), (err) => err?.name === 'FileSystemFault', 'a storage fault in one member was swallowed');
    } finally { fsp.readdir = real; }
  });
});
