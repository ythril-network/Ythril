/**
 * The export of a SPARQL view stops, and frees its slot, when its caller goes away (bundle-273, Q-762, review S5 finding K7).
 *
 * ## The rules
 *
 * 1. **REST.** A client that closes the connection of `GET .../@v/export/rdf` while the CONSTRUCT runs stops the engine: the store is asked
 *    nothing more for it and the caller's export slot is free again, not at `sparql.timeoutMs`.
 * 2. **MCP.** The same for `export_rdf` on `@v`: the connection that carried the call ending is the signal.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/an-export-of-a-sparql-view-stops-when-its-caller-goes-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';
import { openSparqlDoors } from './_sparql-doors.mjs';
import { recordProcessFaults } from './_quad-source-faults.mjs';
import { elapse } from '../_shared/sleep.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const faults = recordProcessFaults();
const BIG = 'q762k-big';
const BIG_RECORDS = 40_000;
const STAMP = '2026-03-04T05:06:07.000Z';
/** Reads every record of the big space and keeps none: a CONSTRUCT that runs for seconds. */
const SLOW = 'CONSTRUCT { ?s <urn:q762k:p> ?o } WHERE { ?s ?p ?o . FILTER(STRLEN(STR(?o)) < 0) }';

let d, tok, slots;
const readsOfBig = (commands) => commands.filter(c => /^(find|getMore) /.test(c) && c.includes(BIG));
const slotIsFree = () => { const s = slots.takeSlot('export', tok.id); s?.release(); return s !== null; };

describe('the export of a SPARQL view stops when its caller goes away', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q762k-abort', spaces: [{ id: BIG }], monitorCommands: true });
    for (let at = 0; at < BIG_RECORDS; at += 10_000) {
      await d.seed(BIG, 'entity', Array.from({ length: 10_000 }, (_, i) => ({ _id: `b-${at + i}`, name: `Big ${at + i}`, type: 'Thing', createdAt: STAMP, updatedAt: STAMP })));
    }
    slots = needModule(await loadDistModule('../../server/dist/util/slots.js', import.meta.url), ['takeSlot'], 'the slots');
  });
  after(async () => { faults.stop(); await d?.close(); });

  /**
   * A caller of its own (a case that leaves its slot held must not refuse the next case for want of one) with the slow view, then: start
   * `begin(signal)`, let it run and read, take the client away, and hold what the server did after against the run before.
   */
  async function goesAway(name, begin) {
    tok = await d.mint(name, { [BIG]: d.row({ knowledge: 'read' }) });
    const made = await d.rest(tok.key, 'POST', '/api/views', { name: 'q762k-slow', members: [BIG], sparql: { query: SLOW } });
    assert.equal(made.status, 201, `${made.status} ${made.text.slice(0, 300)}`);
    const ctl = new AbortController();
    const pending = begin(ctl.signal).catch(err => ({ aborted: err }));
    const during = await d.door.commandsDuring(() => elapse(1_500, 'absence window: the store is read while the CONSTRUCT runs'));
    assert.ok(readsOfBig(during).length > 0, `the CONSTRUCT read nothing while it ran: ${during.slice(0, 10).join(', ')}`);
    assert.equal(slotIsFree(), false, 'the export slot is held while it runs');
    ctl.abort();
    const gone = await pending;
    assert.ok(gone.aborted, 'the export answered before its client went away');
    await waitFor(slotIsFree, 10_000, 100, () => 'the export slot is still held after the client went away');
    const after_ = await d.door.commandsDuring(() => elapse(1_500, 'absence window: no read of the stopped export may follow'));
    assert.deepEqual(readsOfBig(after_), [], 'the store was still read for an export whose client went away');
  }

  it('a REST client that goes away stops the CONSTRUCT and frees the export slot', async () => {
    await goesAway('q762k-rest', signal => d.sparqlRest(tok.key, 'GET', '/api/brain/spaces/%40q762k-slow/export/rdf?format=nquads', { signal }));
  });

  it('an MCP caller that goes away stops the CONSTRUCT and frees the export slot', async () => {
    await goesAway('q762k-mcp', signal => fetch(`${d.server.url}/mcp`, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${tok.key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_rdf', arguments: { space: '@q762k-slow', format: 'nquads' } } }),
      // The answer's headers arrive at once on a streamed response: the call is over when its body is, and the abort ends the read of it.
    }).then(r => r.text()));
  });

  it('raised no unhandled rejection and no uncaught exception', async () => { await faults.quiet(); });
});
