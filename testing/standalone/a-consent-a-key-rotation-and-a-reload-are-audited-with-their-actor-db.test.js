/**
 * Three acts that wrote no audit entry before bundle-40 write one with who did it and only what their operation allows (bundle-40 pre-ship T1,
 * T2, T3; `Q-207`).
 *
 * ## The rules this file holds
 *
 *  1. **An MCP OAuth consent (`POST /mcp-oauth/consent`) writes `mcp.oauth.consent` with the APPROVER's token id, the caller's address and the
 *     status it answered**, approved (302) and refused for a bad token (401) alike; the approver attached to the request carries no `hash`.
 *     The route is authenticated by the token in its BODY, not by a bearer header, so without the handler attaching the approver the row
 *     names nobody.
 *  2. **A signing-key rotation writes `signing.rotate` whose only change is `fingerprint`, the SHA-256 of the NEW public key**, never a key.
 *  3. **A config reload through the admin route writes each space it added, removed or kept through `logInternalAudit`**, with the caller's
 *     token and address, the status the act really had (`200` added and removed, `409` kept), and a measured duration (the hand-written row
 *     said `durationMs: 0`).
 *
 * ## Seen
 *
 * PINS: each holds on 505b5790c, which had no test of the rows through the real routes.
 *
 * ## How it is driven
 *
 * The real application (`createApp`) behind a `node:http` server of the test's own, so the request object the application handled can be read
 * after it answered (`req.authToken`); the harness Mongo; the audit rows read once no insert is pending (`_audit-rows.mjs`).
 *
 * Run: a Mongo the harness accepts, then
 * `node --test testing/standalone/a-consent-a-key-rotation-and-a-reload-are-audited-with-their-actor-db.test.js` (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
const SPACE = 'auditedacts';
const REDIRECT = 'http://127.0.0.1:9/callback';

let door, loader, server, base, admin;
/** The requests the application handled, by path, once each answered. */
const handled = [];

const isLoopback = (ip) => /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(String(ip));

describe('a consent, a key rotation and a reload are audited with their actor (real MongoDB, real routes)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    // A loopback issuer: the OAuth router is mounted only for an https or loopback public URL.
    process.env['PUBLIC_BASE_URL'] = 'http://127.0.0.1:9';
    door = await openToolDoor({ suite: 'auditedacts', spaces: [{ id: SPACE, label: 'Audited', folders: [] }] });
    loader = await import('../../server/dist/config/loader.js');
    const tokens = await import('../../server/dist/auth/tokens.js');
    admin = await tokens.createToken({ name: 'audited-admin', admin: true });
    const { createApp } = await import('../../server/dist/app.js');
    const app = createApp();
    server = await listenOnLoopback(http.createServer((req, res) => {
      res.on('finish', () => handled.push(req));
      app(req, res);
    }));
    base = server.url;
  });
  after(async () => {
    delete process.env['PUBLIC_BASE_URL'];
    await server?.close();
    try { const { closeScheduling } = await import('../../server/dist/schedulers.js'); await closeScheduling({ withinMs: 5000 }); } catch { /* never armed */ }
    await door?.close();
  });

  describe('the MCP OAuth consent', () => {
    let clientId;
    before(async () => {
      const r = await fetch(`${base}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Audited connector', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      });
      const body = await r.json();
      assert.ok(r.status < 300 && body.client_id, `fixture check: the client did not register: ${r.status} ${JSON.stringify(body)}`);
      clientId = body.client_id;
    });
    const consent = (token) => {
      const form = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), token });
      return fetch(`${base}/mcp-oauth/consent`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
    };
    const consentRows = async () => auditRowsOf(door.mongo, { operation: 'mcp.oauth.consent' });

    it('an approved consent: the row names the approver\'s token, the caller\'s address and 302, and the approver attached has no hash', async () => {
      const before = (await consentRows()).length;
      const r = await consent(admin.plaintext);
      assert.equal(r.status, 302, `the consent was answered ${r.status}`);
      const rows = (await consentRows()).slice(before);
      assert.equal(rows.length, 1, `want one consent row: ${JSON.stringify(rows)}`);
      const [row] = rows;
      assert.equal(row.tokenId, admin.record.id, `the consent row names ${JSON.stringify(row.tokenId)}, not the approving token`);
      assert.ok(isLoopback(row.ip), `the consent row's address is ${JSON.stringify(row.ip)}`);
      assert.equal(row.status, 302, `the consent row's status is ${row.status}`);
      assert.equal(row.entryId, clientId, 'the consent row does not name the registered client');
      const req = handled.filter(q => q.url === '/mcp-oauth/consent').at(-1);
      assert.ok(req?.authToken, 'fixture check: the application attached no approver to the consent request');
      assert.equal(req.authToken.id, admin.record.id);
      assert.equal('hash' in req.authToken, false, 'the approver attached to the request carries the token\'s hash');
      assert.equal(JSON.stringify(row).includes(admin.record.hash), false, 'the consent row carries the token\'s hash');
    });

    it('a consent refused for a bad token writes its row with 401 and names no approver', async () => {
      const before = (await consentRows()).length;
      const r = await consent('ythril_not-a-token-this-instance-issued');
      assert.equal(r.status, 401, `a bad token's consent was answered ${r.status}`);
      const rows = (await consentRows()).slice(before);
      assert.deepEqual(rows.map(x => [x.status, x.tokenId]), [[401, null]], `want one refused consent row with no token: ${JSON.stringify(rows)}`);
      assert.ok(isLoopback(rows[0].ip), `the refused consent row's address is ${JSON.stringify(rows[0].ip)}`);
    });
  });

  it('a signing-key rotation records the new key\'s fingerprint, and nothing else', async () => {
    const r = await fetch(`${base}/api/admin/rotate-signing-key`, { method: 'POST', headers: { Authorization: `Bearer ${admin.plaintext}` } });
    const body = await r.json();
    assert.equal(r.status, 200, `the rotation was answered ${r.status}: ${JSON.stringify(body)}`);
    const rows = await auditRowsOf(door.mongo, { operation: 'signing.rotate' });
    assert.equal(rows.length, 1, `want one rotation row: ${JSON.stringify(rows)}`);
    const want = crypto.createHash('sha256').update(body.signingPublicKey).digest('hex');
    assert.deepEqual(rows[0].changes, [{ field: 'fingerprint', to: want }], `the rotation row's changes are ${JSON.stringify(rows[0].changes)}`);
    assert.equal(rows[0].tokenId, admin.record.id);
    const text = JSON.stringify(rows[0]);
    assert.equal(text.includes('BEGIN'), false, 'the rotation row carries a key');
    assert.equal(text.includes(body.signingPublicKey.split('\n')[1]), false, 'the rotation row carries the public key');
  });

  it('a config reload audits each space it added, removed and kept with the caller, the real status and a measured duration', async () => {
    await loader.flushConfig();
    const file = process.env['CONFIG_PATH'];
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    loader.mutateConfig(cfg => { cfg.spaces.push({ id: 'reload-gone', label: 'Gone', folders: [] }, { id: 'reload-kept', label: 'Kept', folders: [] }); });
    await loader.flushConfig();
    // The file: one space added, one removed on purpose, one missing without `removeSpaces` (kept).
    const next = JSON.parse(fs.readFileSync(file, 'utf8'));
    next.spaces = [...onDisk.spaces, { id: 'reload-added', label: 'Added', folders: [] }];
    next.removeSpaces = ['reload-gone'];
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    const r = await fetch(`${base}/api/admin/reload-config`, { method: 'POST', headers: { Authorization: `Bearer ${admin.plaintext}` } });
    assert.equal(r.status, 200, `the reload was answered ${r.status}: ${await r.text()}`);
    const rows = await auditRowsOf(door.mongo, { operation: { $in: ['space.reload_added', 'space.reload_removed', 'space.reload_kept'] } });
    const by = Object.fromEntries(rows.map(x => [x.spaceId, x]));
    assert.deepEqual(rows.map(x => [x.operation, x.spaceId, x.status]).sort(), [
      ['space.reload_added', 'reload-added', 200], ['space.reload_kept', 'reload-kept', 409], ['space.reload_removed', 'reload-gone', 200],
    ], `the reload's rows: ${JSON.stringify(rows.map(x => [x.operation, x.spaceId, x.status]))}`);
    for (const row of rows) {
      assert.equal(row.tokenId, admin.record.id, `the ${row.operation} row names ${JSON.stringify(row.tokenId)}, not the caller`);
      assert.ok(isLoopback(row.ip), `the ${row.operation} row's address is ${JSON.stringify(row.ip)}`);
      assert.equal(row.path, '/api/admin/reload-config');
      assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0, `the ${row.operation} row's duration is ${row.durationMs}`);
    }
    // The added space's row is written after its init ran (collections, indexes): its duration is measured, not the hand-written 0.
    assert.ok(by['reload-added'].durationMs > 0, `the added space's row says it took ${by['reload-added'].durationMs} ms: a duration that was not measured`);
  });
});
