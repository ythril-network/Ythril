/**
 * An export writes exactly one audit entry — when its response finishes, and when the client cuts it off first (bundle-40, Q-207).
 *
 * ## The finding
 *
 * The audit middleware writes its entry when the response emits `finish`. A streamed export that the client abandons half way
 * (a closed tab, a dropped connection, a curl that was killed) emits `close` and never `finish`, so the one act an auditor most wants
 * on record, a copy of a space or of the audit log leaving the instance, was unlogged exactly when it was partial or hostile. And a
 * writer that listens to both events would write the entry twice on a normal finish (both fire), so "once" has to be held from both
 * sides. The space export has no rule at all on 6c64a7112 (`space.export`, written even when `audit.logReads` is off).
 *
 * ## What is held
 *
 * - For each export the middleware knows (`GET /api/admin/audit-log/export`, `GET /api/admin/spaces/:spaceId/export`), with
 *   `audit.logReads` off: a response that finishes is ONE entry under the export's operation; a response whose client goes away after the
 *   first chunk, before the end, is ONE entry under the same operation.
 * - The routes are stubs that stream a body and wait, over the real `auditMiddleware`: the only things under test are the events the
 *   response emits and what the middleware writes for each.
 *
 * ## Seen red
 *
 * On 6c64a7112 the space export leaves no entry either way, and a cut-off audit-log export leaves none.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-export-is-audited-once-whether-or-not-its-response-finishes-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { auditRowsOf } from './_audit-rows.mjs';

const skip = await mongoSkipReason();

const SPACE = 'exportauditonce';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-export-audit-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

/** Each export the middleware is expected to audit: where it is served and under what operation it is recorded. */
const EXPORTS = [
  { name: 'the audit log export', path: '/api/admin/audit-log/export', operation: 'audit.export' },
  { name: 'the space export', path: `/api/admin/spaces/${SPACE}/export`, operation: 'space.export' },
];

let mongo, httpServer, base;
/** What the stub handler last did: resolves when the server side saw the response end, by whichever event. */
let ended;

describe('an export writes exactly one audit entry, finished or cut off (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'export-audit', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: SPACE, folders: [] }],
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('exportauditonce');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    // The export is written whichever way the operator set reads: that is half of what is held.
    loader.mutateConfig(c => { c.audit = { ...(c.audit ?? {}), logReads: false }; });
    const { auditMiddleware } = await import('../../server/dist/audit/middleware.js');

    const app = express();
    app.use((req, _res, next) => { req.authToken = { id: 'export-audit-token', name: 'export', rights: { instanceAdmin: true, perSpace: {}, floor: {} } }; next(); });
    app.use(auditMiddleware);
    /** Streams a first chunk, then either ends or waits for the client to go. */
    const stream = (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.write('{"facts":[{"_id":"a"},');
      ended = new Promise(resolve => { res.once('close', resolve); });
      if (req.query.cut !== '1') res.end('{"_id":"b"}]}');
    };
    for (const e of EXPORTS) app.get(e.path.replace(SPACE, ':spaceId'), stream);
    httpServer = await listenOnLoopback(http.createServer(app));
    base = `http://127.0.0.1:${httpServer.port}`;
  });

  after(async () => {
    await httpServer?.close();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await mongo.getDb().collection('audit_log').deleteMany({}); });

  /** The entries of every export operation, by operation name. */
  const entriesOf = async () => {
    const rows = await auditRowsOf(mongo, { operation: { $in: EXPORTS.map(e => e.operation) } });
    return Object.fromEntries(EXPORTS.map(e => [e.operation, rows.filter(r => r.operation === e.operation)]));
  };

  it('a response that finishes is one entry under the export\'s own operation, for each export', async () => {
    for (const e of EXPORTS) {
      const res = await fetch(`${base}${e.path}`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /"_id":"b"/);
      await ended;
    }
    const entries = await entriesOf();
    for (const e of EXPORTS) {
      assert.equal(entries[e.operation].length, 1, `${e.name} that finished left ${entries[e.operation].length} ${e.operation} entries, want exactly one`);
      assert.equal(entries[e.operation][0].status, 200);
    }
  });

  it('a response the client cuts off before the end is one entry under the export\'s own operation, for each export', async () => {
    for (const e of EXPORTS) {
      await new Promise((resolve, reject) => {
        const req = http.get(`${base}${e.path}?cut=1`, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
      });
      await ended;
    }
    const entries = await entriesOf();
    for (const e of EXPORTS) {
      assert.equal(entries[e.operation].length, 1, `${e.name} that was cut off left ${entries[e.operation].length} ${e.operation} entries, want exactly one: a close with no finish is the case the writer must not miss`);
    }
  });
});
