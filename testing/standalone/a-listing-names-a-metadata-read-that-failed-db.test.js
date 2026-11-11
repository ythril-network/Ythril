/**
 * The Files listing says when the metadata it adds could not be read, and says it in words of ours (Q-341, bundle-70 S3).
 *
 * ## The rule
 *
 * `GET /api/files/:spaceId` lists what is on the disk and adds, from each member space's file records, a status, tags and the
 * folder sizes (`enrichEntries`, `dirAggregates`). When a member's read of those records FAILS, the listing still answers
 * `200` with the entries, and now says so:
 *
 *  1. the answer carries `metadataIncomplete`, a non-empty array of reasons from a CLOSED vocabulary (a short lower-case word
 *     each: a store-failure class, never the driver's text); the field is ABSENT when nothing failed, as `usageIncomplete` is;
 *  2. in a merged view it marks only the member that failed: the other member's entries keep their status, tags and folder
 *     sizes, the failed member's are listed without them;
 *  3. all three ways a listing is asked answer it: the default path (`.`), the root as the client asks it (`/`), and a
 *     sub-directory;
 *  4. a recognisable secret in the driver's error (an address, a port, a token) appears nowhere in the answer, for a store-side
 *     failure and for an error of no known class;
 *  5. the failure is logged once per window per space, so a page that polls its listing does not fill the log;
 *  6. a member with no file records (a space that holds nothing yet) is not a failure: its listing carries no field.
 *
 * ## Why
 *
 * The listing used to swallow the failure (`catch { /* member has no files collection *\/ }` in `dirAggregates`; a find on a missing
 * collection does not throw, so the comment was wrong) and answer the files bare. A bare file reads as "nothing has been
 * processed yet", which is a statement about the file, not about a database that did not answer.
 *
 * ## Seen red at 8ee92312
 *
 * 1, 2, 3 and 4: the answer carries no `metadataIncomplete`, whichever member failed and whichever branch was asked. 5: nothing
 * is logged. The healthy-listing controls (no field when nothing failed, the healthy member's metadata kept, an empty member is
 * no failure) are green on the base: they pin what the fix must not change.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-listing-names-a-metadata-read-that-failed-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors } from './_view-doors.mjs';

const skip = await mongoSkipReason();

const A = 'mdinc-a';
const B = 'mdinc-b';
/** A space only the once-per-window case fails, so no earlier case has used up its window. */
const L = 'mdinc-log';
/** A space whose file records are none. */
const EMPTY = 'mdinc-empty';
const T0 = '2026-09-01T00:00:00.000Z';
/** The recognisable secret: an internal address, a port and a token, as a driver's message carries them. */
const SECRET = 'SECRET-q341-9f3a7c';
const ADDRESS = '10.9.8.7';
const LEAKS = [SECRET, ADDRESS, '27017', 'timed out', 'PoolClearedError', 'mdinc-b_files', 'ythril_harness'];

const requireFromServer = createRequire(path.resolve('server/package.json'));
const driverLib = path.dirname(requireFromServer.resolve('mongodb'));
const { Server } = requireFromServer(path.join(driverLib, 'sdam', 'server.js'));
const { PoolClearedError } = requireFromServer(path.join(driverLib, 'cmap', 'errors.js'));
const { MongoNetworkTimeoutError } = requireFromServer('mongodb');
const realCommand = Server.prototype.command;

/** The error each fault throws: a store-side one, built by the driver's own constructors, and one of no class the server knows. */
const FAULTS = {
  store: () => new PoolClearedError({ address: `${ADDRESS}:27017`, serverError: new MongoNetworkTimeoutError(`connection to ${ADDRESS}:27017 timed out ${SECRET}`) }),
  unknown: () => new Error(`unclassified failure at ${ADDRESS}:27017 ${SECRET}`),
};
/** Which space's file-record `find` fails now, and with which fault: the seam, below the server, at the one function every driver operation passes. */
const failing = new Map();

let d, owner, view;
const rootDir = (space) => path.join(process.env['DATA_ROOT'], 'files', space);
const put = (space, rel, content) => {
  const abs = path.join(rootDir(space), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const row = (rel, sizeBytes, tags) => ({ _id: rel, path: rel, sizeBytes, embeddingStatus: 'complete', tags, createdAt: T0, updatedAt: T0, seq: 1 });

/** GET the listing: `path` undefined asks as a client that names no path does (`.`). */
async function list(space, p) {
  const q = p === undefined ? '' : `?path=${encodeURIComponent(p)}`;
  const a = await d.rest(owner.key, 'GET', `/api/files/${encodeURIComponent(space)}${q}`);
  assert.equal(a.status, 200, `the listing of ${space} ${p ?? '(no path)'} answered ${a.status} ${a.text.slice(0, 200)}`);
  return a;
}
const entry = (a, name) => a.body.entries.find(e => e.name === name);
/** Whether a listed entry carries the metadata its member's records give it. */
const hasMeta = (e) => e?.embeddingStatus === 'complete' && Array.isArray(e.tags) && e.tags.length === 1;
/** The shape every reason has: one short lower-case word group, nothing a driver or a path could put in. */
const CLOSED_WORD = /^[a-z]+(?:[-_][a-z]+)*$/;

describe('the Files listing names a metadata read that failed (Q-341)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'q341-listing', spaces: [A, B, L, EMPTY] });
    owner = await d.mint('md-owner', Object.fromEntries([A, B, L, EMPTY].map(s => [s, d.row({ files: 'read' })])));
    const made = await d.rest(owner.key, 'POST', '/api/views', { name: 'both', members: [A, B] });
    assert.equal(made.status, 201, `creating the view: ${made.text.slice(0, 200)}`);
    view = '@both';
    for (const [space, top, nested, tag] of [[A, 'a-only.txt', 'sub/inner-a.txt', 'alpha'], [B, 'b-only.txt', 'sub/inner-b.txt', 'beta']]) {
      put(space, top, 'top'); put(space, nested, 'nested');
      await d.door.coll(space, 'files').insertMany([row(top, 10, [tag]), row(nested, space === A ? 100 : 200, [tag])]);
    }
    put(L, 'l-only.txt', 'top');
    await d.door.coll(L, 'files').insertOne(row('l-only.txt', 10, ['log']));
    put(EMPTY, 'e-only.txt', 'top');
    Server.prototype.command = async function metadataReadFails(operation, ...rest) {
      const make = operation?.commandName === 'find' ? failing.get(operation.ns?.collection) : undefined;
      if (make) throw make();
      return realCommand.call(this, operation, ...rest);
    };
  });
  after(async () => {
    Server.prototype.command = realCommand;
    failing.clear();
    await d?.close();
  });
  beforeEach(() => failing.clear());

  it('control: a listing whose reads all answered carries no metadataIncomplete, and every entry its metadata and folder size', async () => {
    for (const p of [undefined, '/']) {
      const a = await list(view, p);
      assert.ok(!('metadataIncomplete' in a.body), `no read failed, yet the answer carries metadataIncomplete: ${JSON.stringify(a.body.metadataIncomplete)}`);
      assert.ok(hasMeta(entry(a, 'a-only.txt')) && hasMeta(entry(a, 'b-only.txt')), `entries lost their metadata: ${a.text.slice(0, 300)}`);
      assert.equal(entry(a, 'sub').size, 300, 'the folder size is the two members\' files together');
    }
  });

  for (const [label, p, healthyName, failedName] of [
    ['the default path (.)', undefined, 'a-only.txt', 'b-only.txt'],
    ['the root as the client asks it (/)', '/', 'a-only.txt', 'b-only.txt'],
    ['a sub-directory', 'sub', 'inner-a.txt', 'inner-b.txt'],
  ]) {
    it(`${label}: a member whose metadata read failed is named in metadataIncomplete, and only that member's entries are bare`, async () => {
      failing.set(`${B}_files`, FAULTS.store);
      const a = await list(view, p);
      const reasons = a.body.metadataIncomplete;
      assert.ok(Array.isArray(reasons) && reasons.length > 0, `member ${B}'s read failed and the answer carries no metadataIncomplete: ${a.text.slice(0, 300)}`);
      assert.ok(reasons.every(r => typeof r === 'string' && CLOSED_WORD.test(r) && r.length <= 40), `a reason outside the closed vocabulary: ${JSON.stringify(reasons)}`);
      assert.ok(hasMeta(entry(a, healthyName)), `the healthy member's entry ${healthyName} lost its metadata: ${JSON.stringify(entry(a, healthyName))}`);
      const bare = entry(a, failedName);
      assert.ok(bare && bare.embeddingStatus === undefined && bare.tags === undefined, `the failed member's entry ${failedName} was listed with metadata: ${JSON.stringify(bare)}`);
    });
  }

  it('the failing member is the one marked, whichever it is: with the first member failing, the second keeps its metadata and the folder size is the second\'s alone', async () => {
    failing.set(`${A}_files`, FAULTS.store);
    const a = await list(view, '/');
    assert.ok(Array.isArray(a.body.metadataIncomplete) && a.body.metadataIncomplete.length > 0, `member ${A}'s read failed and the answer carries no metadataIncomplete: ${a.text.slice(0, 300)}`);
    assert.ok(hasMeta(entry(a, 'b-only.txt')), `the healthy member's entry lost its metadata: ${JSON.stringify(entry(a, 'b-only.txt'))}`);
    assert.equal(entry(a, 'a-only.txt').embeddingStatus, undefined, 'the failed member\'s entry was listed with metadata');
    assert.equal(entry(a, 'sub').size, 200, 'the folder size counts the member whose read failed');
  });

  it('a space whose own read failed lists its files bare and names the failure, on the single-space door', async () => {
    failing.set(`${B}_files`, FAULTS.store);
    const a = await list(B, '/');
    assert.ok(Array.isArray(a.body.metadataIncomplete) && a.body.metadataIncomplete.length > 0, `the space's read failed and the answer carries no metadataIncomplete: ${a.text.slice(0, 300)}`);
    assert.deepEqual(a.body.entries.filter(e => e.type === 'file').map(e => e.name), ['b-only.txt'], 'the listing still names the files on the disk');
    assert.equal(entry(a, 'b-only.txt').embeddingStatus, undefined);
  });

  for (const [kind, fault] of Object.entries(FAULTS)) {
    it(`a ${kind === 'store' ? 'store-side' : 'no-known-class'} error carrying a secret reaches nothing in the answer: its reasons are words of ours`, async () => {
      failing.set(`${A}_files`, fault);
      failing.set(`${B}_files`, fault);
      const raw = [];
      for (const p of [undefined, '/', 'sub']) {
        const a = await list(view, p);
        assert.ok(Array.isArray(a.body.metadataIncomplete) && a.body.metadataIncomplete.length > 0,
          `both members' reads failed and the answer (path ${p ?? '.'}) carries no metadataIncomplete: ${a.text.slice(0, 300)}`);
        raw.push(a.text);
      }
      for (const text of raw) {
        for (const leak of LEAKS) assert.ok(!text.includes(leak), `the answer carries ${JSON.stringify(leak)}: ${text.slice(0, 300)}`);
      }
    });
  }

  it('once the store answers again the next listing carries no field (the marker is per answer, never remembered)', async () => {
    failing.set(`${B}_files`, FAULTS.store);
    const broken = await list(view, '/');
    assert.ok(Array.isArray(broken.body.metadataIncomplete) && broken.body.metadataIncomplete.length > 0, 'the failing listing carried no metadataIncomplete: the case below it asks nothing');
    failing.clear();
    const healed = await list(view, '/');
    assert.ok(!('metadataIncomplete' in healed.body), `the store answered, yet: ${JSON.stringify(healed.body.metadataIncomplete)}`);
    assert.ok(hasMeta(entry(healed, 'b-only.txt')), 'the member lost its metadata after the store came back');
  });

  it('control: a member with no file records is no failure — the listing carries no metadataIncomplete', async () => {
    const a = await list(EMPTY, '/');
    assert.ok(!('metadataIncomplete' in a.body), `a space with no records was reported as a failed read: ${JSON.stringify(a.body.metadataIncomplete)}`);
    assert.equal(entry(a, 'e-only.txt').embeddingStatus, undefined, 'the file has no record, so no status');
  });

  it('the failure is logged once per window per space: three failing listings leave one line naming the space', async () => {
    const log = await import('../../server/dist/util/log.js');
    const lines = [];
    const stop = log.subscribeLogLines(l => lines.push(String(l)));
    try {
      failing.set(`${L}_files`, FAULTS.store);
      // Asked as the client asks: its polling, the same space again and again.
      for (const p of [undefined, '/', '/']) await list(L, p);
    } finally { stop(); }
    const named = lines.filter(l => l.includes(L));
    assert.equal(named.length, 1, `${named.length} log line(s) name the space ${L} over three failing listings (want one per window): ${named.map(l => l.slice(0, 160)).join(' | ')}`);
  });
});
