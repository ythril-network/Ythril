/**
 * Every audit entry's `changes` go through the allowlist of its operation (`AUDIT_CHANGE_FIELDS`), whoever wrote them: an unlisted field
 * is dropped, on a request's entry that names its own changes and on a server act's entry alike (bundle-40, Q-207).
 *
 * ## The finding
 *
 * `audit-changes.ts` is an ALLOWLIST on purpose: audit entries are queryable by any admin and kept for months, so a field is recorded
 * only when it was checked to be unable to carry a credential, and an operation with no entry records nothing. That holds for the
 * changes the middleware DIFFS (`req.auditSnapshots`), and nowhere else: a route that hands over its own list
 * (`req.auditChangesExplicit`) had it written as given, and the writer for work the server does on its own took no changes at all, so
 * the first act that wants to record what it did (an automerge's absorbed entity, a sweep's counts) would have written a free-form
 * list into the same retained, queryable store with nothing to stop a secret going into it.
 *
 * ## What is held
 *
 * - The middleware, over a route that sets `req.auditChangesExplicit`: the entry keeps the listed field, drops the unlisted one (and the
 *   value of the unlisted one is nowhere in the stored row), and an operation with no allowlist records no changes at all.
 * - `logInternalAudit` given `changes`: the same, for the same operations.
 *
 * ## Seen red
 *
 * On 6c64a7112 the explicit list is stored whole (the credential-shaped field is in the row), and `logInternalAudit` stores no changes
 * (the listed field is missing).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-audit-entry-records-only-the-fields-its-operation-allows-db.test.js
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

const SPACE = 'auditallowlist';
const SECRET = 'sk-live-0123456789abcdef';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-audit-allowlist-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

let mongo, audit, allow, httpServer, base;

/** An operation `AUDIT_CHANGE_FIELDS` lists with `label`, and one it does not list at all (`config.reload` records no changes). */
const LISTED = { operation: 'space.update', field: 'label' };
const UNLISTED_OPERATION = 'config.reload';

describe('an audit entry records only the changes its operation allows (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'audit-allowlist', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: SPACE, folders: [] }],
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('auditallowlist');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    audit = await import('../../server/dist/audit/audit.js');
    allow = await import('../../server/dist/audit/audit-changes.js');
    const { auditMiddleware } = await import('../../server/dist/audit/middleware.js');

    // The real middleware over two stub routes that hand over their own change list, as `forks.ts` does.
    const app = express();
    app.use((req, _res, next) => { req.authToken = { id: 'allowlist-token', name: 'allowlist', rights: { instanceAdmin: true, perSpace: {}, floor: {} } }; next(); });
    app.use(auditMiddleware);
    const explicit = (changes) => (req, res) => { req.auditChangesExplicit = changes; res.status(200).json({ ok: true }); };
    app.patch(`/api/spaces/:id`, explicit([
      { field: LISTED.field, from: 'old label', to: 'new label' },
      { field: 'apiKey', to: SECRET },
    ]));
    app.post('/api/admin/reload-config', explicit([{ field: 'apiKey', to: SECRET }, { field: LISTED.field, to: 'x' }]));
    httpServer = await listenOnLoopback(http.createServer(app));
    base = `http://127.0.0.1:${httpServer.port}`;
  });

  after(async () => {
    await httpServer?.close();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await mongo.getDb().collection('audit_log').deleteMany({}); });

  it('the fixture: the operations used are as the allowlist has them', () => {
    assert.ok(allow.AUDIT_CHANGE_FIELDS[LISTED.operation]?.includes(LISTED.field), `${LISTED.operation} does not list ${LISTED.field}`);
    assert.equal(allow.AUDIT_CHANGE_FIELDS[UNLISTED_OPERATION], undefined, `${UNLISTED_OPERATION} has an allowlist now: pick an unlisted operation`);
  });

  it('a route\'s own change list keeps the listed field and drops the unlisted one, whose value is nowhere in the row', async () => {
    const res = await fetch(`${base}/api/spaces/${SPACE}`, { method: 'PATCH' });
    assert.equal(res.status, 200);
    const rows = await auditRowsOf(mongo, { operation: LISTED.operation });
    assert.equal(rows.length, 1, `want one ${LISTED.operation} row: ${JSON.stringify(rows)}`);
    assert.deepEqual(rows[0].changes, [{ field: LISTED.field, from: 'old label', to: 'new label' }],
      'the row does not hold exactly the allowlisted change');
    assert.ok(!JSON.stringify(rows[0]).includes(SECRET), 'a field the allowlist does not name was written into the audit row');
  });

  it('a route\'s own change list for an operation with no allowlist records no changes', async () => {
    const res = await fetch(`${base}/api/admin/reload-config`, { method: 'POST' });
    assert.equal(res.status, 200);
    const rows = await auditRowsOf(mongo, { operation: UNLISTED_OPERATION });
    assert.equal(rows.length, 1, `want one ${UNLISTED_OPERATION} row: ${JSON.stringify(rows)}`);
    assert.ok(!('changes' in rows[0]), `an operation with no allowlist recorded changes: ${JSON.stringify(rows[0].changes)}`);
    assert.ok(!JSON.stringify(rows[0]).includes(SECRET), 'a field of an operation with no allowlist was written into the audit row');
  });

  it('a server act\'s own change list keeps the listed field and drops the unlisted one, and an operation with no allowlist records none', async () => {
    audit.logInternalAudit({
      method: 'SWEEP', path: 'internal:allowlist-test', spaceId: SPACE, operation: LISTED.operation,
      changes: [{ field: LISTED.field, to: 'set by the server' }, { field: 'apiKey', to: SECRET }],
    });
    const rows = await auditRowsOf(mongo, { path: 'internal:allowlist-test' });
    assert.equal(rows.length, 1, `want one row: ${JSON.stringify(rows)}`);
    assert.deepEqual(rows[0].changes, [{ field: LISTED.field, to: 'set by the server' }],
      'the server act\'s row does not hold exactly the allowlisted change (a writer that takes no changes records none)');
    assert.ok(!JSON.stringify(rows[0]).includes(SECRET), 'a field the allowlist does not name was written into the audit row');

    // An operation with no allowlist records no changes at all, whatever the act hands over.
    audit.logInternalAudit({
      method: 'SWEEP', path: 'internal:allowlist-unlisted', spaceId: SPACE, operation: UNLISTED_OPERATION,
      changes: [{ field: 'apiKey', to: SECRET }],
    });
    const unlisted = await auditRowsOf(mongo, { path: 'internal:allowlist-unlisted' });
    assert.equal(unlisted.length, 1, `want one row: ${JSON.stringify(unlisted)}`);
    assert.ok(!('changes' in unlisted[0]), `an operation with no allowlist recorded changes: ${JSON.stringify(unlisted[0].changes)}`);
  });
});
