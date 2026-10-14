/**
 * `delete_file` deletes a directory exactly as `DELETE /api/files/:spaceId` does, on every door (Q-438, bundle-44 D-29).
 *
 * ## The report
 *
 * The REST route deleted a directory tree given `confirm: true`; the MCP tool refused to ("not the tool for removing a
 * directory tree") and its schema rejected `confirm`, while `POST /api/delete_file` is that same tool. A caller who
 * picked a different client got a different act, and the sentence that told them so lived in a description, not in the code.
 *
 * ## What it holds
 *
 * Three doors, one act: the file router's `DELETE` handler, `POST /api/delete_file` and MCP `delete_file`. For each, and
 * equal across the three by value:
 *
 *  - a directory without `confirm` is `422 confirm_required` and nothing changes (the tree, every record, the links, the
 *    tombstones);
 *  - with `confirm: true` the tree, its records, its conversion sidecars and their records go, and the same tombstones are
 *    PUBLISHED (served to a peer and pushed to one);
 *  - the space root is `400 space_root_refused` with `confirm`, and `422` without it, never deleted;
 *  - a single file is unchanged by `confirm`; a path that is not there is `404` with or without it; a directory whose tree a
 *    failure removed and whose records remain is completed only by a confirmed delete;
 *  - a `confirm` that is not a boolean is `400` and deletes nothing;
 *  - a path the file system refuses to look at is `500 file_system_fault` in words that name no path, and a path that cannot
 *    exist (a name too long, a loop of links) is `404`, not a refusal about creating it;
 *  - the audit entry of a directory delete carries `kind: directory`, once per call, on both audited doors;
 *  - (Q-464) a delete removes the links THIS instance wrote from the file and from its derived ids, on every door and the TTL sweep, and
 *    tells peers; a link another instance wrote stays; a removal that stopped part way keeps the links of the files still there; a
 *    failure in the link step leaves the delete owed, and its retry completes it.
 *
 * The comparison between doors is by value over the same scenario, never by two doors each checked against a literal that
 * could be wrong the same way.
 *
 * Run: node --test testing/standalone/a-directory-delete-is-the-same-act-on-every-door-db.test.js
 * (requires the harness Mongo and a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'dirdeldoors';
const DOORS = ['REST', 'TOOL', 'MCP'];
let acts, ttl, F, faults;
const files = () => acts.door.coll(S, 'files');
const abs = (p) => path.join(acts.root(), p);

/** One delete through `via`; `confirm` is the same argument on every door, left out when `undefined`. */
const del = (via, p, confirm) => via === 'REST' ? acts.rest('DELETE', { path: p }, confirm === undefined ? {} : { confirm })
  : via === 'TOOL' ? acts.tool('delete_file', { path: p, ...(confirm === undefined ? {} : { confirm }) })
  : acts.mcp('delete_file', { path: p, ...(confirm === undefined ? {} : { confirm }) });

/** The sentence a door answered a failure with, whatever its envelope. */
const sentenceOf = (a) => ('code' in a ? (a.body?.data?.error ?? a.body?.error) : (a.sc?.error ?? a.text));

/** Every relative path under `dir`, directories with a trailing slash, sorted. */
function treeOf(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(e.isDirectory() ? `${r}/` : r);
    if (e.isDirectory()) out.push(...treeOf(dir, r));
  }
  return out.sort();
}

/** Everything a delete could change: the tree, and every collection a file act writes. */
async function snapshot() {
  const parts = {};
  for (const part of ['files', 'links', 'media_jobs', 'file_tombstones']) parts[part] = await acts.door.coll(S, part).find({}).sort({ _id: 1 }).toArray();
  return { parts, tree: treeOf(acts.root()) };
}

/** A directory `d` holding two files, a converted file with its sidecar and a derived row, as production lays one out. */
async function seedTree() {
  await acts.seed('d/a.txt');
  await acts.seed('d/sub/b.txt');
  await acts.seed('d/c.pdf');
  await acts.seed('_converted/d/c.pdf.md', { parentFileId: 'd/c.pdf' });
  await files().insertOne({ _id: 'd/a.txt#chunk-0', spaceId: S, path: 'd/a.txt#chunk-0', parentFileId: 'd/a.txt', content: 'c', tags: [],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 1 });
  await acts.door.coll(S, 'links').insertOne({ _id: 'l1', spaceId: S, from: 'd/a.txt', fromKind: 'file', to: 'e1', toKind: 'entity',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', seq: 1 });
}

/** Make `fsp.stat` of exactly `target` fail with `code`; the returned function restores it. */
function statFailsAt(target, code) {
  const real = fsp.stat;
  fsp.stat = async function refuse(p, ...rest) {
    if (String(p) === target) throw Object.assign(new Error(`${code}: ${target}`), { code });
    return real.call(this, p, ...rest);
  };
  return () => { fsp.stat = real; };
}

const EVERY_TOMBSTONE = ['_converted/d/c.pdf.md', 'd/a.txt', 'd/c.pdf', 'd/sub/b.txt'];

describe('delete_file deletes a directory with confirm, as the same act on every door (Q-438)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'dirdeldoors', space: S });
    F = await driverWriteFailures('ythril_harness_dirdeldoors');
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteOne', 'deleteMany']);
  });
  after(async () => { faults?.restore(); await acts?.close(); });
  beforeEach(async () => {
    faults.clear();
    await acts.reset();
    for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
    await acts.door.mongo.getDb().collection('audit_log').deleteMany({ spaceId: S });
  });

  for (const via of DOORS) {
    describe(via, () => {
      it('a directory without confirm is 422 confirm_required and nothing changes', async () => {
        await seedTree();
        const before = await snapshot();
        const a = await del(via, 'd');
        assert.deepEqual({ ...acts.answerOf(a), retryable: undefined, retryAfter: undefined }, { status: 422, code: 'confirm_required', path: 'd', retryable: undefined, retryAfter: undefined });
        assert.match(sentenceOf(a), /confirm: true/);
        assert.deepEqual(await snapshot(), before, 'a refused delete changed the tree, a record, a link or a tombstone');
      });

      it('with confirm the tree, its records and its sidecars go, and a tombstone per file is published', async () => {
        await seedTree();
        const a = await del(via, 'd', true);
        assert.ok(!acts.failed(a), JSON.stringify(a.body ?? a.sc ?? a.text));
        const left = treeOf(acts.root());
        assert.deepEqual(left.filter(p => !p.endsWith('/')), [], 'a file of the tree or of its sidecars outlived the delete');
        assert.ok(!left.includes('d/') && !left.includes('_converted/d/'), `the directory or its converted tree is still there: ${left}`);
        assert.deepEqual(await files().find({}).toArray(), [], 'a record of the tree, a derived row or a sidecar row outlived the delete');
        assert.deepEqual(await acts.links.ids(), [], 'a link from a file of the tree (a row with no author is this instance\'s) outlived the delete');
        assert.deepEqual(await acts.published(), { served: EVERY_TOMBSTONE, pushed: EVERY_TOMBSTONE });
      });

      it('the space root is 400 space_root_refused with confirm and 422 without it, and nothing is deleted', async () => {
        await acts.seed('keep.txt');
        const before = await snapshot();
        for (const p of ['.', '/']) {
          const refused = acts.answerOf(await del(via, p, true));
          assert.equal(refused.status, 400, `root '${p}' with confirm`);
          assert.equal(refused.code, 'space_root_refused');
          assert.equal(refused.path, p);
          const unconfirmed = acts.answerOf(await del(via, p));
          assert.equal(unconfirmed.status, 422, `root '${p}' without confirm`);
          assert.equal(unconfirmed.code, 'confirm_required');
        }
        assert.deepEqual(await snapshot(), before);
      });

      it('a single file is deleted as before whether or not confirm is given, and a path that is not there is 404 either way', async () => {
        await acts.seed('f.txt');
        assert.ok(!acts.failed(await del(via, 'f.txt', true)));
        assert.deepEqual((await acts.published()).served, ['f.txt']);
        assert.equal(acts.answerOf(await del(via, 'f.txt')).status, 404, 'a repeat of a delete that completed');
        assert.equal(acts.answerOf(await del(via, 'f.txt', true)).status, 404);
        assert.equal(acts.answerOf(await del(via, 'nothing/here')).status, 404);
        assert.equal(acts.answerOf(await del(via, 'nothing/here', true)).status, 404);
      });

      it('a directory whose tree a failure removed and whose records remain is completed by a confirmed delete only', async () => {
        await acts.seed('g/x.txt');
        fs.rmSync(abs('g'), { recursive: true });
        assert.equal(acts.answerOf(await del(via, 'g')).status, 404);
        assert.equal(await files().countDocuments({ _id: /^g\// }), 1, 'the unconfirmed delete touched the records');
        const done = await del(via, 'g', true);
        assert.ok(!acts.failed(done), JSON.stringify(done.body ?? done.sc ?? done.text));
        assert.equal(await files().countDocuments({ _id: /^g\// }), 0);
        assert.deepEqual((await acts.published()).served, ['g/x.txt']);
      });

      for (const bad of ['true', 1, 'yes', null]) {
        it(`confirm: ${JSON.stringify(bad)} is 400, says confirm must be a boolean, and deletes nothing`, async () => {
          await seedTree();
          const before = await snapshot();
          const a = await del(via, 'd', bad);
          assert.equal(acts.answerOf(a).status, 400);
          // The status alone is not the rule: a door that does not know the parameter at all also answers 400.
          assert.match(sentenceOf(a), /confirm\W+(?:must be|is)\s+(?:a\s+)?boolean/i);
          assert.deepEqual(await snapshot(), before);
        });
      }

      it('a path the file system refuses to look at is 500 file_system_fault in words that name no path', async () => {
        await acts.seed('locked/x.txt');
        const before = await snapshot();
        const restore = statFailsAt(abs('locked'), 'EACCES');
        let a;
        try { a = await del(via, 'locked', true); } finally { restore(); }
        const answer = acts.answerOf(a);
        assert.equal(answer.status, 500);
        assert.equal(answer.code, 'file_system_fault');
        const said = JSON.stringify(a.body ?? a.sc) + sentenceOf(a);
        assert.ok(!said.includes(process.env['DATA_ROOT']), `the answer names the data root: ${said}`);
        assert.ok(!said.includes('locked'), `the answer names the path it could not look at: ${said}`);
        assert.deepEqual(await snapshot(), before);
      });

      for (const code of ['ENAMETOOLONG', 'ELOOP', 'ENOTDIR']) {
        it(`a path that cannot exist (${code}) is 404 not found, never a refusal about creating it`, async () => {
          const restore = statFailsAt(abs('nowhere'), code);
          let a;
          try { a = await del(via, 'nowhere', true); } finally { restore(); }
          assert.equal(acts.answerOf(a).status, 404, JSON.stringify(a.body ?? a.sc ?? a.text));
          assert.ok(!/cannot be created/.test(JSON.stringify(a.body ?? a.sc) + sentenceOf(a)));
        });
      }
    });
  }

  describe('across the doors', () => {
    /** What one door observes of the same four situations, for comparison with the others. */
    async function observe(via) {
      await acts.reset();
      for (const part of ['links', 'media_jobs', 'tombstones']) await acts.door.coll(S, part).deleteMany({});
      await seedTree();
      await acts.seed('locked/x.txt');
      const view = (a) => ({ ...acts.answerOf(a), sentence: acts.failed(a) ? sentenceOf(a) : undefined });
      const out = {
        withoutConfirm: view(await del(via, 'd')),
        root: view(await del(via, '.', true)),
        rootWithoutConfirm: view(await del(via, '/')),
        notABoolean: acts.answerOf(await del(via, 'd', 'true')).status,
      };
      const restore = statFailsAt(abs('locked'), 'EACCES');
      try { out.unreadable = view(await del(via, 'locked', true)); } finally { restore(); }
      const confirmed = await del(via, 'd', true);
      out.confirmed = { failed: acts.failed(confirmed), published: await acts.published(), left: treeOf(acts.root()),
        links: await acts.links.ids(), linkTombstones: await acts.links.tombstoned() };
      return out;
    }

    it('answer the same refusals with the same status, code, path and sentence, and publish the same tombstones', async () => {
      const seen = {};
      for (const via of DOORS) seen[via] = await observe(via);
      assert.equal(seen.REST.withoutConfirm.code, 'confirm_required', 'the scenario did not reach the refusal it compares');
      assert.equal(seen.REST.confirmed.failed, false);
      assert.deepEqual(seen.REST.confirmed.links, [], 'the links of the deleted files outlived the delete');
      assert.deepEqual(seen.REST.confirmed.linkTombstones, ['l1'], 'the link of the deleted tree was removed without a tombstone');
      for (const via of ['TOOL', 'MCP']) assert.deepEqual(seen[via], seen.REST, `${via} answered differently from REST`);
    });
  });

  // ── The links a delete removes (Q-464) ──────────────────────────────────────────────────────────────────────────────

  /**
   * A delete removes the links THIS instance wrote from the file and from its derived ids (`path#chunk-0`), on every door that
   * deletes — REST, `POST /api/delete_file`, MCP and the TTL sweep — and tells peers (a link tombstone per row removed). A link another
   * instance wrote stays: the file's tombstone does not carry it, and removing it here would be one instance deciding for another (ADR 05).
   * What is named in a case is derived from the doors, never from a count: a link row is judged by whose it is.
   */
  describe('a delete removes the links this instance wrote from the file and from its derived ids (Q-464)', () => {
    /** A derived row of `p` — what a conversion leaves, and what a link can start from — with the bytes of nothing. */
    const derivedOf = (p) => files().insertOne({ _id: `${p}#chunk-0`, spaceId: S, path: `${p}#chunk-0`, parentFileId: p, content: 'c', tags: [],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 1 });

    for (const via of [...DOORS, 'TTL sweep']) {
      it(`${via}: a file's own links go, from the file and from its derived id; another instance's stay; one tombstone per link removed`, async () => {
        await acts.seed('f/a.txt', via === 'TTL sweep' ? { _expireAt: new Date('2026-01-01T00:00:00Z') } : {});
        await derivedOf('f/a.txt');
        // Near names, which are other files: the selector is "this path and its derived ids", never a prefix of the text.
        await acts.seed('f/a.txt.bak');
        await acts.seed('f/b.txt');
        const own = [await acts.links.put('f/a.txt', 'e1', 'self'), await acts.links.put('f/a.txt', 'e2', 'none'), await acts.links.put('f/a.txt#chunk-0', 'e1', 'self')];
        const theirs = [await acts.links.put('f/a.txt', 'e3', 'peer'), await acts.links.put('f/a.txt#chunk-0', 'e3', 'peer')];
        const others = [await acts.links.put('f/a.txt.bak', 'e1', 'self'), await acts.links.put('f/b.txt', 'e1', 'self')];

        if (via === 'TTL sweep') await ttl.sweepExpired(new Date());
        else { const a = await del(via, 'f/a.txt'); assert.ok(!acts.failed(a), JSON.stringify(a.body ?? a.sc ?? a.text)); }

        assert.equal(acts.onDisk('f/a.txt'), false, 'fixture: the file was not deleted');
        assert.deepEqual(await acts.links.idsUnder('f/a.txt'), [...theirs].sort(),
          'the links this instance wrote are still held against a file that is gone (they would be inherited by whatever is uploaded at the path), or a link another instance wrote was removed');
        assert.deepEqual(await acts.links.idsFrom('f/a.txt.bak', 'f/b.txt'), [...others].sort(), 'a link of ANOTHER file was removed: the selector is a prefix of text');
        assert.deepEqual(await acts.links.tombstoned(), [...own].sort(), 'a link was removed without its tombstone (peers keep it), or a tombstone was written for a link that stayed');
      });
    }

    for (const via of DOORS) {
      it(`${via}: a directory delete removes the links of every file under it and of their derived ids, and only the ones this instance wrote`, async () => {
        await seedTree();
        await derivedOf('d/sub/b.txt');
        // Near names: a sibling directory sharing the text, and a file named like the directory.
        await acts.seed('dx/keep.txt');
        await acts.seed('d.txt');
        await acts.door.coll(S, 'links').deleteMany({});
        const own = [await acts.links.put('d/a.txt', 'e1', 'self'), await acts.links.put('d/sub/b.txt', 'e1', 'self'), await acts.links.put('d/sub/b.txt', 'e2', 'none'),
          await acts.links.put('d/a.txt#chunk-0', 'e1', 'self'), await acts.links.put('d/sub/b.txt#chunk-0', 'e1', 'self')];
        const theirs = [await acts.links.put('d/sub/b.txt', 'e3', 'peer'), await acts.links.put('d/c.pdf', 'e3', 'peer')];
        const others = [await acts.links.put('dx/keep.txt', 'e1', 'self'), await acts.links.put('d.txt', 'e1', 'self')];

        const a = await del(via, 'd', true);
        assert.ok(!acts.failed(a), JSON.stringify(a.body ?? a.sc ?? a.text));

        assert.equal(acts.onDisk('d'), false, 'fixture: the directory was not deleted');
        assert.deepEqual(await acts.links.idsUnder('d'), [...theirs].sort(),
          'links this instance wrote are still held against files that are gone, or a link another instance wrote was removed');
        assert.deepEqual(await acts.links.idsFrom('dx/keep.txt', 'd.txt'), [...others].sort(), 'a link of a file outside the directory was removed');
        assert.deepEqual(await acts.links.tombstoned(), [...own].sort(), 'a removed link has no tombstone, or one was written for a link that stayed');
      });
    }

    it('a directory delete a failure stopped part way keeps the links of the files still there; its retry removes every one this instance wrote', async () => {
      await seedTree();
      await acts.door.coll(S, 'links').deleteMany({});
      const gone = await acts.links.put('d/a.txt', 'e1', 'self');
      const stayed = [await acts.links.put('d/sub/b.txt', 'e1', 'self'), await acts.links.put('d/c.pdf', 'e1', 'self')];
      const theirs = await acts.links.put('d/sub/b.txt', 'e3', 'peer');
      // The tree removal stops after taking ONE file: `d/a.txt` is gone from disk, the other files of the directory are still there.
      const real = fsp.rm;
      fsp.rm = async function stopsPartWay(p, ...rest) {
        if (String(p) === abs('d')) {
          await real.call(this, abs('d/a.txt'), { force: true });
          throw Object.assign(new Error('EACCES: permission denied, rmdir'), { code: 'EACCES' });
        }
        return real.call(this, p, ...rest);
      };
      let first;
      try { first = await acts.rest('DELETE', { path: 'd' }, { confirm: true }); } finally { fsp.rm = real; }
      assert.ok(acts.failed(first), 'fixture: the delete the removal stopped was answered as done');
      assert.ok(acts.onDisk('d/sub/b.txt') && acts.onDisk('d/c.pdf') && !acts.onDisk('d/a.txt'), 'fixture: the removal did not stop part way');
      const held = await acts.links.idsFrom('d/sub/b.txt', 'd/c.pdf');
      assert.deepEqual(held, [...stayed, theirs].sort(), 'a link of a file that is still there was removed by a delete that did not remove the file');

      const retry = await acts.rest('DELETE', { path: 'd' }, { confirm: true });
      assert.ok(!acts.failed(retry), JSON.stringify(retry.body));
      assert.deepEqual(await acts.links.idsUnder('d'), [theirs], 'the retry left a link this instance wrote (the file that went first included), or removed another instance\'s');
      assert.deepEqual(await acts.links.tombstoned(), [gone, ...stayed].sort(), 'the links the two attempts removed are not all tombstoned');
    });

    describe('a failure in the link step leaves the delete owed: the row is what finds it, and the retry completes it', () => {
      const LINKS = `${S}_links`;
      for (const via of DOORS) {
        it(`${via}: a file — 503 with the file's row kept, then the retry removes the links, the row and tells peers once`, async () => {
          await acts.seed('r/one.txt');
          const own = [await acts.links.put('r/one.txt', 'e1', 'self'), await acts.links.put('r/one.txt#chunk-0', 'e1', 'self')];
          faults.fail('deleteMany', LINKS, F.storeGone.single);

          const first = await del(via, 'r/one.txt');
          assert.equal(faults.fired('deleteMany', LINKS), 1, 'the delete never removed a link row: the case did not reach the step it is about');
          assert.equal(acts.statusOf(first), 503, `a delete whose link step failed was answered ${acts.statusOf(first)}: it must fail with the store's failure, never log and go on`);
          assert.ok(await files().findOne({ _id: 'r/one.txt' }), 'the row of the file is gone: nothing finds the delete still owed (the retry answers not found)');
          faults.clear();

          const retry = await del(via, 'r/one.txt');
          assert.ok(!acts.failed(retry), `the retry of a delete whose link step failed was refused (${acts.statusOf(retry)}): ${JSON.stringify(retry.body ?? retry.sc ?? retry.text)}`);
          assert.deepEqual(await acts.links.idsUnder('r/one.txt'), []);
          assert.deepEqual(await acts.links.tombstoned(), [...own].sort());
          assert.equal(await files().findOne({ _id: 'r/one.txt' }), null, 'the row outlived the completed delete');
          assert.deepEqual((await acts.published()).served, ['r/one.txt'], 'peers are not told of the file exactly once');
        });

        it(`${via}: a directory — 503 with the rows kept, then the retry completes it`, async () => {
          await acts.seed('r/dir/a.txt');
          await acts.seed('r/dir/b.txt');
          const own = [await acts.links.put('r/dir/a.txt', 'e1', 'self'), await acts.links.put('r/dir/b.txt', 'e1', 'self')];
          faults.fail('deleteMany', LINKS, F.storeGone.single);

          const first = await del(via, 'r/dir', true);
          assert.equal(faults.fired('deleteMany', LINKS), 1, 'the delete never removed a link row: the case did not reach the step it is about');
          assert.equal(acts.statusOf(first), 503, `a directory delete whose link step failed was answered ${acts.statusOf(first)}`);
          assert.equal(await files().countDocuments({ _id: /^r\/dir\// }), 2, 'the rows of the directory are gone: nothing finds the delete still owed');
          faults.clear();

          const retry = await del(via, 'r/dir', true);
          assert.ok(!acts.failed(retry), `the retry was refused (${acts.statusOf(retry)}): ${JSON.stringify(retry.body ?? retry.sc ?? retry.text)}`);
          assert.deepEqual(await acts.links.idsUnder('r/dir'), []);
          assert.deepEqual(await acts.links.tombstoned(), [...own].sort());
          assert.equal(await files().countDocuments({ _id: /^r\/dir\// }), 0);
        });
      }
    });
  });

  describe('the audit entry of a directory delete', () => {
    const entries = () => acts.door.mongo.getDb().collection('audit_log').find({ spaceId: S, operation: 'file.delete' }).toArray();

    for (const via of ['TOOL', 'MCP']) {
      it(`${via}: carries kind: directory, once for the call; a single file carries no change list`, async () => {
        await seedTree();
        await acts.seed('one.txt');
        assert.ok(!acts.failed(await del(via, 'd', true)));
        await waitFor(async () => (await entries()).length === 1, 10_000, 100, 'no audit entry for the directory delete', { what: 'the audit entry' });
        const [entry] = await entries();
        assert.deepEqual(entry.changes, [{ field: 'kind', to: 'directory' }]);
        assert.ok(!acts.failed(await del(via, 'one.txt')));
        await waitFor(async () => (await entries()).length === 2, 10_000, 100, 'no audit entry for the file delete', { what: 'the audit entry' });
        const single = (await entries()).find(e => e._id !== entry._id);
        assert.equal(single.changes, undefined, 'a single file delete records a change list: it records nothing');
      });
    }

    it('REST: the route hands the audit middleware the same pair, and a refused or single-file delete hands it none', async () => {
      const { fileStoreRouter } = await import('../../server/dist/api/files.js');
      const { auditChanges } = await import('../../server/dist/audit/audit-changes.js');
      const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['delete']);
      const handle = layer.route.stack.at(-1).handle;
      const call = async (p, body) => {
        const req = { method: 'DELETE', params: { spaceId: S }, query: { path: p }, body, authToken: { name: 'test' }, get: () => undefined, headers: {} };
        const res = { code: 200, headersSent: false, status(c) { this.code = c; return this; }, setHeader() { return this; },
          json() { this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
        await handle(req, res);
        return { req, res };
      };
      await seedTree();
      await acts.seed('one.txt');
      const refused = await call('d', {});
      assert.equal(refused.res.code, 422);
      assert.equal(refused.req.auditSnapshots, undefined);
      const done = await call('d', { confirm: true });
      assert.equal(done.res.code, 204);
      assert.deepEqual(auditChanges('file.delete', done.req.auditSnapshots?.before, done.req.auditSnapshots?.after), [{ field: 'kind', to: 'directory' }]);
      const single = await call('one.txt', {});
      assert.equal(single.res.code, 204);
      assert.equal(single.req.auditSnapshots, undefined);
    });
  });
});
