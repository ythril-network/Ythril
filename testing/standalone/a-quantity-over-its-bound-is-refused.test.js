/**
 * A quantity over its bound is REFUSED, by name, on every door that takes it (`Q-108`).
 *
 * `every-quantity-a-caller-sends-has-a-bound.test.js` reads the schemas; this exercises the validators that run —
 * the shared ones both doors call (`shapeError`, `connectionInputError`, `validateDeleteFields`, the sync ingest
 * schemas, `loadConversation`) and the per-capability ones that validate by hand. Each case sends ONE past the
 * bound and requires a refusal naming the field, then sends exactly the bound and requires it accepted: a bound
 * that refuses everything passes the first half, and one that refuses nothing passes the second.
 *
 * Fixtures are literal numbers on purpose — a fixture that reads the bound from the code under test asserts that
 * the code equals itself (`CLAUDE.md`, *A test fixture is allowed to be literal*).
 *
 * Run: node --test testing/standalone/a-quantity-over-its-bound-is-refused.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stripComments } from './_strip-comments.mjs';
import { shapeError } from '../../server/dist/brain/write-shape.js';
import { connectionInputError } from '../../server/dist/brain/write-connections.js';
import { validateDeleteFields } from '../../server/dist/brain/delete-fields.js';
import { IncomingFactDoc, IncomingEntityDoc } from '../../server/dist/api/sync/_shared.js';
import { loadConversation } from '../../server/dist/extractor/conversation/load.js';

const load = async (path) => import(path).catch(err => ({ __missing: err.message }));
const notify = await load('../../server/dist/api/notify.js');
const conflicts = await load('../../server/dist/api/conflicts.js');
const runs = await load('../../server/dist/extractor/ingest-runs.js');
const sse = await load('../../server/dist/util/sse-stream.js');
const query = await load('../../server/dist/brain/query.js');

const strings = (n, f = i => `t${i}`) => Array.from({ length: n }, (_, i) => f(i));
const refusesNaming = (err, field) => {
  assert.ok(typeof err === 'string' && err.includes(field), `expected a refusal naming \`${field}\`, got ${JSON.stringify(err)}`);
};

describe('a quantity over its bound is refused, by name', () => {
  it('tags: 100 on every record type, both doors (shapeError), and on an inline edge', () => {
    for (const type of ['fact', 'entity', 'edge', 'chrono']) {
      refusesNaming(shapeError(type, { tags: strings(101) }), 'tags');
      assert.equal(shapeError(type, { tags: strings(100) }), null, `${type}: 100 tags must be accepted`);
    }
    const edge = (tags) => ({ edges: [{ to: randomUUID(), label: 'knows', tags }] });
    refusesNaming(connectionInputError(edge(strings(101)), { strict: false }), 'tags');
    assert.equal(connectionInputError(edge(strings(100)), { strict: false }), null);
  });

  it('link targets: 1000 per link field', () => {
    for (const field of ['linkEntities', 'linkFacts', 'linkChronos']) {
      refusesNaming(connectionInputError({ [field]: strings(1001, () => randomUUID()) }, { strict: false }), field);
      assert.equal(connectionInputError({ [field]: strings(1000, () => randomUUID()) }, { strict: false }), null);
    }
  });

  it('inline edges: 500 per record', () => {
    const edges = n => ({ edges: strings(n, () => ({ to: randomUUID(), label: 'knows' })) });
    refusesNaming(connectionInputError(edges(501), { strict: false }), 'edges');
    assert.equal(connectionInputError(edges(500), { strict: false }), null);
  });

  it('deleteFields: 100 paths', () => {
    const r = validateDeleteFields(strings(101, i => `properties.k${i}`));
    assert.equal(r.ok, false);
    refusesNaming(r.error, 'deleteFields');
    assert.equal(validateDeleteFields(strings(100, i => `properties.k${i}`)).ok, true);
  });

  it('the sync door holds a fact to the write doors\' 50 000 characters, and its tags to the same 100', () => {
    const doc = (fact, tags = []) => ({
      _id: randomUUID(), spaceId: 's', fact, tags, author: { instanceId: 'i', instanceLabel: 'l' },
      createdAt: 'x', updatedAt: 'x', seq: 1,
    });
    assert.equal(IncomingFactDoc.safeParse(doc('a'.repeat(50_001))).success, false, 'a 50 001-character fact must be refused on push');
    assert.equal(IncomingFactDoc.safeParse(doc('a'.repeat(50_000))).success, true);
    assert.equal(IncomingFactDoc.safeParse(doc('a', strings(101))).success, false);
    assert.equal(IncomingEntityDoc.safeParse({ _id: randomUUID(), spaceId: 's', name: 'n', type: 't', tags: strings(101),
      author: { instanceId: 'i', instanceLabel: 'l' }, createdAt: 'x', updatedAt: 'x', seq: 1 }).success, false);
  });

  it('ingest: 1000 sessions and 20 000 turns per conversation', () => {
    const session = (turns) => ({ date: '2026-01-01', turns: strings(turns, i => ({ speaker: 'a', text: `t${i}` })) });
    assert.throws(() => loadConversation({ sessions: strings(1001, () => session(1)) }), /sessions/);
    assert.doesNotThrow(() => loadConversation({ sessions: strings(1000, () => session(1)) }));
    assert.throws(() => loadConversation({ sessions: strings(20, () => session(1001)) }), /turns/);
    assert.doesNotThrow(() => loadConversation({ sessions: strings(20, () => session(1000)) }));
  });

  it('ingest: at most 4 runs unfinished at once, and a finished run frees its slot', () => {
    assert.ok(runs.IngestRuns, `ingest-runs does not load: ${runs.__missing}`);
    const r = new runs.IngestRuns();
    const made = strings(4, () => r.create('s'));
    assert.ok(made.every(Boolean), 'the first four runs must start');
    assert.throws(() => r.create('s'), /ingest runs? .*in progress|at most 4/i, 'a fifth unfinished run must be refused');
    made[0].phase = 'done';
    assert.ok(r.create('s'), 'a finished run frees its slot');
  });

  it('notify: a `data` over 8 KiB is refused, and the ring is held to 1 MiB whatever the count', () => {
    assert.ok(notify.notifyDataError && notify.notifyRing, `api/notify exports no notifyDataError/notifyRing: ${notify.__missing ?? ''}`);
    refusesNaming(notify.notifyDataError({ blob: 'x'.repeat(9 * 1024) }), 'data');
    assert.equal(notify.notifyDataError({ spaceId: 's', spaceLabel: 'l' }), null);
    for (let i = 0; i < 400; i++) {
      notify.notifyRing.push({ id: `${i}`, networkId: 'n', instanceId: 'i', event: 'ping', data: { blob: 'x'.repeat(8000) }, receivedAt: 'x' });
    }
    assert.ok(notify.notifyRing.bytes() <= 1024 * 1024, `the ring holds ${notify.notifyRing.bytes()} bytes`);
    assert.ok(notify.notifyRing.list().length > 0 && notify.notifyRing.list().length < 400, 'the ring evicts by bytes, oldest first');
  });

  it('conflicts bulk-resolve: 2000 ids, each a string', () => {
    assert.ok(conflicts.bulkResolveBodyError, `api/conflicts exports no bulkResolveBodyError: ${conflicts.__missing ?? ''}`);
    refusesNaming(conflicts.bulkResolveBodyError({ ids: strings(2001), action: 'keep-local' }), 'ids');
    refusesNaming(conflicts.bulkResolveBodyError({ ids: [1, 2], action: 'keep-local' }), 'ids');
    assert.equal(conflicts.bulkResolveBodyError({ ids: strings(2000), action: 'keep-local' }), null);
  });

  it('an unknown tool is refused BEFORE its name becomes a metric label', () => {
    const src = stripComments(readFileSync('server/src/mcp/call-tool.ts', 'utf8'));
    const refusal = src.search(/if\s*\(\s*!tool\s*\)\s*\{?\s*return refuse\(404/);
    const label = src.indexOf('toolCallsTotal.inc(');
    assert.ok(refusal > 0 && label > 0, 're-anchor: the unknown-tool refusal or the metric increment moved');
    assert.ok(refusal < label, 'the caller-supplied tool name reaches `toolCallsTotal` before the 404 — unbounded label cardinality');
  });

  it('SSE: a stream kind admits at most 200 connections, and a reader 256 KiB behind is closed', () => {
    assert.ok(sse.openEventStream, `util/sse-stream does not load: ${sse.__missing}`);
    const fakeRes = () => {
      const res = { status: 0, headers: null, writableLength: 0, destroyed: false, ended: false, written: [],
        writeHead(s, h) { this.status = s; this.headers = h; return this; },
        status_(s) { this.status = s; return this; },
        json(b) { this.body = b; this.ended = true; },
        write(chunk) { this.written.push(chunk); return true; },
        end() { this.ended = true; this.destroyed = true; },
        setHeader() {}, };
      res.status = function (s) { this.statusCode = s; return this; };
      return res;
    };
    const fakeReq = () => { const handlers = {}; return { on(e, f) { handlers[e] = f; }, close() { handlers.close?.(); } }; };
    const pool = `test-${randomUUID()}`;
    const open = [];
    for (let i = 0; i < 200; i++) {
      const req = fakeReq(); const res = fakeRes();
      open.push({ req, res, stream: sse.openEventStream(req, res, { pool }) });
    }
    assert.ok(open.every(o => o.stream), 'the first 200 streams must open');
    const refusedRes = fakeRes();
    assert.equal(sse.openEventStream(fakeReq(), refusedRes, { pool }), null, 'the 201st must be refused');
    assert.equal(refusedRes.statusCode, 503);
    open[0].req.close();
    assert.ok(sse.openEventStream(fakeReq(), fakeRes(), { pool }), 'a closed stream frees its slot');

    const slow = open[1];
    slow.res.writableLength = 300 * 1024;
    slow.stream.send('data: x\n\n');
    assert.ok(slow.res.ended, 'a reader past the buffer bound is closed rather than buffered for');
  });

  it('filter: a single-space read stops at twice the byte budget instead of reading `limit` rows', async () => {
    assert.ok(query.readWithinBound, `brain/query exports no readWithinBound: ${query.__missing ?? ''}`);
    let yielded = 0;
    async function* docs() { for (let i = 0; i < 100_000; i++) { yielded++; yield { _id: `${i}`, body: 'x'.repeat(1000) }; } }
    const { rows, cut } = await query.readWithinBound(docs(), { chars: 10_000, bytes: null });
    assert.equal(cut, true);
    assert.ok(rows.length >= 10 && rows.length <= 25, `read ${rows.length} rows for a 10 000-character budget`);
    assert.ok(yielded <= rows.length + 1, `the cursor was drained past the bound (${yielded} documents read)`);
    const small = await query.readWithinBound((async function* () { yield { a: 1 }; yield { a: 2 }; })(), { chars: 10_000, bytes: null });
    assert.deepEqual(small, { rows: [{ a: 1 }, { a: 2 }], cut: false });
  });
});
