/**
 * A request Express answers is audited whatever the casing of its path or a trailing slash.
 *
 * ## The rule
 *
 * Express matches a route's literal segments without regard to case and accepts one trailing slash, so `POST /API/brain/spaces/s/facts`
 * and `DELETE /api/brain/spaces/s/facts/<id>/` reach the handlers of `/api/brain/spaces/:spaceId/facts`. The audit middleware matched its
 * rules (all case-sensitive, all ending in `$`) and its own prefix tests (`/api/`, `/mcp`) against the path as the caller TYPED it, so a
 * write answered 201 left no row, and so did a copy of the audit log (`GET /Api/admin/audit-log/export`). The rights lookup had solved the
 * same spelling question (`auth/required-rung.ts`); the audit asked it again, differently.
 *
 * What must hold:
 *
 *  1. each spelling of an audited act leaves the row of the act: a write under `/API`, a delete with a trailing slash, the audit-log export
 *     under `/Api`, a `HEAD` in mixed case (recorded as the `GET` it mirrors, `method: 'HEAD'`), and the second door (`/MCP-OAUTH/consent`);
 *  2. the recorded `path` stays as the caller sent it, and a space id keeps the caller's casing (a row is evidence of what was sent);
 *  3. reading the log itself is still not audited, whatever its spelling (the exemption is spelled the same way as the rules).
 *
 * ## How it is driven
 *
 * The real application (`appRouter`) behind a loopback server, a real instance-admin token, the harness Mongo; rows are read from
 * `audit_log` once the writer has landed them.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/an-audited-request-is-audited-however-its-path-is-spelled-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
const SPACE = 'auditspelling';
/** A space id with capitals: no such space exists, the request is refused, and the row is the subject. */
const CAPITALISED_SPACE = 'Auditspelling';

let door, server, base, app, token, tokenId;

/** One request on a connection of its own; resolves its status and body text. */
function ask(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(`${base}${p}`, {
      method, agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** The rows the token's request left under exactly this method and path, once the writer has landed them. */
async function rowsOf(method, sentPath) {
  return auditRowsOf(door.mongo, { tokenId, method, path: sentPath });
}

describe('a request is audited however its path is spelled (real routes, real MongoDB)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    door = await openToolDoor({ suite: 'auditspelling', spaces: [{ id: SPACE, label: 'Spelling', folders: [], completeLinkage: true }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    const loader = await import('../../server/dist/config/loader.js');
    // Reads are logged for the HEAD case below; the export and the writes are logged whichever way this is set.
    loader.mutateConfig(c => { c.audit = { ...(c.audit ?? {}), logReads: true }; });
    const made = await tokens.createToken({ name: 'spelling-admin', rights: door.ADMIN });
    token = made.plaintext;
    tokenId = made.record.id;
    app = await appRouter();
    server = await listenOnLoopback(http.createServer((req, res) => { app.router(req, res); }));
    base = server.url;
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await door?.close();
  });

  it('a write sent under /API leaves its fact.create row, with the path as sent', async () => {
    const sent = `/API/brain/spaces/${SPACE}/facts`;
    const res = await ask('POST', sent, { body: { fact: 'written under an upper-case mount', tags: [] } });
    assert.equal(res.status, 201, `the write was not answered 201 (${res.status} ${res.text})`);
    const rows = await rowsOf('POST', sent);
    assert.equal(rows.length, 1, `a 201 write under /API left ${rows.length} audit rows`);
    assert.equal(rows[0].operation, 'fact.create');
    assert.equal(rows[0].spaceId, SPACE);
    assert.equal(rows[0].status, 201);
  });

  it('a delete with a trailing slash leaves its fact.delete row, naming the fact, with the path as sent', async () => {
    const made = await ask('POST', `/api/brain/spaces/${SPACE}/facts`, { body: { fact: 'deleted with a trailing slash', tags: [] } });
    assert.equal(made.status, 201);
    const stored = await door.coll(SPACE, 'facts').findOne({ fact: 'deleted with a trailing slash' });
    assert.ok(stored, 'the control: the fact was stored');
    const sent = `/api/brain/spaces/${SPACE}/facts/${stored._id}/`;
    const res = await ask('DELETE', sent);
    assert.ok(res.status < 300, `the delete was not answered (${res.status} ${res.text})`);
    assert.equal(await door.coll(SPACE, 'facts').findOne({ _id: stored._id }), null, 'the fact was not deleted');
    const rows = await rowsOf('DELETE', sent);
    assert.equal(rows.length, 1, `a delete with a trailing slash left ${rows.length} audit rows`);
    assert.equal(rows[0].operation, 'fact.delete');
    assert.equal(rows[0].entryId, String(stored._id));
    assert.equal(rows[0].spaceId, SPACE);
  });

  it('a copy of the audit log taken under /Api, or with a trailing slash, leaves its audit.export row', async () => {
    for (const sent of ['/Api/admin/audit-log/export', '/api/admin/audit-log/export/', '/API/ADMIN/AUDIT-LOG/EXPORT/']) {
      const res = await ask('GET', sent);
      assert.equal(res.status, 200, `GET ${sent} was not answered 200 (${res.status} ${res.text.slice(0, 200)})`);
      const rows = await rowsOf('GET', sent);
      assert.equal(rows.length, 1, `GET ${sent} left ${rows.length} audit rows`);
      assert.equal(rows[0].operation, 'audit.export');
    }
  });

  it('a HEAD in mixed case leaves the GET\'s row, marked HEAD', async () => {
    const sent = `/API/Brain/Spaces/${SPACE}/Stats`;
    const res = await ask('HEAD', sent);
    assert.equal(res.status, 200, `HEAD ${sent} was not answered 200 (${res.status})`);
    const rows = await rowsOf('HEAD', sent);
    assert.equal(rows.length, 1, `a mixed-case HEAD left ${rows.length} audit rows`);
    assert.equal(rows[0].operation, 'brain.stats');
    assert.equal(rows[0].spaceId, SPACE);
  });

  it('a space id keeps the casing the caller sent in the row', async () => {
    const sent = `/API/admin/spaces/${CAPITALISED_SPACE}/export`;
    await ask('GET', sent);
    const rows = await rowsOf('GET', sent);
    assert.equal(rows.length, 1, `an export of a mixed-case space id left ${rows.length} audit rows`);
    assert.equal(rows[0].operation, 'space.export');
    assert.equal(rows[0].spaceId, CAPITALISED_SPACE, 'the row names the space id with the casing it was sent in');
  });

  it('the second door: a consent sent under /MCP-OAUTH leaves its mcp.oauth.consent row', async () => {
    const sent = '/MCP-OAUTH/Consent/';
    await ask('POST', sent, { body: 'decision=deny' });
    // No token row: the consent is approved by a token named in its form, so a refused form carries none (the row's `tokenId` is null).
    const rows = await auditRowsOf(door.mongo, { method: 'POST', path: sent });
    assert.equal(rows.length, 1, `a consent under /MCP-OAUTH left ${rows.length} audit rows`);
    assert.equal(rows[0].operation, 'mcp.oauth.consent');
  });

  it('reading the log is not audited, whatever its spelling, and a barrier row proves the writer had landed', async () => {
    for (const sent of ['/api/admin/audit-log', '/API/admin/Audit-Log', '/api/admin/audit-log/']) {
      const res = await ask('GET', sent);
      assert.equal(res.status, 200, `GET ${sent} (${res.status})`);
    }
    // The barrier: an audited request after them, so rows the reads would have written are on the wire before the read below.
    const barrier = `/api/brain/spaces/${SPACE}/stats`;
    assert.equal((await ask('GET', barrier)).status, 200);
    assert.equal((await rowsOf('GET', barrier)).length, 1, 'the barrier request left no row');
    const rows = (await auditRowsOf(door.mongo, { tokenId })).filter(r => /^\/api\/admin\/audit-log\/?$/i.test(r.path));
    assert.deepEqual(rows.map(r => `${r.method} ${r.path} ${r.operation}`), [], 'a read of the paged log wrote a row');
  });
});
