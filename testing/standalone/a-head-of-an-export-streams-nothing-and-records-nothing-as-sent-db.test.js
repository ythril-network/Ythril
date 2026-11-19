/**
 * A HEAD of an export reads nothing and records no data as sent.
 *
 * ## The rule
 *
 * Express runs the GET route for a `HEAD` and Node drops the body, so a `HEAD /api/admin/spaces/<s>/export` or
 * `HEAD /api/admin/audit-log/export` ran the whole export: every collection of the space, or the whole audit log, read from the store and
 * serialised to send nothing, and the audit row (`space.export` and `audit.export` are written whenever the response finishes) counted the
 * documents as written. A HEAD on these two routes is how a client asks "is this export there, and what is its type"; the answer is the
 * status and the headers, and nothing is read for it. The branch's other HEAD stops are `spaces.ts` (completeness) and `util/sse-stream.ts`.
 *
 * What must hold, for each export:
 *
 *  1. the control: a GET reads the collections (the spy sees it), and its row counts the documents it wrote;
 *  2. a HEAD answers the GET's status and content type, with no body, and reads no collection of the space (nor the audit log);
 *  3. a HEAD still leaves its export row (`method: 'HEAD'`, the GET's operation), and that row counts nothing as written and does not
 *     say the copy was cut off.
 *
 * ## How it is driven
 *
 * The real application (`appRouter`) behind a loopback server, a real instance-admin token, the harness Mongo. The spy is on the driver's
 * `Collection.prototype.find` and `aggregate`, as the completeness test in `head-is-judged-as-the-get-it-mirrors-db.test.js` spies
 * `aggregate`; it is taken off before the rows are read.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/a-head-of-an-export-streams-nothing-and-records-nothing-as-sent-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
const SPACE = 'headexport';

/** Each export: where it is served, what it is recorded as, and the collection whose reading is the export's work. */
const EXPORTS = [
  { name: 'the space export', path: `/api/admin/spaces/${SPACE}/export`, operation: 'space.export', worked: (name) => name.startsWith(`${SPACE}_`) },
  { name: 'the audit log export', path: '/api/admin/audit-log/export', operation: 'audit.export', worked: (name) => name === 'audit_log' },
];

let door, server, base, app, token, tokenId;

/** One request on a connection of its own; resolves the status, the content type and the body text. */
function ask(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(`${base}${p}`, {
      method, agent: false,
      headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? null, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Run `act` with the driver's reads of the collections `worked` names counted; resolves what `act` resolved and the collections read. */
async function readsDuring(worked, act) {
  const nodeRequire = createRequire(new URL('../../server/dist/app.js', import.meta.url));
  const { Collection } = nodeRequire('mongodb');
  const read = [];
  const originals = { find: Collection.prototype.find, aggregate: Collection.prototype.aggregate };
  for (const method of Object.keys(originals)) {
    Collection.prototype[method] = function spied(...args) {
      if (worked(String(this.collectionName))) read.push(`${method} ${this.collectionName}`);
      return originals[method].apply(this, args);
    };
  }
  try {
    return { got: await act(), read };
  } finally {
    Object.assign(Collection.prototype, originals);
  }
}

/** The documents a row says were written: the numeric `to` of its changes, and whether it says the copy was cut off. */
function writtenBy(row) {
  const changes = row.changes ?? [];
  return {
    documents: changes.reduce((sum, c) => sum + (typeof c.to === 'number' ? c.to : 0), 0),
    cutOff: changes.some(c => c.field === 'complete' && c.to === false),
  };
}

describe('a HEAD of an export reads nothing and records no data as sent (real routes, real MongoDB)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    door = await openToolDoor({ suite: 'headexport', spaces: [{ id: SPACE, label: 'Head export', folders: [], completeLinkage: true }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    const made = await tokens.createToken({ name: 'head-export-admin', rights: door.ADMIN });
    token = made.plaintext;
    tokenId = made.record.id;
    app = await appRouter();
    server = await listenOnLoopback(http.createServer((req, res) => { app.router(req, res); }));
    base = server.url;
    const stored = await ask('POST', `/api/brain/spaces/${SPACE}/facts`, { fact: 'a document the export carries', tags: [] });
    assert.equal(stored.status, 201, `the fixture fact was not stored (${stored.status} ${stored.text})`);
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await door?.close();
  });

  for (const exp of EXPORTS) {
    it(`${exp.name}: a GET reads the collections and counts what it wrote (the control)`, async () => {
      const { got, read } = await readsDuring(exp.worked, () => ask('GET', exp.path));
      assert.equal(got.status, 200, `GET ${exp.path} (${got.status} ${got.text.slice(0, 200)})`);
      assert.ok(got.text.length > 0, 'the control: a GET has a body');
      assert.ok(read.length > 0, 'the control: the spy did not see the GET read a collection');
      const rows = (await auditRowsOf(door.mongo, { tokenId, method: 'GET', path: exp.path, operation: exp.operation }));
      assert.equal(rows.length, 1, `the control: a GET left ${rows.length} rows`);
      if (exp.operation === 'space.export') assert.ok(writtenBy(rows[0]).documents >= 1, 'the control: the GET row counts the fact it wrote');
    });

    it(`${exp.name}: a HEAD answers the GET's status and type, reads no collection and leaves a row that counts nothing as written`, async () => {
      const { got, read } = await readsDuring(exp.worked, () => ask('HEAD', exp.path));
      assert.equal(got.status, 200, `HEAD ${exp.path} (${got.status})`);
      assert.match(got.type ?? '', /^application\//, 'the HEAD answers the export\'s content type');
      assert.equal(got.text, '', 'a HEAD has no body');
      assert.deepEqual(read, [], 'a HEAD read the collections the export walks, to send nothing');
      const rows = await auditRowsOf(door.mongo, { tokenId, method: 'HEAD', path: exp.path, operation: exp.operation });
      assert.equal(rows.length, 1, `a HEAD left ${rows.length} export rows`);
      const written = writtenBy(rows[0]);
      assert.equal(written.documents, 0, 'the HEAD row counts documents as written that were never sent');
      assert.equal(written.cutOff, false, 'the HEAD row says the copy was cut off');
    });
  }
});
