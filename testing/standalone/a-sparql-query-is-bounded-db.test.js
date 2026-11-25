/**
 * A SPARQL answer is whole or refused, a query runs in a slot, and a query whose client went away stops (bundle-271, Q-757; design r2
 * R3.1, R3.6, R4.4, R4.6).
 *
 * ## The rules
 *
 * 1. **Whole or refused.** An answer is collected in full, up to `maxResults + 1` rows, before its status line: a query answering more rows
 *    than `sparql.maxResults` (or a lower `limit`) is `413 sparql_too_many_results` with no row of it, never a `200` that is cut short. A
 *    `limit` above `maxResults` is `400 sparql_bad_limit`.
 * 2. **Slots.** A query runs in a slot of family `sparql`: a caller whose slot is held is `503 sparql_busy` with `Retry-After`, on REST and
 *    MCP, and answered once the slot is free.
 * 3. **A client that goes away.** When the connection closes mid-query the engine is destroyed (the store is asked nothing more for it) and
 *    the slot is free again.
 *
 * ## Seen red
 *
 * On db66e206d no route answers `/api/brain/spaces/:spaceId/sparql` (404) and no tool `sparql_query` exists. Mutations: answering the rows
 * collected at the cap (`rows(maxResults)` and a 200): rule 1's 200; not destroying the result on `res` close: rule 3's reads after the close.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then node --test testing/standalone/a-sparql-query-is-bounded-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { elapse } from '../_shared/sleep.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'spq-bounds';
const BIG = 'spq-bounds-big';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const LABELS = `SELECT ?s ?n WHERE { ?s <${RDFS_LABEL}> ?n }`;
/** Reads every record of the big space and keeps none: a query that runs for seconds. */
const SLOW = 'SELECT ?s WHERE { ?s ?p ?o . FILTER(STRLEN(STR(?o)) < 0) }';
const BIG_RECORDS = 60_000;
const STAMP = '2026-03-04T05:06:07.000Z';

let d, tok, slots;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 300)}`;
const setLimits = (sparql) => d.loader.mutateConfig(cfg => { cfg.sparql = sparql; });
/** The store commands that read the big space's records. */
const readsOfBig = (commands) => commands.filter(c => /^(find|getMore) /.test(c) && c.includes(BIG));

describe('a SPARQL query is bounded', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q757-bounds', spaces: [{ id: S }, { id: BIG }], monitorCommands: true });
    await d.seed(S, 'entity', Array.from({ length: 6 }, (_, i) => ({ _id: `e-${i}`, name: `N${i}`, type: 'Person', createdAt: STAMP, updatedAt: STAMP })));
    for (let at = 0; at < BIG_RECORDS; at += 10_000) {
      await d.seed(BIG, 'entity', Array.from({ length: 10_000 }, (_, i) => ({ _id: `b-${at + i}`, name: `Big ${at + i}`, type: 'Person', createdAt: STAMP, updatedAt: STAMP })));
    }
    tok = await d.mint('spq-bounds', { [S]: d.row({ knowledge: 'read' }), [BIG]: d.row({ knowledge: 'read' }) });
    slots = await loadDistModule('../../server/dist/util/slots.js', import.meta.url);
  });
  after(async () => { await d?.close(); });

  it('an answer over maxResults is 413 with no row of it, on REST and MCP; a lower limit bounds alike; a limit above it is 400', async () => {
    await setLimits({ maxResults: 5 });
    try {
      const a = await d.sparqlGet(tok.key, S, LABELS);
      assert.equal(a.status, 413, fmt(a));
      assert.equal(a.body?.code, 'sparql_too_many_results');
      assert.equal(a.body?.results, undefined, 'a refusal carries rows');
      const m = await d.sparqlMcp(tok.key, { space: S, query: LABELS });
      assert.ok(m.isError && m.text.includes('sparql_too_many_results'), `MCP: ${m.text.slice(0, 300)}`);
      const fits = await d.sparqlGet(tok.key, S, `${LABELS} LIMIT 5`);
      assert.equal(fits.status, 200, `exactly maxResults rows: ${fmt(fits)}`);
      assert.equal(fits.body.results.bindings.length, 5);
      const lowered = await d.sparqlGet(tok.key, S, `${LABELS} LIMIT 3`, { limit: 2 });
      assert.equal(lowered.status, 413, `limit=2 under 3 rows: ${fmt(lowered)}`);
      assert.equal(lowered.body?.code, 'sparql_too_many_results');
      const over = await d.sparqlGet(tok.key, S, LABELS, { limit: 6 });
      assert.equal(over.status, 400, `limit above maxResults: ${fmt(over)}`);
      assert.equal(over.body?.code, 'sparql_bad_limit');
    } finally { await setLimits(undefined); }
  });

  it('a caller whose slot is held is 503 sparql_busy with Retry-After, on REST and MCP, and answered once it is free', async () => {
    const { takeSlot } = needModule(slots, ['takeSlot'], 'the slots');
    const held = takeSlot('sparql', tok.id);
    assert.ok(held, 'the test could not take the caller\'s slot');
    try {
      const a = await d.sparqlGet(tok.key, S, LABELS);
      assert.equal(a.status, 503, fmt(a));
      assert.equal(a.body?.code, 'sparql_busy');
      assert.match(a.headers['retry-after'] ?? '', /^\d+$/, 'Retry-After');
      const m = await d.sparqlMcp(tok.key, { space: S, query: LABELS });
      assert.ok(m.isError && m.text.includes('sparql_busy'), `MCP: ${m.text.slice(0, 300)}`);
    } finally { held.release(); }
    const after_ = await d.sparqlGet(tok.key, S, LABELS);
    assert.equal(after_.status, 200, `after the slot is free: ${fmt(after_)}`);
  });

  it('a client that goes away mid-query stops the engine and frees the slot', async () => {
    const { takeSlot } = needModule(slots, ['takeSlot'], 'the slots');
    await setLimits({ maxRecordsRead: 10_000_000, timeoutMs: 300_000 });
    try {
      const ctl = new AbortController();
      const pending = d.sparqlPost(tok.key, BIG, SLOW, { signal: ctl.signal }).catch(err => ({ aborted: err }));
      // The query is running and reading: the positive control the absence window below is compared with.
      const during = await d.door.commandsDuring(() => elapse(1_500, 'absence window: the store is read while the query runs'));
      assert.ok(readsOfBig(during).length > 0, `the query read nothing while it ran: ${during.slice(0, 10).join(', ')}`);
      ctl.abort();
      const gone = await pending;
      assert.ok(gone.aborted, `the query answered before its client went away: ${fmt(gone)}`);
      await waitFor(() => { const s = takeSlot('sparql', tok.id); s?.release(); return s !== null; }, 10_000, 100, () => 'the slot is still held after the client went away');
      const after_ = await d.door.commandsDuring(() => elapse(1_500, 'absence window: no read of the stopped query may follow'));
      assert.deepEqual(readsOfBig(after_), [], 'the store was still read for a query whose client went away');
    } finally { await setLimits(undefined); }
  });
});
