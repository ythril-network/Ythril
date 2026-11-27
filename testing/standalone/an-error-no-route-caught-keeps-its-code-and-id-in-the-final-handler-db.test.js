/**
 * The app's final error handler keeps a typed refusal's `code` and `id` in every answer it sends (bundle-378, Q-976, fix group C).
 *
 * ## The defect this holds
 *
 * The handler took any error with a numeric `status` first and answered `{ error }` alone. A typed 409 refusal a route does not catch
 * (`fork_row_read_only`, `fork_cap`, `endpoint_removed`, `write_race_lost`, `link_target_removed`) therefore lost the `code` a client translates and acts
 * on, and the shared mappers below that branch (a standing act, a schema refusal, a store failure) were never reached by a class that carries a `status`.
 * Fix group B found it on one route (the file-meta PATCH) and caught the error there; every other route still lost the code.
 *
 * ## The rule
 *
 * - An error a REAL route does not catch is answered with its status, its sentence and its `code`, and its `id` where the error answers one.
 *   Real routes here: `POST .../entities/:survivorId/merge/:absorbedId` throws `ForkRowReadOnly` for a fork row and `ForkCapRefusal` for forks past the
 *   cap, and its catch re-throws them (it names only a merge's own two refusals).
 * - Every typed refusal class of `util/errors.ts` that carries a `code` and a `status` is held, DERIVED from that file's source: a class added next month
 *   with no row here fails the floor below. The classes no route throws uncaught today (`write_race_lost` and `endpoint_removed` arise inside routes that catch them,
 *   which is the very reason the handler is the backstop for the next route) are thrown by a route this test puts first in the app's own stack,
 *   so the answer is the real app's real final handler and not a copy of it.
 * - A 4xx that carries a `code` of its own (a write group's ceiling) keeps it; one without (body-parser's) answers its sentence alone.
 * - A 5xx never echoes an internal message: an error with a `status` of 5xx and no `code` answers the flat `500 Internal server error`,
 *   and only a refusal that carries its own `code` answers its sentence.
 *
 * ## Seen red
 *
 * On 5711a1cee: every row but the guard answers `{ error }` with no `code`.
 *
 * Run: node --test testing/standalone/an-error-no-route-caught-keeps-its-code-and-id-in-the-final-handler-db.test.js  (a server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { seedFork, initForkFixtures } from './_fork-kinds.mjs';
import { appRouter, listenRouterApp } from '../_shared/in-process-app.mjs';
import { stripComments } from './_strip-comments.mjs';
import { REPO_ROOT } from './_sources.mjs';

const skip = await mongoSkipReason();
const S = 'b378finalerr';
const SECRET = 'the internal store host refused the socket';

describe('an error no route caught keeps its code and id in the final handler', { skip }, () => {
  let door; let app; let server; let adminKey; let E; let thrown;

  before(async () => {
    door = await openPushDoor({ suite: 'b378_finalerr', spaces: [{ id: S, label: 'FinalErr', folders: [], meta: { suppressEmbeddings: true } }] });
    await initForkFixtures();
    E = await import('../../server/dist/util/errors.js');
    const { WriteGroupTooLarge } = await import('../../server/dist/brain/write-plan/write-group.js');
    const { SparqlRefusal } = await import('../../server/dist/rdf/sparql-refusal.js');
    /** One thrower per typed class, and the answer it must get: `code`, and `id` where the class answers one. */
    thrown = {
      ForkRowReadOnly: { make: () => new E.ForkRowReadOnly('fact', 'f-1', 'f-0'), status: 409, code: 'fork_row_read_only' },
      ForkCapRefusal: { make: () => new E.ForkCapRefusal(12, 10), status: 409, code: 'fork_cap' },
      RecordWriteRaceLost: { make: () => new E.RecordWriteRaceLost('rec-1', 3), status: 409, code: 'write_race_lost', id: 'rec-1' },
      RecordWriteRaceLostWithBytes: { make: () => new E.RecordWriteRaceLost('p.txt', 3).withBytesStored(), status: 409, code: 'write_race_lost', id: 'p.txt' },
      EndpointRemoved: { make: () => new E.EndpointRemoved('ent-1', 'to'), status: 409, code: 'endpoint_removed', id: 'ent-1' },
      LinkTargetRemoved: { make: () => new E.LinkTargetRemoved('ent-2'), status: 409, code: 'link_target_removed', id: 'ent-2' },
      SchemaIndexBuilding: { make: () => new E.SchemaIndexBuilding(S), status: 503, code: 'schema_index_building' },
      SchemaVersionsBusy: { make: () => new E.SchemaVersionsBusy(S), status: 503, code: 'schema_versions_busy' },
      // A 4xx that is not one of the errors.ts classes but carries its own code: kept.
      WriteGroupTooLarge: { make: () => new WriteGroupTooLarge('bytes', 10, 20), status: 413, code: 'write_group_too_large' },
      // A 5xx refusal that names its own code says its sentence and its code.
      SparqlRefusal503: { make: () => new SparqlRefusal(503, 'sparql_unavailable_test', 'the query ended'), status: 503, code: 'sparql_unavailable_test' },
    };
    app = (await appRouter()).router;
    for (const [name, row] of Object.entries(thrown)) mountFirst(app, `/__throws/${name}`, () => { throw row.make(); });
    mountFirst(app, '/__throws/internal5xx', () => { throw Object.assign(new Error(SECRET), { status: 502 }); });
    mountFirst(app, '/__throws/request4xx', () => { throw Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' }); });
    server = await listenRouterApp(app);
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
  });
  after(async () => { await server?.close?.(); await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  /** A route first in the app's own stack: ahead of every middleware, so the error it throws reaches the app's final handler and nothing else. */
  function mountFirst(a, route, handler) {
    a.get(route, handler);
    const stack = a.router.stack;
    stack.unshift(stack.pop());
  }

  const ask = async (method, url, body) => {
    const res = await fetch(`${server.url}${url}`, {
      method, headers: { Authorization: `Bearer ${adminKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, text };
  };

  it('the typed classes are DERIVED from util/errors.ts, and every one that carries a code and a status has a row', () => {
    const src = stripComments(fs.readFileSync(path.join(REPO_ROOT, 'server/src/util/errors.ts'), 'utf8'));
    const classes = [...src.matchAll(/export class (\w+)[^{]*\{([\s\S]*?)\n\}/g)]
      .filter(([, , body]) => /readonly code\b/.test(body) && /readonly status\b/.test(body))
      .map(([, name]) => name);
    assert.ok(classes.length >= 7, `only ${classes.length} typed class(es) with a code and a status derived: ${classes}`);
    const held = new Set(Object.keys(thrown).map(k => k.replace(/WithBytes$/, '')));
    assert.deepEqual(classes.filter(c => !held.has(c)), [], 'a typed refusal class has no row in this test: the final handler is not held to keep its code');
  });

  for (const name of ['ForkRowReadOnly', 'ForkCapRefusal', 'RecordWriteRaceLost', 'RecordWriteRaceLostWithBytes', 'EndpointRemoved', 'LinkTargetRemoved',
    'SchemaIndexBuilding', 'SchemaVersionsBusy', 'WriteGroupTooLarge', 'SparqlRefusal503']) {
    it(`${name}: the final handler answers its status, its sentence, its code, and its id where the class answers one`, async () => {
      const row = thrown[name];
      const out = await ask('GET', `/__throws/${name}`);
      assert.equal(out.status, row.status, `${name} answered ${out.status} ${out.text}`);
      assert.equal(out.body?.code, row.code, `${name} lost its code: ${out.text}`);
      assert.equal(out.body?.error, row.make().message, `${name} answered another sentence: ${out.text}`);
      if (row.id) assert.equal(out.body?.id, row.id, `${name} lost its id: ${out.text}`);
    });
  }

  it('a 5xx that names no code never echoes its message: the flat 500', async () => {
    const out = await ask('GET', '/__throws/internal5xx');
    assert.equal(out.status, 500, out.text);
    assert.deepEqual(out.body, { error: 'Internal server error' });
    assert.ok(!out.text.includes(SECRET), `an internal message reached the caller: ${out.text}`);
  });

  it('a 4xx of the request itself (body-parser) answers its status and its sentence, with no code it does not carry', async () => {
    const out = await ask('GET', '/__throws/request4xx');
    assert.equal(out.status, 413, out.text);
    assert.deepEqual(out.body, { error: 'request entity too large' });
  });

  describe('real routes: the entity merge route does not catch a fork refusal', () => {
    /** An entity with `n` forks of it, named apart so each fork has its own derived id. */
    async function entityWithForks(n, tag) {
      const id = randomUUID();
      await door.coll(S, 'entities').insertOne(build.entity(S, id, 5, { pos: 5, posAtSeq: 5 }));
      const forks = [];
      for (let i = 0; i < n; i++) forks.push(await seedFork(door, S, 'entity', id, 5, { name: `${tag} version ${i}` }));
      return { id, forks };
    }

    it('merging a fork row answers 409 fork_row_read_only, and both rows are as they were', async () => {
      const { id, forks } = await entityWithForks(1, 'parent');
      const other = randomUUID();
      await door.coll(S, 'entities').insertOne(build.entity(S, other, 1));
      const before = await door.coll(S, 'entities').find({}).sort({ _id: 1 }).toArray();
      const out = await ask('POST', `/api/brain/spaces/${S}/entities/${forks[0]._id}/merge/${other}`, {});
      assert.equal(out.status, 409, `merging a fork answered ${out.status} ${out.text}`);
      assert.equal(out.body?.code, 'fork_row_read_only', `the 409 lost its code: ${out.text}`);
      assert.match(out.body?.error ?? '', /unresolved version of/);
      assert.deepEqual(await door.coll(S, 'entities').find({}).sort({ _id: 1 }).toArray(), before, `a refused merge changed rows (parent ${id})`);
    });

    it('merging two records whose forks together pass the cap answers 409 fork_cap, and nothing is merged', async () => {
      const a = await entityWithForks(6, 'survivor');
      const b = await entityWithForks(6, 'absorbed');
      const before = await door.coll(S, 'entities').find({}).sort({ _id: 1 }).toArray();
      const out = await ask('POST', `/api/brain/spaces/${S}/entities/${a.id}/merge/${b.id}`, {});
      assert.equal(out.status, 409, `a merge past the fork cap answered ${out.status} ${out.text}`);
      assert.equal(out.body?.code, 'fork_cap', `the 409 lost its code: ${out.text}`);
      assert.deepEqual(await door.coll(S, 'entities').find({}).sort({ _id: 1 }).toArray(), before, 'a refused merge changed rows');
    });
  });
});
