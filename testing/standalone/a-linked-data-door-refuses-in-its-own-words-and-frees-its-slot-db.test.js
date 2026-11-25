/**
 * The Linked Data door's own refusals are answered as RFC 9457 problems, logged by their code, and free the slot of every read that ends in
 * one (bundle-271, Q-758; lens-3 T1 and O1).
 *
 * ## The rules
 *
 * 1. **Each bound is a named refusal.** A record whose own statements pass `sparql.maxResults` is `413 sparql_too_many_results`; an agent's
 *    walk past `sparql.maxRecordsRead` is `413 sparql_too_much_read`; a read past its deadline is `503 sparql_timeout`, with `Retry-After`;
 *    a caller who finds both query slots held is `503 sparql_busy`, with `Retry-After`; an `Accept` naming no RDF format is `406
 *    rdf_format_not_acceptable`. Every body is `application/problem+json` with the code.
 * 2. **The slot is free after every ending.** After each of them (and after an answer) the caller can take its slot again: a refusal that
 *    kept it would lock the caller out until the process restarts.
 * 3. **A refusal is a log line.** The line names the code and the status, and never the address asked for.
 *
 * ## Seen red
 *
 * On d78b20280 rule 3: no line was written for any of them. Mutation (rule 2): `slot.release()` removed from `readStatements`
 * (`rdf/linked-data-act.ts`): the next read of the caller is `503 sparql_busy`.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-linked-data-door-refuses-in-its-own-words-and-frees-its-slot-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'ldrefuse';
const PUBLIC = 'https://rdf.example.org';
const TURTLE = { Accept: 'text/turtle' };
const MANY = 1_100;
const STAMP = '2026-03-04T05:06:07.000Z';
const previousPublic = process.env['PUBLIC_BASE_URL'];

let d, tok, slots, logs, stopLogs;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const setLimits = (sparql) => d.loader.mutateConfig(cfg => { cfg.sparql = sparql; });
const get = (path, headers = TURTLE) => d.sparqlRest(tok.key, 'GET', path, { headers });
/** The caller's slot is free: it can be taken (and is given back). */
const slotIsFree = () => { const s = slots.takeSlot('sparql', tok.id); s?.release(); return s !== null; };
/** The lines the door logged since `mark`. */
const logged = (mark) => logs.slice(mark);

describe('the Linked Data door refuses in its own words and frees its slot', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'lens3-ld-refuse', spaces: [{ id: S }] });
    await d.seed(S, 'entity', [
      { _id: 'two', name: 'Two statements', type: 'Person', createdAt: STAMP, updatedAt: STAMP },
      ...Array.from({ length: MANY }, (_, i) => ({ _id: `m-${i}`, name: `Many ${i}`, type: 'Person', createdAt: STAMP, updatedAt: STAMP })),
    ]);
    await d.seed(S, 'chrono', [{ _id: 'c1', title: 'An entry', type: 'Meeting', startsAt: '2026-03-04T05:00:00.000Z', endsAt: '2026-03-04T06:00:00.000Z', status: 'upcoming', createdAt: STAMP, updatedAt: STAMP }]);
    tok = await d.mint('ld-refuse', { [S]: d.row({ knowledge: 'read' }) });
    slots = needModule(await loadDistModule('../../server/dist/util/slots.js', import.meta.url), ['takeSlot'], 'the slots');
    const log = needModule(await loadDistModule('../../server/dist/util/log.js', import.meta.url), ['subscribeLogLines'], 'the log');
    logs = [];
    stopLogs = log.subscribeLogLines(line => logs.push(line));
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
  });
  after(async () => {
    stopLogs?.();
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await setLimits(undefined);
    await d?.close();
  });

  it('a record whose own statements pass sparql.maxResults is 413 sparql_too_many_results, logged by its code, and the slot is free', async () => {
    await setLimits({ maxResults: 1 });
    const mark = logs.length;
    try {
      const r = await get(`/ld/${S}/entity/two`);
      assert.equal(r.status, 413, fmt(r));
      assert.equal(r.body?.code, 'sparql_too_many_results');
      assert.match(r.headers['content-type'] ?? '', /application\/problem\+json/);
      const lines = logged(mark).filter(l => l.includes('sparql_too_many_results'));
      assert.equal(lines.length, 1, `the refusal is not one log line: ${JSON.stringify(logged(mark))}`);
      assert.match(lines[0], /413/);
      assert.ok(!logged(mark).some(l => l.includes('entity/two') || l.includes(PUBLIC)), 'a log line names the address asked for');
      assert.ok(slotIsFree(), 'the slot is still held after the refusal');
    } finally { await setLimits(undefined); }
  });

  it('an agent whose walk passes sparql.maxRecordsRead is 413 sparql_too_much_read, logged, and the slot is free', async () => {
    await setLimits({ maxRecordsRead: 1_000 });
    const mark = logs.length;
    try {
      const r = await get(`/ld/${S}/agent/rdf-test-instance`);
      assert.equal(r.status, 413, fmt(r));
      assert.equal(r.body?.code, 'sparql_too_much_read');
      assert.ok(logged(mark).some(l => l.includes('sparql_too_much_read')), `no log line: ${JSON.stringify(logged(mark))}`);
      assert.ok(slotIsFree(), 'the slot is still held after the refusal');
    } finally { await setLimits(undefined); }
  });

  it('a read past its deadline is 503 sparql_timeout with Retry-After, logged, and the slot is free', async () => {
    const realNow = Date.now;
    // The clock jumps when the first find starts (the entry's own node): the find for its #start node is then past the deadline.
    const proto = Object.getPrototypeOf(d.col('probe'));
    const realFind = proto.find;
    let jumped = false;
    proto.find = function observed(filter, ...rest) {
      if (!jumped) { jumped = true; Date.now = () => realNow() + 86_400_000; }
      return realFind.call(this, filter, ...rest);
    };
    const mark = logs.length;
    let r;
    try { r = await get(`/ld/${S}/chrono/c1`); }
    finally { proto.find = realFind; Date.now = realNow; }
    assert.ok(jumped, 'no find was made: re-anchor this test');
    assert.equal(r.status, 503, fmt(r));
    assert.equal(r.body?.code, 'sparql_timeout');
    assert.match(r.headers['retry-after'] ?? '', /^\d+$/, 'Retry-After');
    assert.ok(logged(mark).some(l => l.includes('sparql_timeout')), `no log line: ${JSON.stringify(logged(mark))}`);
    assert.ok(slotIsFree(), 'the slot is still held after the refusal');
  });

  it('a caller who finds both query slots held is 503 sparql_busy with Retry-After, logged, and answered once they are free', async () => {
    const held = [slots.takeSlot('sparql', 'someone-else'), slots.takeSlot('sparql', 'someone-more')];
    assert.ok(held.every(Boolean), 'the test could not take the instance\'s two slots');
    const mark = logs.length;
    try {
      const r = await get(`/ld/${S}/entity/two`);
      assert.equal(r.status, 503, fmt(r));
      assert.equal(r.body?.code, 'sparql_busy');
      assert.match(r.headers['retry-after'] ?? '', /^\d+$/, 'Retry-After');
      assert.ok(logged(mark).some(l => l.includes('sparql_busy')), `no log line: ${JSON.stringify(logged(mark))}`);
    } finally { for (const s of held) s?.release(); }
    const after_ = await get(`/ld/${S}/entity/two`);
    assert.equal(after_.status, 200, `after the slots are free: ${fmt(after_)}`);
    assert.ok(slotIsFree(), 'the slot is still held after the answer');
  });

  it('an Accept naming no RDF format is 406 rdf_format_not_acceptable and holds no slot', async () => {
    const r = await get(`/ld/${S}/entity/two`, { Accept: 'application/pdf' });
    assert.equal(r.status, 406, fmt(r));
    assert.equal(r.body?.code, 'rdf_format_not_acceptable');
    assert.ok(slotIsFree());
  });
});
