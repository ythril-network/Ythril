/**
 * An export whose store fails before its first byte answers 503 with `Retry-After`, never a socket closed with no status line (bundle-40,
 * Q-267).
 *
 * ## The finding
 *
 * Bundle-40's CI run failed the every-door store-failure gate on one door: `GET /api/admin/spaces/:spaceId/export` "gave no answer
 * within 20000 ms". The space export set 200 and wrote its envelope BEFORE its first store read. With the store failing, that read threw,
 * the catch saw `headersSent` and destroyed the response; but nothing had left the process yet (the status line and the envelope sat in the
 * compressor's buffer, or in the socket corked until the next tick), so the client read a closed socket and no status at all. The same
 * export answered the same way on 6c64a7112; the every-door gate only saw it when the doors before it left the process in a state where it
 * did. Asked alone, here, it fails on both.
 *
 * ## What is held
 *
 * For each export (the space export and the audit-log export), with every command the driver sends failing as a cleared pool fails one
 * (`PoolClearedError`, built by the driver's own constructor): the answer is a 503 with `Retry-After` and `retryable: true` — with and
 * without a compressing `Accept-Encoding`. The store is then healed and the space export answers 200 with a whole body, so the fix did
 * not cost the export its stream.
 *
 * ## Seen red
 *
 * On 70e607a6e the space export closes the socket with no status line under the fault (fetch: `other side closed`).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-export-whose-store-fails-before-its-first-byte-answers-503-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT']) process.env[k] = 'true';

const S = 'exportstoredown';
const EXPORTS = [`/api/admin/spaces/${S}/export`, '/api/admin/audit-log/export'];

// The driver the SERVER loads, so the patched class is the one its operations go through.
const requireFromServer = createRequire(path.resolve('server/package.json'));
const driverLib = path.dirname(requireFromServer.resolve('mongodb'));
const { Server } = requireFromServer(path.join(driverLib, 'sdam', 'server.js'));
const { PoolClearedError } = requireFromServer(path.join(driverLib, 'cmap', 'errors.js'));
const { MongoNetworkTimeoutError } = requireFromServer('mongodb');

let door, server, adminKey;
let failing = false;
const realCommand = Server.prototype.command;

describe('an export whose store fails before its first byte answers 503 (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'exportstoredown', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
    await door.mongo.col(`${S}_facts`).insertOne({ _id: 'f1', spaceId: S, subject: 's', predicate: 'p', object: 'o' });
    Server.prototype.command = async function storeDown(...args) {
      if (!failing) return realCommand.apply(this, args);
      throw new PoolClearedError({ address: 'mongo-a.internal:27017', serverError: new MongoNetworkTimeoutError('connection <monitor> timed out') });
    };
  });
  after(async () => {
    Server.prototype.command = realCommand;
    failing = false;
    await server?.close();
    await door?.close();
  });

  for (const encoding of ['gzip, deflate', 'identity']) {
    it(`each export answers 503, Retry-After, retryable under a failing store (Accept-Encoding: ${encoding})`, async () => {
      failing = true;
      try {
        for (const p of EXPORTS) {
          let r;
          try {
            r = await fetch(`${server.url}${p}`, { headers: { Authorization: `Bearer ${adminKey}`, 'Accept-Encoding': encoding }, signal: AbortSignal.timeout(20_000) });
          } catch (err) {
            assert.fail(`${p} gave no status line under a failing store: ${err}${err?.cause ? ` (${err.cause})` : ''}`);
          }
          const body = await r.json().catch(() => null);
          assert.equal(r.status, 503, `${p} answered ${r.status}: ${JSON.stringify(body)?.slice(0, 200)}`);
          assert.ok(Number(r.headers.get('retry-after')) > 0, `${p} answered 503 without Retry-After`);
          assert.equal(body?.retryable, true, `${p} answered 503 without retryable: true`);
        }
      } finally {
        failing = false;
      }
    });
  }

  it('the space export still streams a whole backup once the store answers', async () => {
    const r = await fetch(`${server.url}${EXPORTS[0]}`, { headers: { Authorization: `Bearer ${adminKey}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.spaceId, S);
    assert.deepEqual(body.facts.map(f => f._id), ['f1']);
  });
});
