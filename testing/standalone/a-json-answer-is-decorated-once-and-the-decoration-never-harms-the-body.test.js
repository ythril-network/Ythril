/**
 * `decorateJsonAnswer` decorates a JSON answer once per request, copies and never mutates, never throws, and stacks under
 * `statesRetryability`; `answerLeftARecord` is the one predicate for which 5xx answers still carry the rows
 * (bundle-128, Q-320; design-v3 section 2a, V5 and V6).
 *
 * ## What it prevents
 *
 * The unknown-field judge puts rows on every answer a route gives after the judge ran, and a route has about fifteen
 * `res.status(400).json(...)` sites. One wrapper on `res.json` is what lets none of them remember. `statesRetryability`
 * (`api/brain/_read-failure.ts`) already wraps `res.json` the same way, so the shape is extracted into one module and both use
 * it; two hand-written wrappers would differ in the half nobody remembers. What the module does not let a caller drop:
 *
 * - **plain objects only**: an array, a string, a number or `null` is passed through and never handed to the decorator;
 * - **copies, never mutates**: some route bodies are shared constants, and a decorator that writes to its argument (a bad one)
 *   must not change what the NEXT request is answered with;
 * - **never throws**: a decorator that throws leaves the answer exactly as the route gave it, and the failure is said once
 *   (`warnOnce`), never silently and never as a 500 over a write that landed;
 * - **one wrapper per request per decorator**: a second install of the same decorator on one request does not stack, so the rows
 *   are not added twice;
 * - **stacking**: installed after `statesRetryability`, the decorator runs first and the retryability wrapper then adds
 *   `retryable`; both copy.
 *
 * `answerLeftARecord(body)` is true for a body carrying `written` (the `ConnectionsNotWritten` answer: the record is stored although
 * the status is 5xx, so it carries the rows) and false for a plain store-failure body, which `sendCaughtFailure` keeps generic on
 * purpose.
 *
 * ## The signature this file PINS
 *
 * The plan names the module (`api/decorate-json-answer.ts`), its contract and `answerLeftARecord(body)`, and says the decorator "is
 * given `(status, body)`", but not the call that installs one. This test fixes it, so the implementation is built to it:
 *
 *     decorateJsonAnswer(res, key, decorate)   // key: a string naming the decorator; decorate: (status, body) => body
 *
 * and the module exports `decorateJsonAnswer` and `answerLeftARecord`.
 *
 * ## Through the real Express application
 *
 * The cases run over HTTP against an Express 5 app (the one the server is built on), with the real `statesRetryability`
 * middleware in front, not against a stub of `res`. The cases that go through the server's own routes are
 * `an-unknown-field-rides-every-answer-after-the-judge-db.test.js`.
 *
 * ## Red on the unchanged base
 *
 * `server/dist/api/decorate-json-answer.js` does not exist: every case fails on that import, which is the planned red.
 *
 * Run: node --test testing/standalone/a-json-answer-is-decorated-once-and-the-decoration-never-harms-the-body.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const express = createRequire(path.resolve('server/package.json'))('express');

let mod, statesRetryability, server, base;

/** One request through the app, answered as JSON. */
async function get(route, init) {
  const r = await fetch(`${base}${route}`, init);
  return { status: r.status, body: await r.json() };
}

/** A body shared between requests, as some routes keep one (`const NOT_FOUND = { error: ... }`). */
const SHARED = { error: 'shared constant', n: 1 };

describe('decorateJsonAnswer', () => {
  before(async () => {
    mod = await import('../../server/dist/api/decorate-json-answer.js');
    ({ statesRetryability } = await import('../../server/dist/api/brain/_read-failure.js'));
    const app = express();
    app.use(statesRetryability);

    // Success: the decorator is given the status the route set, and its result is what is sent.
    app.get('/ok', (req, res) => {
      mod.decorateJsonAnswer(res, 'rows', (status, body) => ({ ...body, seenStatus: status, rows: ['a'] }));
      res.json({ id: 'x' });
    });
    // A refusal and a 412 and a 5xx: the decorator sees each status and decides nothing itself.
    for (const status of [400, 404, 412, 422, 503]) {
      app.get(`/status-${status}`, (req, res) => {
        mod.decorateJsonAnswer(res, 'rows', (s, body) => ({ ...body, seenStatus: s, rows: ['a'] }));
        res.status(status).json({ error: `status ${status}` });
      });
    }
    // Not plain objects: the decorator must never be called for them.
    app.get('/array', (req, res) => {
      mod.decorateJsonAnswer(res, 'rows', () => { throw new Error('the decorator was handed an array'); });
      res.json([1, 2, 3]);
    });
    app.get('/string', (req, res) => {
      mod.decorateJsonAnswer(res, 'rows', () => { throw new Error('the decorator was handed a string'); });
      res.json('plain text');
    });
    app.get('/null', (req, res) => {
      mod.decorateJsonAnswer(res, 'rows', () => { throw new Error('the decorator was handed null'); });
      res.json(null);
    });
    app.get('/number', (req, res) => {
      mod.decorateJsonAnswer(res, 'rows', () => { throw new Error('the decorator was handed a number'); });
      res.json(7);
    });
    // A decorator that MUTATES what it is handed, on a body shared between requests.
    app.get('/shared-mutating', (req, res) => {
      mod.decorateJsonAnswer(res, 'rows', (status, body) => { body['mutated'] = true; return body; });
      res.json(SHARED);
    });
    // A decorator that throws.
    app.get('/throws', (req, res) => {
      mod.decorateJsonAnswer(res, 'throws-once', () => { throw new Error('decorator failure that must not become an answer'); });
      res.status(409).json({ error: 'as the route gave it' });
    });
    // The same decorator installed twice on one request, and two decorators.
    const calls = { twice: 0 };
    app.get('/twice', (req, res) => {
      for (let i = 0; i < 2; i++) mod.decorateJsonAnswer(res, 'twice', (s, body) => { calls.twice++; return { ...body, rows: [...(body.rows ?? []), 'r'] }; });
      res.json({ id: 'twice' });
    });
    app.get('/two-decorators', (req, res) => {
      mod.decorateJsonAnswer(res, 'one', (s, body) => ({ ...body, one: true }));
      mod.decorateJsonAnswer(res, 'two', (s, body) => ({ ...body, two: true }));
      res.json({ id: 'both' });
    });
    app.get('/calls', (req, res) => res.json({ twice: calls.twice }));
    // `retryable` already stated by the route is left as the route stated it.
    app.get('/stated-retryable', (req, res) => {
      mod.decorateJsonAnswer(res, 'rows', (s, body) => ({ ...body, rows: ['a'] }));
      res.status(503).json({ error: 'store', retryable: false });
    });
    server = await listenOnLoopback(http.createServer(app));
    base = server.url;
  });
  after(async () => { await server?.close(); });

  it('the module exports the two functions this file pins', () => {
    assert.equal(typeof mod.decorateJsonAnswer, 'function');
    assert.equal(typeof mod.answerLeftARecord, 'function');
  });

  it('a success body is decorated, and the decorator is given the status the route set', async () => {
    const r = await get('/ok');
    assert.deepEqual(r, { status: 200, body: { id: 'x', seenStatus: 200, rows: ['a'] } });
  });

  for (const status of [400, 404, 412, 422, 503]) {
    it(`a ${status} body is decorated too, and keeps its status${status >= 500 ? ', with retryable stated beside the rows' : ''}`, async () => {
      const r = await get(`/status-${status}`);
      assert.equal(r.status, status);
      assert.equal(r.body.error, `status ${status}`);
      assert.deepEqual(r.body.rows, ['a'], `the ${status} answer lost its decoration`);
      assert.equal(r.body.seenStatus, status);
      // statesRetryability is in front: 4xx not retryable, 5xx retryable, and the decorated body survives its copy.
      assert.equal(r.body.retryable, status >= 500, 'statesRetryability did not run over the decorated body');
    });
  }

  it('a retryable the route already stated is left as stated, beside the decoration', async () => {
    const r = await get('/stated-retryable');
    assert.equal(r.status, 503);
    assert.equal(r.body.retryable, false);
    assert.deepEqual(r.body.rows, ['a']);
  });

  for (const [route, expected] of [['/array', [1, 2, 3]], ['/string', 'plain text'], ['/null', null], ['/number', 7]]) {
    it(`${route.slice(1)} is passed through and never handed to the decorator`, async () => {
      const r = await get(route);
      assert.equal(r.status, 200, `the decorator threw on a body that is not a plain object, and the answer was ${r.status}`);
      assert.deepEqual(r.body, expected);
    });
  }

  it('a decorator that mutates its argument cannot change a body the route shares between requests', async () => {
    const first = await get('/shared-mutating');
    const second = await get('/shared-mutating');
    assert.deepEqual(SHARED, { error: 'shared constant', n: 1 }, 'the shared constant was written to by a decorator');
    assert.deepEqual(first.body, second.body, 'two requests for one constant body were answered differently');
    assert.equal(first.body.error, 'shared constant');
  });

  it('a decorator that throws leaves the answer as the route gave it, and says so once, not once per request', async () => {
    const { lines, result } = await logLinesDuring(async () => [await get('/throws'), await get('/throws'), await get('/throws')]);
    for (const r of result) {
      assert.deepEqual(r, { status: 409, body: { error: 'as the route gave it', retryable: false } },
        'a throwing decorator changed the status or the body: it must not become a 500 over a write that landed');
    }
    const said = lines.filter(l => /decorat/i.test(l));
    assert.equal(said.length, 1, `the failure must be said once through warnOnce, never silently and never per request: ${JSON.stringify(lines)}`);
  });

  it('the same decorator installed twice on one request is applied once', async () => {
    const before = (await get('/calls')).body.twice;
    const r = await get('/twice');
    const after = (await get('/calls')).body.twice;
    assert.deepEqual(r.body.rows, ['r'], `the rows were added ${r.body.rows?.length} times`);
    assert.equal(after - before, 1, 'the decorator ran more than once for one answer');
  });

  it('two different decorators on one request both apply', async () => {
    const r = await get('/two-decorators');
    assert.deepEqual(r.body, { id: 'both', one: true, two: true });
  });
});

describe('answerLeftARecord says which answers still carry the rows although they are 5xx', () => {
  before(async () => {
    mod = await import('../../server/dist/api/decorate-json-answer.js');
  });

  const WRITTEN = { kind: 'entity', id: 'e-1', edges: [] };
  const TABLE = [
    ['the ConnectionsNotWritten answer (a record landed, its connections did not)',
      { error: 'The entity was stored as e-1, but its connections were not all written.', retryable: false, written: WRITTEN }, true],
    ['the same answer with the cause\'s own words', { error: 'x', retryable: false, written: WRITTEN, refusal: 'a reference', code: 1 }, true],
    ['a plain store failure (nothing was stored; the body is generic on purpose)', { error: 'The store is not answering. Try again shortly.', retryable: true }, false],
    ['an empty object', {}, false],
    ['written present and null', { error: 'x', written: null }, false],
    ['null', null, false],
    ['a string', 'written', false],
    ['an array', [{ written: WRITTEN }], false],
    ['undefined', undefined, false],
  ];
  for (const [label, body, expected] of TABLE) {
    it(`${label}: ${expected}`, () => {
      assert.equal(mod.answerLeftARecord(body), expected);
    });
  }
});
