/**
 * A connector's record says which token approved it, and the token list echoes it (bundle-231).
 *
 * ## The rule
 *
 * `POST /mcp-oauth/consent` is authenticated by the access token pasted in its body. The connector token the code exchange mints stores that
 * approver's token id as `approvedByTokenId`, so an operator reading the token list can tell who approved a connector; `GET /api/tokens`
 * returns the field, and the client's token table badges it ("approved by ..."). A token nobody approved (a personal access token the operator
 * created) carries no such field.
 *
 * ## How it is driven
 *
 * The real application (`appRouter`) behind a loopback server, the harness Mongo, the real OAuth flow (register, consent, PKCE exchange), then the
 * real `GET /api/tokens`. The id stored is the approver RECORD's id, never the pasted plaintext: a control asserts that no listed row holds a
 * plaintext token.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/an-oauth-connector-records-its-approver-db.test.js` (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
const SPACE = 'approverspace';
const REDIRECT = 'http://127.0.0.1:9/callback';

let door, loader, tokens, server, base, app, clientId, admin;

const b64url = (buf) => buf.toString('base64url');

/** Consent with `token`, exchange the code with PKCE, and answer the connector record that was minted (found by what the config gained). */
async function approve(token) {
  const known = new Set(loader.getConfig().tokens.map(t => t.id));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const consent = await fetch(`${base}/mcp-oauth/consent`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
    body: new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, token }).toString(),
  });
  assert.equal(consent.status, 302, `fixture check: the consent was answered ${consent.status}: ${(await consent.text()).slice(0, 200)}`);
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const exchange = await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }).toString(),
  });
  const body = await exchange.json();
  assert.equal(exchange.status, 200, `fixture check: the code exchange was answered ${exchange.status}: ${JSON.stringify(body)}`);
  const minted = loader.getConfig().tokens.filter(t => !known.has(t.id) && t.oauthClientId);
  assert.equal(minted.length, 1, `fixture check: want exactly one new connector record, got ${minted.length}`);
  return { record: minted[0], plaintext: body.access_token };
}

/** `GET /api/tokens` as the admin: the listed rows by id. */
async function listed() {
  const r = await fetch(`${base}/api/tokens`, { headers: { Authorization: `Bearer ${admin.plaintext}` } });
  assert.equal(r.status, 200, `fixture check: the token list was answered ${r.status}`);
  const { tokens: rows } = await r.json();
  return new Map(rows.map(t => [t.id, t]));
}

describe('a connector records which token approved it (real routes, real MongoDB)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    process.env['PUBLIC_BASE_URL'] = 'http://127.0.0.1:9';
    door = await openToolDoor({ suite: 'connectorapprover', spaces: [{ id: SPACE, label: 'Approver', folders: [] }] });
    loader = await import('../../server/dist/config/loader.js');
    tokens = await import('../../server/dist/auth/tokens.js');
    admin = await tokens.createToken({ name: 'approver-admin', admin: true });
    app = await appRouter();
    server = await listenOnLoopback(http.createServer((req, res) => { app.router(req, res); }));
    base = server.url;
    const r = await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Approver connector', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    const body = await r.json();
    assert.ok(r.status < 300 && body.client_id, `fixture check: the client did not register: ${r.status} ${JSON.stringify(body)}`);
    clientId = body.client_id;
  });
  after(async () => {
    delete process.env['PUBLIC_BASE_URL'];
    await server?.close();
    await app?.close();
    await door?.close();
  });

  it("the connector's stored record holds the approving token's id", async () => {
    const approver = await tokens.createToken({ name: 'approver-pat', spaces: [SPACE] });
    const { record } = await approve(approver.plaintext);
    assert.equal(record.approvedByTokenId, approver.record.id, `the connector record names ${record.approvedByTokenId}, not its approver`);
  });

  it("a connector that approves another is the next one's approver", async () => {
    const approver = await tokens.createToken({ name: 'approver-pat-2', spaces: [SPACE] });
    const first = await approve(approver.plaintext);
    const second = await approve(first.plaintext);
    assert.equal(second.record.approvedByTokenId, first.record.id, 'the second connector does not name the first');
  });

  it('GET /api/tokens echoes the field on the connector and on no other row', async () => {
    const approver = await tokens.createToken({ name: 'approver-pat-3', spaces: [SPACE] });
    const { record, plaintext } = await approve(approver.plaintext);
    const rows = await listed();
    assert.equal(rows.get(record.id)?.approvedByTokenId, approver.record.id, "the list does not echo the connector's approver");
    assert.equal(rows.get(approver.record.id)?.approvedByTokenId, undefined, 'a token nobody approved carries the field');
    assert.equal(rows.get(admin.record.id)?.approvedByTokenId, undefined, "the operator's own admin token carries the field");
    const everything = JSON.stringify([...rows.values()]);
    for (const secret of [approver.plaintext, plaintext, admin.plaintext]) assert.ok(!everything.includes(secret), 'the list holds a plaintext token');
  });
});
