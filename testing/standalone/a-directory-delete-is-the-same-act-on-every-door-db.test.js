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
 *  - the audit entry of a directory delete carries `kind: directory`, once per call, on both audited doors.
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
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'dirdeldoors';
const DOORS = ['REST', 'TOOL', 'MCP'];
let acts;
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
  before(async () => { acts = await openFileActDoors({ suite: 'dirdeldoors', space: S }); });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
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
        assert.ok(!/EACCES/.test(said), `the answer carries the file system's own words: ${said}`);
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
      for (const part of ['links', 'media_jobs']) await acts.door.coll(S, part).deleteMany({});
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
      out.confirmed = { failed: acts.failed(confirmed), published: await acts.published(), left: treeOf(acts.root()) };
      return out;
    }

    it('answer the same refusals with the same status, code, path and sentence, and publish the same tombstones', async () => {
      const seen = {};
      for (const via of DOORS) seen[via] = await observe(via);
      assert.equal(seen.REST.withoutConfirm.code, 'confirm_required', 'the scenario did not reach the refusal it compares');
      assert.equal(seen.REST.confirmed.failed, false);
      for (const via of ['TOOL', 'MCP']) assert.deepEqual(seen[via], seen.REST, `${via} answered differently from REST`);
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
