/**
 * During maintenance the web client itself loads for any caller, and the API and MCP stay held for everyone but an instance
 * administrator (bundle-157, Q-560 finding 2).
 *
 * ## The defect this holds
 *
 * bundle-157's verify drive (2026-10-21, HEAD 1efed168): a restore holds the instance in maintenance until its last space's act ends, and
 * the one caller who can act on a stuck restore is an instance administrator in the web client (the danger tab's abandon). But
 * `maintenanceMiddleware` is mounted before every router, the client's static files and SPA fallback included, and judges a browser's
 * page load as it judges an API call: a plain page request carries no bearer, so it is not an admin's and gets the 503 JSON. The admin
 * cannot load the page that would end the maintenance.
 *
 * ## The rule
 *
 * While maintenance holds, a `GET` or `HEAD` whose path is not `/api`, not under `/api/`, and not `/mcp` or under it passes for ANY
 * caller: the client bundle holds no data, and everything it shows it reads through `/api`, which stays held. Everything else is as it
 * was: a non-admin is refused `503 { maintenance: true }` on the API, MCP and any write; an instance admin passes; the probes and
 * `/api/admin/*` pass.
 *
 * The middleware is the unit, called with a request as express hands it over: it reads the request's method, path and auth and nothing
 * else, so no app and no database are needed. A row passes when the middleware calls `next()`, and is refused when it answers 503.
 *
 * ## Seen red
 *
 * On 1efed168 the page-load rows (`GET /`, `GET /index.html`, a hashed bundle, a client route, `HEAD /`) answer 503 for a caller with
 * no bearer.
 *
 * Run: `node --test testing/standalone/the-web-client-loads-during-maintenance-and-the-api-stays-held.test.js` (a prior `npm run build`
 * in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-maint-client-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const ADMIN = { rights: { instanceAdmin: true } };
const NOT_ADMIN = { rights: { instanceAdmin: false } };

/** Rows that must PASS for a caller with no token at all: the web client's own files. */
const CLIENT_LOADS = [
  ['GET', '/'],
  ['GET', '/index.html'],
  ['GET', '/main-3F7A2C1B.js'],
  ['GET', '/assets/icons/ythril.svg'],
  ['GET', '/brain/notes'],
  ['GET', '/settings/danger'],
  ['HEAD', '/'],
];

/** Rows that must be REFUSED for a caller that is not an instance administrator. */
const HELD = [
  ['GET', '/api/spaces'],
  ['GET', '/api'],
  ['POST', '/api/brain/spaces/notes/facts'],
  ['GET', '/mcp'],
  ['POST', '/mcp'],
  ['POST', '/mcp/notes'],
  ['POST', '/'],
  ['PUT', '/index.html'],
  ['DELETE', '/brain/notes'],
];

let maintenance;

/** Run the middleware on one request; resolves 'next' or the status it answered. */
function judge(method, p, authToken) {
  return new Promise((resolve, reject) => {
    const req = { method, path: p, url: p, originalUrl: p, headers: {}, get: () => undefined, header: () => undefined, ...(authToken ? { authToken } : {}) };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
      send(body) { resolve({ status: this.statusCode, body }); return this; },
      end() { resolve({ status: this.statusCode }); return this; },
      setHeader() { return this; },
      set() { return this; },
    };
    try { maintenance.maintenanceMiddleware(req, res, () => resolve('next')); } catch (err) { reject(err); }
  });
}

describe('the web client loads during maintenance and the API stays held', () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'maint-client-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: 'notes', label: 'notes', folders: [] }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    maintenance = await import('../../server/dist/maintenance.js');
    maintenance.setMaintenanceActive(true);
  });
  after(() => { maintenance?.setMaintenanceActive(false); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('control: maintenance is on', () => {
    assert.equal(maintenance.isMaintenanceActive(), true);
  });

  for (const [method, p] of CLIENT_LOADS) {
    it(`${method} ${p} passes for a caller with no token (the web client's own files)`, async () => {
      assert.equal(await judge(method, p), 'next', `${method} ${p} was refused during maintenance: the page an admin needs to end it cannot load`);
    });
    it(`${method} ${p} passes for a token that is not an instance admin's`, async () => {
      assert.equal(await judge(method, p, NOT_ADMIN), 'next');
    });
  }

  for (const [method, p] of HELD) {
    it(`${method} ${p} is refused 503 for a caller with no token and for a non-admin token`, async () => {
      for (const who of [undefined, NOT_ADMIN]) {
        const got = await judge(method, p, who);
        assert.notEqual(got, 'next', `${method} ${p} passed during maintenance for ${who ? 'a non-admin token' : 'no token'}`);
        assert.equal(got.status, 503);
        assert.equal(got.body?.maintenance, true);
      }
    });
    it(`${method} ${p} passes for an instance admin`, async () => {
      assert.equal(await judge(method, p, ADMIN), 'next');
    });
  }

  for (const p of ['/health', '/ready', '/metrics', '/api/admin/maintenance']) {
    it(`GET ${p} still passes for anyone`, async () => {
      assert.equal(await judge('GET', p), 'next');
    });
  }
});
