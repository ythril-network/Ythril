/**
 * Resolving a sync conflict never replaces a file the resolution was not about (bundle-113, Q-466).
 *
 * ## The report
 *
 * A conflict record names two paths: the local file and the incoming copy under its conflict name. Three of the four actions are about
 * those two files only. Two are not: `keep-both` with a `rename`, and `save-to-space`, put the incoming copy at a path the CALLER chooses
 * (`rename`, `targetSpaceId`), and both did it with `moveStored`, which REPLACES whatever stands there. A rename onto a file, a folder or
 * a file's record destroyed it, and a replicated file's loss travels to every instance; `save-to-space` onto a name the target space held
 * did the same in another space, for a token that held only the data-quality area there. Every path was resolved lexically, so a link on
 * the way out of the space was followed; a rename through a file answered `500`; and a bulk resolution answered each failure with the file
 * system's own sentence, which names the server's absolute data path.
 *
 * ## What is held (the rule, on both doors: `POST /api/conflicts/:id/resolve` and `POST /api/conflicts/bulk-resolve`)
 *
 *  - **Nothing stands at the destination, or nothing moves.** `keep-both` (with a rename) onto a file, a directory or a live record with no
 *    bytes, and `save-to-space` onto bytes or a record in the target space, are `409 destination_exists` with the destination's path; the
 *    occupant is untouched, the incoming copy stays where it was, and the conflict record is KEPT (a refused resolution leaves the conflict
 *    open). `keep-incoming` replaces the local file: that is its purpose, and it is the one replacing placement.
 *  - **A rename through a file is answered, not a `500`:** `409 path_blocked`.
 *  - **Paths are the sandbox's:** a rename that leaves the space, or goes through a link that does, is `400` and creates nothing; so is a
 *    conflict path that goes through such a link (`keep-local` must not delete the file the link points at); an instance-local destination
 *    (`_converted/…`) is `400`; `rename` and `targetSpaceId` that are not strings are `400`.
 *  - **`save-to-space` is a write in the target space:** it needs `files:write` there (else `403`, the same answer whether or not anything
 *    stands at the destination — a token without it must not learn what the target holds) and a CONCRETE target (a proxy is `400`).
 *  - **Nothing to place closes the record, and says so:** the copy is gone, or `save-to-space` into the conflict's own space at the same path,
 *    or a `keep-both` rename equal to the conflict path: `200` with `resolved: "nothing-to-place"` — never a claim that something was placed,
 *    and never a refusal against the resolution's own earlier placement.
 *  - **A placement a crash left half done is finished:** the conflict copy and the destination are two names of one file (a crash between the
 *    link and the unlink), and the retry completes it instead of `409`ing against itself. (A case-only rename is one entry under two spellings,
 *    which a case-sensitive file system does not have: that case skips there, `expected-in-ci`.)
 *  - **A bulk failure is the one answer:** `failed[]` items carry `{ id, error, code, status, path }` of the file act's refusal, and a
 *    failure that is not one is the file-system-fault sentence — never `err.message`, which names the data root.
 *
 * ## Seen red
 *
 * On the base every refusal above is a replacement or a `500`, `resolved` does not exist, a bulk failure is the raw message and `keep-local`
 * through a link deletes the target. The free-destination controls are green on it: they state what the change must keep.
 *
 * Run: node --test testing/standalone/a-conflict-resolution-never-replaces-an-unrelated-file-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { caseInsensitiveAt } from './_move-destination.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'confplace';
/** The space a copy is saved to, and a proxy over it (a target must be a concrete space). */
const T = 'confplace-target';
const PROXY = 'confplace-proxy';
const T0 = '2026-09-01T00:00:00.000Z';
const COPY = 'doc.conflict-peer.txt';
const ORIGINAL = 'doc.txt';

let acts, outside;
const abs = (space, p) => path.join(acts.rootOf(space), p);
const read = (space, p) => fs.readFileSync(abs(space, p), 'utf8');
const has = (space, p) => acts.onDiskIn(space, p);
const answer = (res) => ({ status: res.code, ...res.body });
const sentence = (res) => JSON.stringify(res.body);

/** A conflict whose copy is `COPY`, resolved by `action`. Seeds it and returns its id. */
let seq = 0;
const conflict = (over = {}) => acts.conflicts.seed({ id: `c-${++seq}`, ...over });

/** Everything a resolution could change, in both spaces: the trees, the file records and the tombstones. */
async function snapshot() {
  const tree = (space) => (fs.existsSync(acts.rootOf(space)) ? fs.readdirSync(acts.rootOf(space), { recursive: true }).map(p => String(p).replace(/\\/g, '/')).sort() : []);
  const bytes = (space) => Object.fromEntries(tree(space).filter(p => fs.statSync(abs(space, p)).isFile()).map(p => [p, read(space, p)]));
  return {
    trees: [tree(S), tree(T)], bytes: [bytes(S), bytes(T)],
    rows: [await acts.door.coll(S, 'files').find({}).sort({ _id: 1 }).toArray(), await acts.door.coll(T, 'files').find({}).sort({ _id: 1 }).toArray()],
    tombstones: [await acts.door.coll(S, 'file_tombstones').find({}).toArray(), await acts.door.coll(T, 'file_tombstones').find({}).toArray()],
    conflicts: await acts.door.coll(S, 'conflicts').find({}).sort({ _id: 1 }).toArray(),
  };
}

/** A live record of a file whose bytes are not here (a peer's file still arriving, or a delete that stopped). */
const recordOnly = (space, p) => acts.door.coll(space, 'files').insertOne({ _id: p, spaceId: space, path: p, sizeBytes: 5, tags: [], createdAt: T0, updatedAt: T0 });

describe('resolving a conflict never replaces a file it was not about (Q-466)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'confplace', space: S, otherSpaces: [T] });
    (await import('../../server/dist/config/loader.js')).getConfig().spaces.push({ id: PROXY, label: PROXY, folders: [], proxyFor: [T] });
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'confplace-outside-'));
  });
  after(async () => {
    fs.rmSync(outside, { recursive: true, force: true });
    await acts?.close();
  });
  beforeEach(async () => {
    for (const sp of [S, T]) {
      for (const part of ['files', 'file_tombstones', 'conflicts', 'links']) await acts.door.coll(sp, part).deleteMany({});
      fs.rmSync(acts.rootOf(sp), { recursive: true, force: true });
      fs.mkdirSync(acts.rootOf(sp), { recursive: true });
    }
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
  });

  describe('keep-both with a rename: a destination something stands at is refused 409 destination_exists, and nothing moves', () => {
    const REFUSED = (res, dst) => {
      assert.equal(res.code, 409, `answered ${res.code}: ${sentence(res)} — the incoming copy replaced what stood at the destination`);
      assert.equal(res.body?.code, 'destination_exists', sentence(res));
      assert.equal(res.body?.path, dst, sentence(res));
    };

    it('onto a file: the file, the copy and the conflict record are as they were', async () => {
      await acts.seed('taken.txt');
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: 'taken.txt' });
      REFUSED(res, 'taken.txt');
      assert.deepEqual(await snapshot(), before, 'a refused resolution changed a file, a record, a tombstone or the conflict');
      assert.equal(read(S, 'taken.txt'), 'content of taken.txt', 'the occupant\'s bytes were replaced');
      assert.ok(await acts.conflicts.record(id), 'the conflict record was closed by a resolution that did not happen');
    });

    it('onto a directory (empty or not): the directory and what is in it are as they were', async () => {
      await acts.seed('keepdir/inner.txt');
      fs.mkdirSync(abs(S, 'emptydir'));
      for (const dst of ['keepdir', 'emptydir']) {
        const id = await conflict({ id: `dir-${dst}` });
        const before = await snapshot();
        const res = await acts.conflicts.resolve(id, 'keep-both', { rename: dst });
        REFUSED(res, dst);
        assert.deepEqual(await snapshot(), before, `a refused resolution onto the directory ${dst} changed something`);
      }
    });

    it('onto a live file record with no bytes here: refused, the record and the copy untouched', async () => {
      await recordOnly(S, 'ghost.txt');
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: 'ghost.txt' });
      REFUSED(res, 'ghost.txt');
      assert.deepEqual(await snapshot(), before);
    });

    it('control: a free destination is placed — the copy MOVES there (never copies), the record closes, and nothing is refused', async () => {
      const id = await conflict();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: 'fresh/dir/renamed.txt' });
      assert.equal(res.code, 200, sentence(res));
      assert.equal(res.body?.status, 'resolved');
      assert.notEqual(res.body?.resolved, 'nothing-to-place', 'a copy that was placed was reported as nothing to place');
      assert.equal(read(S, 'fresh/dir/renamed.txt'), `incoming ${COPY}`);
      assert.equal(has(S, COPY), false, 'the copy is still at its conflict name: it was copied, not moved');
      assert.equal(read(S, ORIGINAL), `local ${ORIGINAL}`, 'the local file changed');
      assert.equal(await acts.conflicts.record(id), null, 'the conflict record is still open');
    });
  });

  describe('save-to-space: bytes or a record at the destination in the target space is refused 409, and nothing moves', () => {
    it('onto bytes: the target\'s file, the copy and the conflict are as they were', async () => {
      await acts.seedIn(T, COPY);
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: T });
      assert.equal(res.code, 409, `answered ${res.code}: ${sentence(res)} — the copy replaced a file of the target space`);
      assert.equal(res.body?.code, 'destination_exists');
      assert.equal(res.body?.path, COPY);
      assert.deepEqual(await snapshot(), before);
      assert.equal(read(T, COPY), `content of ${COPY} in ${T}`, 'the target space\'s file was replaced');
    });

    it('onto a renamed destination that is bytes or a directory in the target space', async () => {
      await acts.seedIn(T, 'there/x.txt');
      for (const dst of ['there/x.txt', 'there']) {
        const id = await conflict({ id: `s2s-${dst}` });
        const before = await snapshot();
        const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: T, rename: dst });
        assert.equal(res.code, 409, `${dst}: answered ${res.code}: ${sentence(res)}`);
        assert.equal(res.body?.code, 'destination_exists');
        assert.deepEqual(await snapshot(), before, `a refused save onto ${dst} changed something`);
      }
    });

    it('onto a live record in the target space that has no bytes', async () => {
      await recordOnly(T, COPY);
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: T });
      assert.equal(res.code, 409, `answered ${res.code}: ${sentence(res)}`);
      assert.equal(res.body?.code, 'destination_exists');
      assert.deepEqual(await snapshot(), before);
    });

    it('control: a free destination in the target space — the copy moves there, the record closes', async () => {
      const id = await conflict();
      const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: T });
      assert.equal(res.code, 200, sentence(res));
      assert.equal(read(T, COPY), `incoming ${COPY}`);
      assert.equal(has(S, COPY), false, 'the copy is still in the conflict space');
      assert.equal(await acts.conflicts.record(id), null);
    });
  });

  describe('a rename through a file is answered, not a 500', () => {
    it('keep-both: 409 path_blocked, and the copy and the record stay', async () => {
      await acts.seed('a.txt');
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: 'a.txt/inside.txt' });
      assert.equal(res.code, 409, `answered ${res.code}: ${sentence(res)}`);
      assert.equal(res.body?.code, 'path_blocked');
      assert.deepEqual(await snapshot(), before);
    });

    it('save-to-space: 409 path_blocked in the target space too', async () => {
      await acts.seedIn(T, 'b.txt');
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: T, rename: 'b.txt/inside.txt' });
      assert.equal(res.code, 409, `answered ${res.code}: ${sentence(res)}`);
      assert.equal(res.body?.code, 'path_blocked');
      assert.deepEqual(await snapshot(), before);
    });
  });

  describe('paths are the sandbox\'s, on every action', () => {
    it('a rename that leaves the space is 400 and creates nothing', async () => {
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: '../escaped.txt' });
      assert.equal(res.code, 400, `answered ${res.code}: ${sentence(res)}`);
      assert.deepEqual(await snapshot(), before);
      assert.equal(fs.existsSync(path.join(acts.rootOf(S), '..', 'escaped.txt')), false, 'a file was created outside the space');
    });

    it('a rename through a link that leaves the space is 400 and writes nothing there', async () => {
      fs.symlinkSync(outside, abs(S, 'leaves'), 'junction');
      const id = await conflict();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: 'leaves/escaped.txt' });
      assert.equal(res.code, 400, `answered ${res.code}: ${sentence(res)} — a link on the way out of the space was followed`);
      assert.deepEqual(fs.readdirSync(outside), [], 'a file was written outside the space through the link');
      assert.ok(has(S, COPY), 'the copy left its place');
      assert.ok(await acts.conflicts.record(id), 'the record was closed');
    });

    for (const action of ['keep-local', 'keep-incoming', 'keep-both']) {
      it(`${action}: a conflict path that goes through a link out of the space is 400 and touches nothing outside it`, async () => {
        fs.symlinkSync(outside, abs(S, 'out'), 'junction');
        fs.writeFileSync(path.join(outside, 'victim.txt'), 'not the conflict\'s to delete');
        const id = await acts.conflicts.seed({ id: `link-${action}`, original: ORIGINAL, conflict: null });
        await acts.door.coll(S, 'conflicts').updateOne({ _id: id }, { $set: { conflictPath: 'out/victim.txt' } });
        const res = await acts.conflicts.resolve(id, action, action === 'keep-both' ? { rename: 'kept.txt' } : {});
        assert.equal(res.code, 400, `answered ${res.code}: ${sentence(res)}`);
        assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'not the conflict\'s to delete', 'a file outside the space was removed or replaced');
        assert.ok(await acts.conflicts.record(id), 'the record was closed');
      });
    }

    it('an instance-local destination (the conversion tree) is 400: a resolution does not place a user file where the pipeline writes', async () => {
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: '_converted/x.md' });
      assert.equal(res.code, 400, `answered ${res.code}: ${sentence(res)}`);
      assert.deepEqual(await snapshot(), before);
    });

    for (const [name, opts] of [['rename', { rename: 5 }], ['rename', { rename: ['a.txt'] }], ['targetSpaceId', { targetSpaceId: { $ne: '' } }], ['targetSpaceId', { targetSpaceId: 7 }]]) {
      it(`${name} that is not a string (${JSON.stringify(opts)}) is 400 on both doors and changes nothing`, async () => {
        const id = await conflict();
        const before = await snapshot();
        const action = name === 'rename' ? 'keep-both' : 'save-to-space';
        const single = await acts.conflicts.resolve(id, action, opts);
        assert.equal(single.code, 400, `single: answered ${single.code}: ${sentence(single)}`);
        const bulk = await acts.conflicts.bulk([id], action, opts);
        const rejected = bulk.code === 400 || (bulk.body?.resolved === 0 && bulk.body?.failed?.[0]?.status === 400);
        assert.ok(rejected, `bulk: not refused as a malformed request: ${bulk.code} ${sentence(bulk)}`);
        assert.deepEqual(await snapshot(), before);
      });
    }
  });

  describe('save-to-space is a write in the target space: files:write there, and a concrete target', () => {
    // A resolver that may resolve conflicts (data quality) in both spaces, and write files in the conflict's own — but only READ the target's.
    const rights = (targetFiles) => acts.conflicts.rightsFor({ [S]: { dataQuality: 'write', files: 'write' }, [T]: { dataQuality: 'write', files: targetFiles } });

    it('a token without files:write on the target is 403, and the answer is the same whether or not something stands at the destination', async () => {
      const seen = [];
      for (const occupied of [false, true]) {
        await beforeEachReset();
        if (occupied) await acts.seedIn(T, COPY);
        const id = await conflict();
        const before = await snapshot();
        const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: T, rights: rights('read') });
        assert.equal(res.code, 403, `answered ${res.code}: ${sentence(res)} — the copy was placed in a space the token may not write files in`);
        assert.deepEqual(await snapshot(), before, 'a refused resolution changed something');
        seen.push(answer(res));
      }
      assert.deepEqual(seen[1], seen[0], 'the refusal differs when something stands at the destination: a token without files:write learns what the target holds');
    });

    it('control: a token with files:write on the target places the copy', async () => {
      const id = await conflict();
      const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: T, rights: rights('write') });
      assert.equal(res.code, 200, sentence(res));
      assert.equal(read(T, COPY), `incoming ${COPY}`);
    });

    it('a proxy space is not a target: 400, and nothing moves', async () => {
      const id = await conflict();
      const before = await snapshot();
      const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: PROXY });
      assert.equal(res.code, 400, `answered ${res.code}: ${sentence(res)}`);
      assert.deepEqual(await snapshot(), before);
    });

    it('bulk: the same refusals, per item', async () => {
      const id = await conflict();
      const denied = await acts.conflicts.bulk([id], 'save-to-space', { targetSpaceId: T, rights: rights('read') });
      assert.ok(denied.code === 403 || denied.body?.failed?.[0]?.status === 403, `bulk without files:write on the target: ${denied.code} ${sentence(denied)}`);
      assert.ok(has(S, COPY) && !has(T, COPY), 'the copy was placed without files:write on the target');
      const proxied = await acts.conflicts.bulk([id], 'save-to-space', { targetSpaceId: PROXY });
      assert.ok(proxied.code === 400 || proxied.body?.failed?.[0]?.status === 400, `bulk onto a proxy: ${proxied.code} ${sentence(proxied)}`);
    });
  });

  /** The per-case reset, callable inside a case that needs two clean starts. */
  async function beforeEachReset() {
    for (const sp of [S, T]) {
      for (const part of ['files', 'file_tombstones', 'conflicts']) await acts.door.coll(sp, part).deleteMany({});
      fs.rmSync(acts.rootOf(sp), { recursive: true, force: true });
      fs.mkdirSync(acts.rootOf(sp), { recursive: true });
    }
  }

  describe('nothing to place closes the record: 200 with resolved: "nothing-to-place"', () => {
    const NOTHING = (res) => {
      assert.equal(res.code, 200, `answered ${res.code}: ${sentence(res)}`);
      assert.equal(res.body?.resolved, 'nothing-to-place', `the answer does not say nothing was placed: ${sentence(res)}`);
    };

    for (const [action, opts] of [['keep-both', { rename: 'wherever.txt' }], ['save-to-space', { targetSpaceId: T }], ['keep-incoming', {}]]) {
      it(`${action}: the incoming copy is already gone (a retry after a placement whose record delete failed) — the record closes and nothing is placed or replaced`, async () => {
        const id = await conflict({ conflict: null });
        const before = await snapshot();
        const res = await acts.conflicts.resolve(id, action, opts);
        NOTHING(res);
        assert.equal(await acts.conflicts.record(id), null, 'the record stayed open: the conflict can never be closed');
        const after = await snapshot();
        assert.deepEqual({ ...after, conflicts: [] }, { ...before, conflicts: [] }, 'a resolution with nothing to place changed a file');
        assert.equal(read(S, ORIGINAL), `local ${ORIGINAL}`, 'the local file was replaced by nothing');
      });
    }

    it('save-to-space into the conflict\'s own space at the same path: the copy stays, the record closes', async () => {
      const id = await conflict();
      const res = await acts.conflicts.resolve(id, 'save-to-space', { targetSpaceId: S });
      NOTHING(res);
      assert.equal(read(S, COPY), `incoming ${COPY}`, 'the copy was moved or replaced by the save to its own place');
      assert.equal(await acts.conflicts.record(id), null);
    });

    it('keep-both with a rename equal to the conflict path: the copy stays, the record closes', async () => {
      const id = await conflict();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: COPY });
      NOTHING(res);
      assert.equal(read(S, COPY), `incoming ${COPY}`);
      assert.equal(await acts.conflicts.record(id), null);
    });

    it('keep-both with no rename: both files stay and the record closes (unchanged)', async () => {
      const id = await conflict();
      const res = await acts.conflicts.resolve(id, 'keep-both');
      assert.equal(res.code, 200, sentence(res));
      assert.equal(read(S, COPY), `incoming ${COPY}`);
      assert.equal(read(S, ORIGINAL), `local ${ORIGINAL}`);
      assert.equal(await acts.conflicts.record(id), null);
    });
  });

  describe('a placement a crash left half done is finished, not refused against itself', () => {
    it('the copy and the destination are two names of one file (a crash between the link and the unlink): the retry completes it', async () => {
      const id = await conflict();
      fs.linkSync(abs(S, COPY), abs(S, 'half.txt'));
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: 'half.txt' });
      assert.equal(res.code, 200, `the retry of a half-made placement was refused: ${res.code} ${sentence(res)}`);
      assert.equal(has(S, COPY), false, 'the conflict name is still there: the placement was not finished');
      assert.equal(read(S, 'half.txt'), `incoming ${COPY}`);
      assert.equal(await acts.conflicts.record(id), null);
    });

    it('a case-only rename of the copy is one entry under two spellings: renamed, never refused as occupied (case-insensitive file systems only)', async (t) => {
      // A name has no second spelling on a case-sensitive file system, so the alias these cases exercise cannot exist there.
      if (!caseInsensitiveAt(acts.rootOf(S))) { t.skip('expected-in-ci: the file system is case-sensitive'); return; }
      const id = await conflict();
      const res = await acts.conflicts.resolve(id, 'keep-both', { rename: COPY.toUpperCase() });
      assert.equal(res.code, 200, `a case-only rename of the copy was refused: ${res.code} ${sentence(res)}`);
      assert.ok(fs.readdirSync(acts.rootOf(S)).includes(COPY.toUpperCase()), 'the copy is not under its new spelling');
      assert.equal(read(S, COPY.toUpperCase()), `incoming ${COPY}`);
      assert.equal(await acts.conflicts.record(id), null);
    });
  });

  describe('a failure is the file act\'s one answer, never the file system\'s own words', () => {
    /** Make every `mkdir`, `rename` and `link` that names a path under `marker` fail as the file system fails: with a message that names the absolute path. */
    function fileSystemRefuses(marker) {
      const names = ['mkdir', 'rename', 'link', 'copyFile', 'writeFile'];
      const real = Object.fromEntries(names.map(n => [n, fsp[n]]));
      const hits = { n: 0 };
      for (const n of names) {
        fsp[n] = async function refuses(...args) {
          if (args.some(a => typeof a === 'string' && a.includes(marker))) {
            hits.n += 1;
            throw Object.assign(new Error(`EACCES: permission denied, ${n} '${args.find(a => typeof a === 'string' && a.includes(marker))}'`), { code: 'EACCES', syscall: n });
          }
          return real[n].apply(this, args);
        };
      }
      return { hits, restore: () => { for (const n of names) fsp[n] = real[n]; } };
    }
    const leaks = (text) => [process.env['DATA_ROOT'], 'permission denied', 'locked-dir'].filter(w => w && text.includes(w));

    it('single: a destination the file system refuses is 500 file_system_fault in words that name no path', async () => {
      const id = await conflict();
      const fault = fileSystemRefuses('locked-dir');
      let res;
      try { res = await acts.conflicts.resolve(id, 'keep-both', { rename: 'locked-dir/x.txt' }); } finally { fault.restore(); }
      assert.ok(fault.hits.n > 0, 'the fault was never reached: the case is not the one it is about');
      assert.equal(res.code, 500, `answered ${res.code}: ${sentence(res)}`);
      assert.equal(res.body?.code, 'file_system_fault');
      assert.deepEqual(leaks(sentence(res)), [], `the answer names what only the server should know: ${sentence(res)}`);
      assert.ok(has(S, COPY) && await acts.conflicts.record(id), 'a failed resolution moved the copy or closed the record');
    });

    it('bulk: each failed item is { id, error, code, status, path } — a refusal carries its code and status, and none carries the raw message', async () => {
      await acts.seedIn(T, 'taken-in-target.txt');
      const free = await conflict({ id: 'bulk-free', conflict: 'free.conflict.txt' });
      const taken = await conflict({ id: 'bulk-taken', conflict: 'taken-in-target.txt' });
      const res = await acts.conflicts.bulk([free, taken, 'no-such-conflict'], 'save-to-space', { targetSpaceId: T });
      assert.equal(res.code, 200, sentence(res));
      assert.equal(res.body.resolved, 1, sentence(res));
      const byId = Object.fromEntries(res.body.failed.map(f => [f.id, f]));
      assert.deepEqual(Object.keys(byId).sort(), ['bulk-taken', 'no-such-conflict'], sentence(res));
      assert.equal(byId['bulk-taken'].code, 'destination_exists', sentence(res));
      assert.equal(byId['bulk-taken'].status, 409);
      assert.equal(byId['bulk-taken'].path, 'taken-in-target.txt');
      assert.equal(typeof byId['bulk-taken'].error, 'string');
      assert.equal(typeof byId['no-such-conflict'].error, 'string');
      assert.equal(read(T, 'taken-in-target.txt'), `content of taken-in-target.txt in ${T}`, 'the occupant was replaced');
    });

    it('bulk: a failure that is not a refusal is the file-system-fault sentence, with its code, never err.message', async () => {
      const id = await conflict();
      const fault = fileSystemRefuses('locked-dir');
      let res;
      try { res = await acts.conflicts.bulk([id], 'keep-both', { rename: 'locked-dir/x.txt' }); } finally { fault.restore(); }
      assert.ok(fault.hits.n > 0, 'the fault was never reached: the case is not the one it is about');
      assert.equal(res.body?.resolved, 0, sentence(res));
      const [item] = res.body.failed;
      assert.equal(item.code, 'file_system_fault', `the failed item has no file act code: ${JSON.stringify(item)}`);
      assert.equal(item.status, 500);
      assert.deepEqual(leaks(JSON.stringify(item)), [], `the failed item carries the file system's own words: ${JSON.stringify(item)}`);
    });
  });
});
