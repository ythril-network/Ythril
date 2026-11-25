/**
 * A path guard refuses a route whose rights row is `resolved`, and only the Linked Data doors carry such a row (bundle-271, Q-758, review of
 * S3 finding 2; `auth/space-rights.ts`).
 *
 * ## What it prevents
 *
 * A `resolved` row says the space is not the path's: the door resolves it from the address and asks the rung itself
 * (`requireResolvedRung`). `enforceAreaRung` is the path guards' rung question, and it returned `true` for every scope but `path`, so a
 * `resolved` row placed on a route behind `requireSpaceAuth` lost its area rung without any gate turning red (the outside-the-api gate
 * skips `/api`). No path guard can honour that row, so it refuses it: the one rung asked of a resolved row is the door's own, and a route
 * that meets the row anywhere else is refused instead of answered.
 *
 * ## The rules
 *
 * 1. A token that reaches a space but holds no rung on the row's area is refused `403` by `requireSpaceAuth` on a route whose row is `resolved`
 *    (the planted route below carries the real row of the record address).
 * 2. The token that holds the rung is refused too: the guard has no way to honour the row, so it never lets a request through on it.
 *
 * ## Seen red
 *
 * On ce62acbbb the planted route answers 200 to both tokens. Mutation: `enforceAreaRung` returning `true` for `resolved` again.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-path-guard-refuses-a-resolved-rights-row-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { listenRouterApp } from '../_shared/in-process-app.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const S = 'resolvedrow';

let d, listening;
const keys = {};

/** A GET of `path` on the planted app by `key`. */
async function get(path, key) {
  const r = await fetch(`${listening.url}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  return { status: r.status, text: await r.text() };
}

describe('a path guard refuses a resolved rights row', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({ suite: 'resolved_row', spaces: [{ id: S, meta: rdfMeta(S) }] });
    const { requireSpaceAuth } = await import('../../server/dist/auth/middleware.js');
    const { indexRoutes } = await import('../../server/dist/http/route-map.js');
    const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
    const row = ROUTE_RIGHTS.find(r => r.scope === 'resolved' && r.method === 'GET' && r.route === '/ld/:spaceId/:kind/:id');
    assert.ok(row, 'the record address has no resolved row: re-anchor this test');
    // The planted route: the record address's pattern, behind the PATH guard that asks the row's area for the space the path names.
    const app = express();
    app.get(row.route, requireSpaceAuth, (_req, res) => { res.status(200).send('reached'); });
    indexRoutes(app);
    listening = await listenRouterApp(app);
    // Reaches the space through files and holds no rung on the row's area (knowledge); the other holds it.
    keys.noRung = (await d.mint('resolved-no-rung', { [S]: d.row({ files: 'read' }) })).key;
    keys.rung = (await d.mint('resolved-rung', { [S]: d.row({ knowledge: 'read' }) })).key;
  });
  after(async () => { await listening?.close(); await d?.close(); });

  it('a token that reaches the space and holds no rung on the row\'s area is refused', async () => {
    const r = await get(`/ld/${S}/entity/e1`, keys.noRung);
    assert.equal(r.status, 403, `the path guard let a resolved row through without its rung: ${r.status} ${r.text.slice(0, 160)}`);
  });

  it('a token that holds the rung is refused as well: a path guard cannot honour the row', async () => {
    const r = await get(`/ld/${S}/entity/e1`, keys.rung);
    assert.equal(r.status, 403, `a path guard answered a resolved row: ${r.status} ${r.text.slice(0, 160)}`);
  });
});
