/**
 * An MCP OAuth consent is refused to a token made for one purpose (Q-597).
 *
 * ## The rule
 *
 * `POST /mcp-oauth/consent` is authenticated by the access token pasted in its body. A token that is a PEER's credential (it carries
 * `peerInstanceId`) or the schema library's (`schemaLibrary`) is made for one purpose and may not approve a connector: the connector
 * token minted from its consent carries the same rights matrix and NO binding, so every `peerBoundTo()` reader and every peer-revocation
 * path takes it for the operator's own tooling, and it outlives the peer for the connector token's whole lifetime.
 *
 * Refused with a 403 BEFORE an authorization code exists, so no token can be minted from it; the refusal says what to do; the audit row
 * names the approver's token. The same refusal stands at token minting (`POST /api/tokens`): a peer token whose rights were raised may
 * not mint unbound tokens either.
 *
 * Controls: an ordinary token approves (302), and a connector token approves (D-71: a connector may approve another).
 *
 * ## How it is driven
 *
 * The real application (`appRouter`) behind a loopback server, the harness Mongo, the real OAuth flow (register, consent, PKCE exchange).
 * Written red on d079607b3: the consent answers 302 for a peer-bound token and the code exchange mints an unbound connector token.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/an-oauth-consent-refuses-a-special-purpose-approver-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
const SPACE = 'consentspace';
const REDIRECT = 'http://127.0.0.1:9/callback';

let door, loader, tokens, server, base, app, clientId, admin;

const b64url = (buf) => buf.toString('base64url');

/** Consent with `token`, then exchange the code (when there is one) with PKCE. */
async function approve(token) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const form = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, token });
  const consent = await fetch(`${base}/mcp-oauth/consent`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
  const text = consent.status === 302 ? '' : await consent.text();
  const location = consent.headers.get('location');
  const code = location ? new URL(location).searchParams.get('code') : null;
  let minted = null;
  if (code) {
    const exchange = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }).toString(),
    });
    minted = { status: exchange.status, body: await exchange.json() };
  }
  return { status: consent.status, text, location, code, minted };
}

/** The connector tokens (records with an OAuth client) in the config right now. */
const connectorTokens = () => loader.getConfig().tokens.filter(t => t.oauthClientId);

describe('an OAuth consent refuses a peer-bound or schema-library approver (real routes, real MongoDB)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    process.env['PUBLIC_BASE_URL'] = 'http://127.0.0.1:9';
    door = await openToolDoor({ suite: 'consentrefuse', spaces: [{ id: SPACE, label: 'Consent', folders: [] }] });
    loader = await import('../../server/dist/config/loader.js');
    tokens = await import('../../server/dist/auth/tokens.js');
    admin = await tokens.createToken({ name: 'consent-admin', admin: true });
    app = await appRouter();
    server = await listenOnLoopback(http.createServer((req, res) => { app.router(req, res); }));
    base = server.url;
    const r = await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Refusal connector', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
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

  describe('controls: what must keep working', () => {
    it('an ordinary token approves, and the code exchange mints a connector token', async () => {
      const own = await tokens.createToken({ name: 'plain-pat', spaces: [SPACE] });
      const before = connectorTokens().length;
      const out = await approve(own.plaintext);
      assert.equal(out.status, 302, `an ordinary token's consent was answered ${out.status}`);
      assert.equal(out.minted?.status, 200, `the code exchange was answered ${JSON.stringify(out.minted)}`);
      assert.equal(connectorTokens().length, before + 1, 'no connector token was minted');
    });

    it('a connector token approves another connector (D-71)', async () => {
      const own = await tokens.createToken({ name: 'plain-pat-2', spaces: [SPACE] });
      const first = await approve(own.plaintext);
      assert.equal(first.minted?.status, 200, `fixture check: the first connector was not minted: ${JSON.stringify(first.minted)}`);
      const connector = first.minted.body.access_token;
      assert.ok(String(connector).startsWith('ythril_'), 'fixture check: the connector token is not a ythril_ token');
      const second = await approve(connector);
      assert.equal(second.status, 302, `a connector token's consent was answered ${second.status}`);
    });
  });

  describe('the refusal', () => {
    for (const [what, make] of [
      ['a peer-bound token', () => tokens.createToken({ name: 'peer-inbound', peerInstanceId: 'peer-instance-597', spaces: [SPACE] })],
      ['a peer-bound token with admin rights', () => tokens.createToken({ name: 'peer-inbound-admin', peerInstanceId: 'peer-instance-597b', admin: true })],
      ['a schema-library token', () => tokens.createToken({ name: 'schema-lib-597', schemaLibrary: true })],
    ]) {
      it(`${what}: 403, no authorization code, no connector token minted`, async () => {
        const approver = await make();
        const before = connectorTokens().map(t => t.id);
        const out = await approve(approver.plaintext);
        assert.equal(out.status, 403, `${what} was answered ${out.status}: ${out.text.slice(0, 200)}`);
        assert.equal(out.code, null, 'an authorization code was issued to a special-purpose approver');
        assert.equal(out.location, null, 'the refusal redirected');
        assert.deepEqual(connectorTokens().map(t => t.id), before, 'a connector token appeared in the config');
      });

      it(`${what}: the answer says what to do, and the audit row names the approver's token`, async () => {
        const approver = await make();
        const rowsBefore = (await auditRowsOf(door.mongo, { operation: 'mcp.oauth.consent' })).length;
        const out = await approve(approver.plaintext);
        assert.match(out.text, /cannot approve a connector/i, `the refusal does not say why: ${out.text.slice(0, 300)}`);
        assert.match(out.text, /own access token/i, 'the refusal does not say what to do');
        const rows = (await auditRowsOf(door.mongo, { operation: 'mcp.oauth.consent' })).slice(rowsBefore);
        assert.deepEqual(rows.map(r => [r.status, r.tokenId]), [[403, approver.record.id]],
          `want one refused consent row naming the approver: ${JSON.stringify(rows)}`);
      });
    }

  });

  describe('minting through the token route', () => {
    const mint = (bearer) => fetch(`${base}/api/tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ name: 'minted-by-a-special-purpose-token' }),
    });

    it('an ordinary admin token mints (a control)', async () => {
      const r = await mint(admin.plaintext);
      assert.ok(r.status >= 200 && r.status < 300, `the control mint was answered ${r.status}: ${await r.text()}`);
    });

    it('a peer-bound token whose rights were raised to admin may not mint an unbound token', async () => {
      const peer = await tokens.createToken({ name: 'peer-raised', peerInstanceId: 'peer-instance-597d', admin: true });
      const before = loader.getConfig().tokens.length;
      const r = await mint(peer.plaintext);
      assert.equal(r.status, 403, `a peer-bound admin token minted: ${r.status} ${(await r.text()).slice(0, 200)}`);
      assert.equal(loader.getConfig().tokens.length, before, 'a token record was written');
    });

    it('a schema-library token may not mint either', async () => {
      const lib = await tokens.createToken({ name: 'schema-lib-raised', schemaLibrary: true, admin: true });
      const r = await mint(lib.plaintext);
      assert.equal(r.status, 403, `a schema-library token minted: ${r.status} ${(await r.text()).slice(0, 200)}`);
    });
  });
});
