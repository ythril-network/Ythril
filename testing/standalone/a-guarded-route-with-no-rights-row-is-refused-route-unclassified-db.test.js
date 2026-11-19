/**
 * A request the rights inventory does not resolve is refused `403 route_unclassified`, proven by a request.
 *
 * ## The rule
 *
 * The area guard (`enforceAreaRung`, behind `requireSpaceAuth`) asks the inventory (`ROUTE_RIGHTS`, `NOT_AREA_SCOPED`) which rung a route needs.
 * A route nobody decided about is refused, never let through to the reach check alone: that fall-through was the permissive default the
 * feature exists to end, and it let every HEAD to a path-scoped GET route past its area. `area-rung-is-staged.test.js` reads the refusal in
 * the source text; this holds it by behaviour, since a text assertion survives an edit that moves the refusal somewhere it never runs.
 *
 * What must hold, for a token that holds every right (so only the missing row can refuse it):
 *
 *  1. a guarded route with no inventory row answers `403` with `code: "route_unclassified"` for GET, for HEAD (judged as its GET) and for
 *     a write, and its handler never runs;
 *  2. the control: a guarded route that has a row (the registered pattern of a real one) is let through and its handler runs, so the
 *     refusal is for the missing row and not for the mount, the token or the space.
 *
 * ## How it is driven
 *
 * An express app of the test's own (`listenRouterApp`), the product's `requireSpaceAuth` on routes of the test's making, a real token, the
 * harness Mongo. The invented route's registered pattern is not in the route map, so the guard reads it as the mount plus the route's own
 * path, lowercased (`registeredPathOf`), as it does for any router a test mounts.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/a-guarded-route-with-no-rights-row-is-refused-route-unclassified-db.test.js
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

/**
 * The 6.5 line has no `listenRouterApp` (main's `in-process-app.mjs`, bundle-348): the test's app is served here as that helper serves
 * it, with the product's connection settings, so the request meets the server the product runs.
 */
async function listenRouterApp(app) {
  const { configureConnections } = await import('../../server/dist/http-connections.js');
  const httpServer = http.createServer(app);
  configureConnections(httpServer);
  return listenOnLoopback(httpServer);
}

const skip = await mongoSkipReason();
const SPACE = 'unclassifiedroute';
/** A path no inventory row names, and one that is a row of the inventory (`GET /api/brain/spaces/:spaceId/stats`). */
const UNDECIDED = '/api/brain/spaces/:spaceId/a-route-nobody-classified';
const DECIDED = '/api/brain/spaces/:spaceId/stats';

let door, server, base, token;
let handlerRuns = 0;

/** One request; resolves the status and the parsed body (null when there is none). */
function ask(method, route) {
  return new Promise((resolve, reject) => {
    const p = route.replace(':spaceId', SPACE);
    const req = http.request(`${base}${p}`, { method, agent: false, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON: left null */ }
        resolve({ status: res.statusCode, body, text });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('a guarded route with no rights row is refused 403 route_unclassified (real guard, real token)', { skip }, () => {
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    door = await openToolDoor({ suite: 'unclassifiedroute', spaces: [{ id: SPACE, label: 'Unclassified', folders: [], completeLinkage: true }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { requireSpaceAuth } = await import('../../server/dist/auth/middleware.js');
    token = (await tokens.createToken({ name: 'unclassified-admin', rights: door.ADMIN })).plaintext;
    const app = express();
    const handler = (_req, res) => { handlerRuns++; res.status(200).json({ reached: true }); };
    app.get(UNDECIDED, requireSpaceAuth, handler);
    app.post(UNDECIDED, requireSpaceAuth, handler);
    app.get(DECIDED, requireSpaceAuth, handler);
    server = await listenRouterApp(app);
    base = server.url;
  });
  after(async () => {
    await server?.close();
    await door?.close();
  });

  it('the control: a guarded route that has a row is let through and its handler runs', async () => {
    handlerRuns = 0;
    const res = await ask('GET', DECIDED);
    assert.equal(res.status, 200, `the control route was refused (${res.status} ${res.text})`);
    assert.equal(handlerRuns, 1, 'the control handler did not run');
  });

  for (const method of ['GET', 'HEAD', 'POST']) {
    it(`${method} to a guarded route with no row is refused 403 route_unclassified and its handler never runs`, async () => {
      handlerRuns = 0;
      const res = await ask(method, UNDECIDED);
      assert.equal(res.status, 403, `${method} was answered ${res.status}, not refused (${res.text})`);
      if (method !== 'HEAD') assert.equal(res.body?.code, 'route_unclassified', `the refusal does not carry its code: ${res.text}`);
      assert.equal(handlerRuns, 0, 'the handler of an unclassified route ran');
    });
  }
});
