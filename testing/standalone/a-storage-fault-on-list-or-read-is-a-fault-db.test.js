/**
 * A storage fault while LISTING or READING a file is a fault, not an empty listing or a missing file, on every door (bundle-62, Q-538).
 *
 * ## The defect
 *
 * `list_dir` (MCP and `POST /api/list_dir`), the REST listing and MCP `read_file` caught EVERY error from the file system and read it as
 * "nothing here": a disk that answered EIO or EACCES was an empty listing, a `File not found`, a `404`, and a client could not tell an empty
 * folder from a broken one. `isMissingPath` (ENOENT, ENOTDIR) is the one rule for absent; everything else is the server's fault,
 * answered `500 file_system_fault`, `retryable: false`, naming no path, as every file act already answers it (6.0.0).
 *
 * ## The rule, over every door that lists or reads
 *
 *  - an `EIO` or `EACCES` from `readdir` under a SUBDIRECTORY of the space root, from the `stat` the REST listing's `heldEntryOf` makes, or from
 *    the open the read makes: `500`, `code: 'file_system_fault'`, `retryable: false`, and neither the errno's message, its path nor the data root;
 *  - rows that KEEP their answer: an absent path (empty listing / `404` / `File not found`), `ENOTDIR` through a file, `EISDIR` (a read of a real
 *    directory), `ENAMETOOLONG` (a component over 255 characters), a traversal path (`RequestRefusal`), and ONE unreadable ENTRY of a listing
 *    (the listing stays, that entry without its size).
 *
 * The doors are the real handlers (`_file-act-doors.mjs`, plus the file router's own GET); injection patches the shared `fs/promises` default object
 * as `a-destination-blocked-by-a-file-is-refused-alike-db.test.js` does, counts that the stub fired and restores it in a `finally`.
 *
 * Not covered here, named: a retired MEMBER space of a personal view (`SpaceRetired` skips the member as today) needs a view fixture; it is
 * held by the new module's own test when `listAcrossMembers` exists.
 *
 * Red against 0ac12bdd: list and MCP read answer an empty listing / `File not found` for the injected fault.
 *
 * Run: node --test testing/standalone/a-storage-fault-on-list-or-read-is-a-fault-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'listfault';
const POISON = 'poison-q538-4c1e';
const POISON_PATH = `/srv/${POISON}/data/files/${S}/x`;

let acts, getHandler;

/** One door's answer, whichever door: status, code, path, retryable, the text a client reads, and every byte of the wire. */
function normalised(a) {
  if ('code' in a) {   // REST (the file router, or POST /api/<tool>): the body, or its `data` for a tool
    const b = a.body ?? {};
    const d = b.data ?? b;
    return { status: a.code, code: d.code, path: d.path, retryable: d.retryable, text: JSON.stringify(b), wire: JSON.stringify({ body: b, headers: a.headers }) };
  }
  return { status: a.status, code: a.sc?.code, path: a.sc?.path, retryable: a.sc?.retryable, text: a.text, wire: JSON.stringify({ text: a.text, sc: a.sc }) };
}

/** The GET `/:spaceId` handler of the file router: a directory lists, a file streams (a path that is neither is a 404). */
async function restGet(p) {
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  const req = { method: 'GET', params: { spaceId: S }, query: p === undefined ? {} : { path: p }, headers: {}, ip: '127.0.0.1',
    authToken: { id: 't', name: 'test', rights: ADMIN }, get: () => undefined };
  const res = { code: 200, body: undefined, headers: {}, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; }, on() { return this; }, once() { return this; }, emit() { return false; } };
  // An error the handler lets escape reaches the application's last-resort handler (a bare 500 with no code, the words `app.ts` gives any
  // uncaught error): read here as exactly that, so a row says "the handler threw" rather than the harness dying.
  try { await getHandler(req, res); } catch (err) {
    return { code: 500, body: { error: 'Internal server error', escaped: String(err instanceof Error ? err.message : err).slice(0, 80) }, headers: {} };
  }
  return res;
}

/** Every door that LISTS a directory: `run(p)` asks for the listing of `p` and answers normalised. */
const LIST_DOORS = () => [
  { name: 'MCP list_dir', run: async (p) => normalised(await acts.mcp('list_dir', { path: p })) },
  { name: 'POST /api/list_dir', run: async (p) => normalised(await acts.tool('list_dir', { path: p })) },
  { name: 'REST GET /api/files (a directory)', rest: true, run: async (p) => normalised(await restGet(p)) },
];
/** Every door that READS a file. */
const READ_DOORS = () => [
  { name: 'MCP read_file', run: async (p) => normalised(await acts.mcp('read_file', { path: p })) },
  { name: 'POST /api/read_file', run: async (p) => normalised(await acts.tool('read_file', { path: p })) },
  { name: 'REST GET /api/files (a file)', rest: true, run: async (p) => normalised(await restGet(p)) },
];

/** Patch `fsp[fn]` so a call whose first argument lies UNDER the space's files root throws `code` carrying the poison; the stub counts its firing. */
function injectFault(fn, code) {
  const real = fsp[fn];
  const state = { fired: 0 };
  const root = path.resolve(acts.root());
  fsp[fn] = async function injected(...args) {
    const target = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
    if (target.startsWith(root + path.sep)) {
      state.fired += 1;
      throw Object.assign(new Error(`${code}: injected, ${fn} '${POISON_PATH}'`), { code, errno: code === 'EIO' ? -5 : -13, syscall: fn, path: POISON_PATH });
    }
    return real.apply(this, args);
  };
  return { state, restore: () => { fsp[fn] = real; } };
}

/** Run `ask` with the fault in place; the stub must have fired, or the row tested nothing. */
async function underFault(fn, code, ask) {
  const stub = injectFault(fn, code);
  let a;
  try { a = await ask(); } finally { stub.restore(); }
  assert.ok(stub.state.fired > 0, `the injected ${code} on ${fn} never fired: the door does not reach it, so the row tested nothing`);
  return a;
}

function assertFault(door, a) {
  assert.equal(a.status, 500, `${door}: a storage fault answered ${a.status}, not 500 — ${a.wire.slice(0, 300)}`);
  assert.equal(a.code, 'file_system_fault', `${door}: the answer carries code ${JSON.stringify(a.code)}, not 'file_system_fault' — ${a.wire.slice(0, 300)}`);
  assert.equal(a.retryable, false, `${door}: retryable is ${JSON.stringify(a.retryable)}, not false`);
  assert.ok(!a.wire.includes(POISON), `${door}: the answer carries the failure's message or path: ${a.wire}`);
  const root = process.env['DATA_ROOT'];
  for (const form of [root, root.replaceAll('\\', '\\\\'), root.replaceAll('\\', '/')]) assert.ok(!a.wire.includes(form), `${door}: the answer carries the server's data root`);
}
const assertNotFault = (door, a) => {
  assert.ok(a.status < 500 && a.code !== 'file_system_fault', `${door}: a caller-made path condition answered as a storage fault: ${a.status} ${a.wire.slice(0, 200)}`);
};

describe('a storage fault on list or read is a fault, and absence keeps its answer', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'listfault', space: S });
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['get']);
    assert.ok(layer, 'no GET /:spaceId on the file router — re-anchor this test');
    getHandler = layer.route.stack.at(-1).handle;
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    await acts.seed('a.txt');
    await acts.seed('d/f.txt');
    await acts.seed('d/g.txt');
  });

  it('the door tables are derived and floored (an empty table cannot pass)', () => {
    assert.ok(LIST_DOORS().length >= 3 && READ_DOORS().length >= 3, 'MCP, POST /api/<tool> and REST are the doors that list and read');
  });

  for (const code of ['EIO', 'EACCES']) {
    describe(`${code}`, () => {
      for (const d of LIST_DOORS()) {
        it(`${d.name}: readdir of a subdirectory failing is 500 file_system_fault, retryable false, no path`, async () => {
          assertFault(d.name, await underFault('readdir', code, () => d.run('d')));
        });
      }
      it('REST GET /api/files: the stat of the listed path failing (heldEntryOf) is the same fault', async () => {
        assertFault('REST stat', await underFault('stat', code, async () => normalised(await restGet('d'))));
      });
      for (const d of READ_DOORS()) {
        it(`${d.name}: the read of an existing file failing is 500 file_system_fault, retryable false, no path`, async () => {
          assertFault(d.name, await underFault('open', code, () => d.run('d/f.txt')));
        });
      }
    });
  }

  describe('what keeps its answer', () => {
    for (const d of LIST_DOORS()) {
      it(`${d.name}: an absent directory is an empty listing (REST: 404 Path not found)`, async () => {
        const a = await d.run('nope/deeper');
        if (d.rest) { assert.equal(a.status, 404); assert.match(a.text, /Path not found/); } else { assert.equal(a.status, 200); assert.match(a.text, /empty directory|\[\]|entries/); }
      });
      it(`${d.name}: a path through a file (ENOTDIR) is absent, not a fault`, async () => { assertNotFault(d.name, await d.run('a.txt/x')); });
      it(`${d.name}: a component over 255 characters (ENAMETOOLONG) is not a fault`, async () => { assertNotFault(d.name, await d.run(`d/${'x'.repeat(300)}`)); });
      it(`${d.name}: a traversal path is the caller's refusal, never a fault`, async () => { assertNotFault(d.name, await d.run('../outside')); });
    }
    for (const d of READ_DOORS()) {
      it(`${d.name}: an absent file is File not found / 404`, async () => {
        const a = await d.run('nope.txt');
        assert.ok(a.status === 404 || /not found/i.test(a.text), `${d.name}: ${a.status} ${a.text.slice(0, 200)}`);
        assertNotFault(d.name, a);
      });
      it(`${d.name}: a path through a file (ENOTDIR) is not a fault`, async () => { assertNotFault(d.name, await d.run('a.txt/x')); });
      it(`${d.name}: a read of a real directory (EISDIR) is not a fault`, async () => { if (!d.rest) assertNotFault(d.name, await d.run('d')); });
      it(`${d.name}: a component over 255 characters (ENAMETOOLONG) is not a fault`, async () => { assertNotFault(d.name, await d.run(`${'x'.repeat(300)}.txt`)); });
      it(`${d.name}: a traversal path is not a fault`, async () => { assertNotFault(d.name, await d.run('../outside.txt')); });
    }

    it('a RETIRED member space of a personal view is skipped, as it always was (SpaceRetired is not a fault)', async () => {
      // The merge a personal view's read makes (`listAcrossMembers`) over a member whose id a purge has not yet dropped: that member holds nothing here.
      const { getConfig } = await import('../../server/dist/config/loader.js');
      const { listAcrossMembers } = await import('../../server/dist/files/list-across-members.js');
      const cfg = getConfig();
      const before = cfg.retiredSpaceIds;
      cfg.retiredSpaceIds = [...(before ?? []), 'retiredmember'];
      try {
        const entries = await listAcrossMembers(['retiredmember', S], 'd');
        assert.deepEqual(entries.map(e => e.name).sort(), ['f.txt', 'g.txt'], 'the retired member was not skipped, or it hid the live member\'s entries');
      } finally { cfg.retiredSpaceIds = before; }
    });

    for (const d of LIST_DOORS().filter(x => !x.rest)) {
      it(`${d.name}: ONE unreadable entry keeps the listing, listed without its size`, async () => {
        const a = await underFault('open', 'EIO', () => d.run('d'));
        assert.equal(a.status, 200, `${d.name}: an unreadable entry failed the whole listing: ${a.wire.slice(0, 200)}`);
        assert.ok(a.text.includes('f.txt') && a.text.includes('g.txt'), `${d.name}: the listing lost an entry: ${a.text}`);
        assert.ok(!/\(\d+B\)/.test(a.text) && !/"size"/.test(a.text), `${d.name}: an entry whose stat failed still carries a size: ${a.text}`);
      });
    }
  });
});
