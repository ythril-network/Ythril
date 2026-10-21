/**
 * A REST record write that a standing space act refuses answers `409` with the act's code on EVERY route, never `500` (bundle-157, Q-560
 * finding 1).
 *
 * ## The defect this holds
 *
 * bundle-157's verify drive (2026-10-21, HEAD 1efed168): during a standing restore, `POST /api/brain/spaces/:id/facts`, `/chrono` and
 * `/bulk` answered `500 Internal server error`, and the server log read `Unhandled error: SpaceNotWritableError`. The same write on
 * `/entities` answered `409 space_being_restored`. The routes that answered 500 rethrow to the app's final error handler, which mapped a
 * store failure and a write refusal but not the write gate's refusal; the routes that answered 409 catch through `sendCaughtFailure`,
 * which does. One rule (the write gate's refusal is a 409 with the act's code) and two implementations, the weaker one winning.
 *
 * ## The rule, not the site
 *
 * The subjects are DERIVED: every mounted non-GET route under `/api/brain/spaces/:spaceId/` (`_routes.mjs`, the mount graph, floored).
 * Each is either a row in {@link REQUESTS} (how to ask it for one valid write of a record) or a row in {@link NOT_A_RECORD_WRITE} with
 * the reason it is not one, and a derived route in neither fails the test, so a route mounted next month is asked the day it is mounted.
 * A request is literal fixture, as fixtures may be. Every requested route, while a `restore` act stands for the space, answers `409`
 * with `code: 'space_being_restored'` (the code `SPACE_ACT_KINDS.restore.writeRefusalCode` names, read from the build), and the record
 * it would have written is not stored. The MCP door is asked the same write (`save_fact`) and must answer the same status and code, so
 * both doors are held to the rule in one test.
 *
 * The app is the real `createApp()` on loopback, the caller an instance admin (a standing restore holds maintenance, which an instance
 * admin passes), the act a `restore` entry stood up on the live config as the runner's registration leaves it (`_space-act-harness.mjs`);
 * the runner is never started, so the act stands for the whole test.
 *
 * ## Seen red
 *
 * On 1efed168 sixteen of the seventeen derived routes answer `500 {"error":"Internal server error"}`, each logging `Unhandled error:
 * SpaceNotWritableError`: the verify drive's three were the ones it happened to try. Only `POST .../entities` answers `409
 * space_being_restored`. Every update, delete, merge, link and file-metadata route reaches the same final handler.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-write-a-standing-act-refuses-answers-409-on-every-rest-record-route-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { mountedRoutes } from './_routes.mjs';
import { seedActEntry, clearActEntries } from './_space-act-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'actheld409';
const PREFIX = '/api/brain/spaces/:spaceId/';
const FLOOR = 15;

/**
 * One valid write per route, as `{ params, query, body }`. The ids name records seeded below, so an update, a delete or a merge reaches the
 * writer rather than a 404.
 */
const REQUESTS = {
  'POST /api/brain/spaces/:spaceId/facts': { body: { fact: 'written during the restore', tags: [] }, coll: 'facts', match: { fact: 'written during the restore' } },
  'PATCH /api/brain/spaces/:spaceId/facts/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000f1' }, body: { fact: 'changed during the restore' }, coll: 'facts', match: { fact: 'changed during the restore' } },
  'DELETE /api/brain/spaces/:spaceId/facts/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000f2' }, gone: { coll: 'facts', _id: 'aaaaaaaa-0000-4000-8000-0000000000f2' } },
  'POST /api/brain/spaces/:spaceId/entities': { body: { name: 'Written during', type: 'concept' }, coll: 'entities', match: { name: 'Written during' } },
  'PATCH /api/brain/spaces/:spaceId/entities/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000e1' }, body: { name: 'Changed during' }, coll: 'entities', match: { name: 'Changed during' } },
  'DELETE /api/brain/spaces/:spaceId/entities/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000e2' }, gone: { coll: 'entities', _id: 'aaaaaaaa-0000-4000-8000-0000000000e2' } },
  'POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId': { params: { survivorId: 'aaaaaaaa-0000-4000-8000-0000000000e3', absorbedId: 'aaaaaaaa-0000-4000-8000-0000000000e4' }, body: {}, gone: { coll: 'entities', _id: 'aaaaaaaa-0000-4000-8000-0000000000e4' } },
  'POST /api/brain/spaces/:spaceId/edges': { body: { from: 'aaaaaaaa-0000-4000-8000-0000000000e1', to: 'aaaaaaaa-0000-4000-8000-0000000000e3', label: 'written_during' }, coll: 'edges', match: { label: 'written_during' } },
  'PATCH /api/brain/spaces/:spaceId/edges/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000a1' }, body: { label: 'changed_during' }, coll: 'edges', match: { label: 'changed_during' } },
  'DELETE /api/brain/spaces/:spaceId/edges/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000a2' }, gone: { coll: 'edges', _id: 'aaaaaaaa-0000-4000-8000-0000000000a2' } },
  'POST /api/brain/spaces/:spaceId/chrono': { body: { title: 'Written during', type: 'event', startsAt: '2026-10-21T00:00:00.000Z' }, coll: 'chrono', match: { title: 'Written during' } },
  'PATCH /api/brain/spaces/:spaceId/chrono/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000c1' }, body: { title: 'Changed during' }, coll: 'chrono', match: { title: 'Changed during' } },
  'DELETE /api/brain/spaces/:spaceId/chrono/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000c2' }, gone: { coll: 'chrono', _id: 'aaaaaaaa-0000-4000-8000-0000000000c2' } },
  'POST /api/brain/spaces/:spaceId/links': { body: { from: 'aaaaaaaa-0000-4000-8000-0000000000f2', fromKind: 'fact', to: 'aaaaaaaa-0000-4000-8000-0000000000e1', toKind: 'entity' }, coll: 'links', match: { from: 'aaaaaaaa-0000-4000-8000-0000000000f2', to: 'aaaaaaaa-0000-4000-8000-0000000000e1' } },
  'DELETE /api/brain/spaces/:spaceId/links/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000b1' }, gone: { coll: 'links', _id: 'aaaaaaaa-0000-4000-8000-0000000000b1' } },
  'PATCH /api/brain/spaces/:spaceId/files': { query: { path: 'held.txt' }, body: { tags: ['changed-during'] }, coll: 'files', match: { tags: 'changed-during' } },
  'POST /api/brain/spaces/:spaceId/bulk': { body: { facts: [{ fact: 'bulk during the restore' }] }, coll: 'facts', match: { fact: 'bulk during the restore' } },
};

/** Derived routes under the prefix that are not one write of a record, each with why. */
const NOT_A_RECORD_WRITE = new Map([
  ['POST /api/brain/spaces/:spaceId/traverse', 'a graph read sent as POST for its body; it writes nothing'],
  ['POST /api/brain/spaces/:spaceId/events/ticket', 'issues a short-lived ticket for the space\'s event stream; it writes no record'],
  ['POST /api/brain/spaces/:spaceId/reindex', 'rebuilds the space\'s search index; it writes no record'],
  ['POST /api/brain/spaces/:spaceId/embedding-queue/records/retry', 'requeues embedding jobs; a record\'s content is not written'],
  ['POST /api/brain/spaces/:spaceId/embedding-queue/media/retry-failed', 'requeues media jobs; a record\'s content is not written'],
  ['POST /api/brain/spaces/:spaceId/ingest', 'starts an extraction run; its records are written later by the run through the gated writers, not in this request'],
]);

const derived = mountedRoutes()
  .filter(r => r.method !== 'GET' && r.path.startsWith(PREFIX))
  .map(r => `${r.method} ${r.path}`);
const subjects = [...new Set(derived)].filter(k => !NOT_A_RECORD_WRITE.has(k));

let door, server, adminKey, wantCode;

describe('a write a standing act refuses answers 409 with its code on every REST record route (real MongoDB, real app)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'actheld409', spaces: [{ id: S, label: S, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } }] });
    const { SPACE_ACT_KINDS } = await import('../../server/dist/config/types-space-acts.js');
    wantCode = SPACE_ACT_KINDS?.restore?.writeRefusalCode;
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;

    await door.coll(S, 'facts').insertMany(['aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-0000000000f2'].map((id, i) => build.fact(S, id, i + 1)));
    await door.coll(S, 'entities').insertMany(['aaaaaaaa-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-0000000000e3', 'aaaaaaaa-0000-4000-8000-0000000000e4'].map((id, i) => build.entity(S, id, i + 1)));
    await door.coll(S, 'edges').insertMany([build.edge(S, 'aaaaaaaa-0000-4000-8000-0000000000a1', 1, { from: 'aaaaaaaa-0000-4000-8000-0000000000e1', to: 'aaaaaaaa-0000-4000-8000-0000000000e3' }), build.edge(S, 'aaaaaaaa-0000-4000-8000-0000000000a2', 2, { from: 'aaaaaaaa-0000-4000-8000-0000000000e3', to: 'aaaaaaaa-0000-4000-8000-0000000000e1' })]);
    await door.coll(S, 'chrono').insertMany(['aaaaaaaa-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-0000000000c2'].map((id, i) => build.chrono(S, id, i + 1)));
    await door.coll(S, 'links').insertOne(build.link(S, 'aaaaaaaa-0000-4000-8000-0000000000b1', 1, { from: 'aaaaaaaa-0000-4000-8000-0000000000f1', to: 'aaaaaaaa-0000-4000-8000-0000000000e1' }));
    await door.coll(S, 'files').insertOne(build.filemeta(S, 'held.txt', 1));

    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
    const loader = await import('../../server/dist/config/loader.js');
    await seedActEntry(loader, { kind: 'restore', localId: S, state: 'registered' });
  });
  after(async () => {
    try { clearActEntries(await import('../../server/dist/config/loader.js')); } catch { /* never loaded */ }
    await server?.close?.();
    await door?.close();
  });

  it('the subjects are derived from the mounts, have a floor, and every one has a request', () => {
    assert.ok(subjects.length >= FLOOR, `only ${subjects.length} record write route(s) derived under ${PREFIX}, fewer than the floor of ${FLOOR}: ${subjects.join(', ')}`);
    const missing = subjects.filter(k => !REQUESTS[k]);
    assert.deepEqual(missing, [], 'a record write route under the prefix has no request here and no reason in NOT_A_RECORD_WRITE');
    const stale = Object.keys(REQUESTS).filter(k => !subjects.includes(k));
    assert.deepEqual(stale, [], 'a request names a route the server does not mount');
    assert.equal(typeof wantCode, 'string', 'SPACE_ACT_KINDS.restore has no writeRefusalCode to compare against');
  });

  it('the MCP door answers the same write (save_fact) with the same 409 and code, so both doors are held to one rule', async () => {
    const { callTool } = await import('../../server/dist/mcp/call-tool.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const out = await callTool({ name: 'save_fact', args: { space: S, fact: 'written through MCP during the restore' },
      caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
    const sc = out.result.structuredContent ?? {};
    assert.equal(out.result.isError, true, `save_fact was taken while the restore stood: ${JSON.stringify(out.result).slice(0, 240)}`);
    assert.equal(out.status, 409, `save_fact answered ${out.status} ${JSON.stringify(out.result).slice(0, 240)}`);
    assert.equal(sc.code, wantCode, `save_fact answered code '${sc.code}', not the restore's '${wantCode}'`);
    assert.equal(await door.coll(S, 'facts').findOne({ fact: 'written through MCP during the restore' }), null, 'save_fact stored its write while the restore stood');
  });

  for (const key of subjects) {
    it(`${key} answers 409 with the restore's code while the act stands, and stores nothing`, async () => {
      const req = REQUESTS[key];
      assert.ok(req, `no request for ${key}`);
      const [method, pattern] = key.split(' ');
      const url = pattern.replace(':spaceId', S).replace(/:(\w+)/g, (_, p) => encodeURIComponent(req.params?.[p] ?? `missing-${p}`));
      const query = req.query ? `?${new URLSearchParams(req.query)}` : '';
      const res = await fetch(`${server.url}${url}${query}`, {
        method,
        headers: { Authorization: `Bearer ${adminKey}`, ...(req.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(req.body ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      assert.equal(res.status, 409, `${key} answered ${res.status} ${text.slice(0, 240)} - a write the standing restore refused is a 409, never a 500`);
      assert.equal(body?.code, wantCode, `${key} answered 409 with code '${body?.code}', not the restore's '${wantCode}'`);
      if (req.match) assert.equal(await door.coll(S, req.coll).findOne(req.match), null, `${key} stored its write while the restore stood`);
      if (req.gone) assert.ok(await door.coll(S, req.gone.coll).findOne({ _id: req.gone._id }), `${key} removed '${req.gone._id}' while the restore stood`);
    });
  }
});
