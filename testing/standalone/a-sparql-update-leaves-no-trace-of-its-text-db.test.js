/**
 * A SPARQL Update is recorded by what it landed, never by its text, and announces itself once (bundle-272, Q-761; design g, r2 R11,
 * vet-1 S7, vet-3 S2, S4, S8; owner D-91). The twin of `a-sparql-query-leaves-no-trace-of-its-text-db`.
 *
 * ## The rules
 *
 * 1. **Audit by counts.** Every Update is one row of operation `brain.sparql_update` on REST and MCP: its form, length, the records it
 *    inserted, converged and deleted, `recordsChanged`, the attempts and the outcome. A refused one is a row too, with 0 changed and its code
 *    as the outcome.
 * 2. **No text anywhere.** No substring of the Update is in an audit row, a log line or the body of a refusal, on any door: a parse error
 *    names its line and column, a statement it refuses is named by its subject and predicate and its value by kind and length.
 * 3. **One summary.** An Update that landed emits ONE `bulk.write` with `source: 'sparql.update'` and its counts, the additive `deleted`
 *    among them (D-91), and each record it deleted its own `<kind>.deleted`.
 *
 * ## Seen red
 *
 * On 4fc52d8a9 (the base) no route answers `.../sparql/update` and no tool `sparql_update` exists: no row, no summary.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-sparql-update-leaves-no-trace-of-its-text-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';

const skip = await mongoSkipReason();
const S = 'spu-trace';
const OP = 'brain.sparql_update';
/** A marker no answer, code or sentence of the server holds: found anywhere, it came from the Update's text. */
const MARK = 'zq7updmark';
const STAMP = '2026-03-04T05:06:07.000Z';
const at = (kind, id) => `${baseOf(S)}${kind}/${id}`;
const NICK = `${baseOf(S)}vocab/entity/person#nick`;
const ALIAS = `${baseOf(S)}vocab/entity/person#alias`;
const RENAME = `DELETE { ?s <${NICK}> ?v } INSERT { ?s <${ALIAS}> ?v } WHERE { ?s <${NICK}> ?v FILTER(?v != "${MARK}") }`;
const BROKEN = `INSERT DATA { <${at('entity', 'e1')}> <${NICK}> "${MARK}" .. }`;
const FOREIGN = `INSERT DATA { <http://elsewhere.example/x> <http://www.w3.org/2000/01/rdf-schema#label> "${MARK}" }`;

let d, tok, dispatcher, store, hook;
const fmt = (a) => `${a.door} ${a.status} ${a.code} ${(a.text ?? '').slice(0, 300)}`;
const fields = (row) => Object.fromEntries((row.changes ?? []).map(c => [c.field, c.to]));

describe('a SPARQL Update leaves no trace of its text', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'q761-trace', spaces: [{ id: S }] });
    const e = (id, nick) => ({ _id: id, spaceId: S, name: `N ${id}`, type: 'person', properties: { nick }, seq: 1, createdAt: STAMP, updatedAt: STAMP });
    await d.seed(S, 'entity', [e('e1', 'a'), e('e2', 'b'), e('e3', 'c'), e('gone', 'g')]);
    // Converted AND marked (`completeLinkage`), as every space is after its first boot: a delete reads the links naming its record.
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    tok = await d.mint('spu-trace', { [S]: d.row({ knowledge: 'write' }) });
    dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
    store = await import('../../server/dist/webhooks/store.js');
    hook = (await store.createWebhook({ url: 'http://127.0.0.1:9/spu', secret: 'spu-trace-secret' })).id;
  });
  after(async () => {
    dispatcher?.setFirstDeliveryDepsForTest?.(null);
    if (hook) await store?.deleteWebhook(hook).catch(() => {});
    await d?.close();
  });

  it('every Update is a brain.sparql_update row of counts on REST and MCP, 0 changed when refused, and its text is nowhere', async () => {
    const before_ = (await auditRowsOf(d.door.mongo, { operation: OP })).length;
    const { lines, result } = await logLinesDuring(async () => ({
      good: await d.sparqlUpdate('rest', tok.key, S, RENAME),
      again: await d.sparqlUpdate('mcp', tok.key, S, RENAME.replaceAll(NICK, ALIAS).replace(`INSERT { ?s <${ALIAS}>`, `INSERT { ?s <${NICK}>`)),
      badRest: await d.sparqlUpdate('rest', tok.key, S, BROKEN),
      badMcp: await d.sparqlUpdate('mcp', tok.key, S, BROKEN),
      foreignRest: await d.sparqlUpdate('rest', tok.key, S, FOREIGN),
      foreignTool: await d.sparqlUpdate('tool', tok.key, S, FOREIGN),
    }));
    assert.equal(result.good.status, 200, fmt(result.good));
    assert.equal(result.again.status, 200, fmt(result.again));
    assert.equal(result.badRest.status, 400, fmt(result.badRest));
    assert.equal(result.badRest.code, 'sparql_malformed', fmt(result.badRest));
    assert.equal(result.foreignRest.status, 422, fmt(result.foreignRest));
    for (const a of Object.values(result)) assert.ok(!a.text.includes(MARK), `the answer repeats the Update's text: ${fmt(a)}`);
    assert.deepEqual(lines.filter(l => l.includes(MARK)), [], 'a log line repeats the Update');

    const rows = (await auditRowsOf(d.door.mongo, { operation: OP })).slice(before_);
    // The tools door (`POST /api/sparql_update`) is recorded as its HTTP method, MCP as `MCP`.
    assert.deepEqual(rows.map(r => r.method).sort(), ['MCP', 'MCP', 'POST', 'POST', 'POST', 'POST'], `rows of ${OP}: ${rows.map(r => `${r.method} ${r.status}`).join(', ')}`);
    assert.deepEqual(rows.filter(r => JSON.stringify(r).includes(MARK)).map(r => r.method), [], 'an audit row holds the Update\'s text');
    const landed = rows.filter(r => fields(r).outcome === 'landed');
    assert.equal(landed.length, 2, `rows that landed: ${rows.map(r => JSON.stringify(fields(r))).join(' | ')}`);
    for (const r of landed) {
      const f = fields(r);
      assert.equal(f.converged, 4, `${r.method}: converged`);
      assert.equal(f.recordsChanged, 4, `${r.method}: recordsChanged`);
      assert.equal(f.inserted, 0, `${r.method}: inserted`);
      assert.equal(f.deleted, 0, `${r.method}: deleted`);
      assert.equal(f.attempts, 1, `${r.method}: attempts`);
      assert.equal(typeof f.length, 'number', `${r.method}: length`);
      assert.equal(r.spaceId, S, `${r.method}: spaceId`);
    }
    for (const r of rows.filter(x => fields(x).outcome !== 'landed')) {
      assert.equal(fields(r).recordsChanged, 0, `a refused Update is recorded as changing ${fields(r).recordsChanged} records`);
      assert.match(String(fields(r).outcome), /^sparql_/, `a refused Update's outcome is not its code: ${JSON.stringify(fields(r))}`);
    }
  });

  it('an Update that landed emits one bulk.write from sparql.update with its deleted count, and each deleted record its own event', async () => {
    const seen = [];
    dispatcher.setFirstDeliveryDepsForTest({
      async deliver(sub, body, event, spaceId, deliveryId) {
        seen.push({ event, entry: JSON.parse(body)?.entry, spaceId });
        return { id: deliveryId, webhookId: sub.id, event, spaceId, timestamp: new Date().toISOString(), responseStatus: 204, latencyMs: 1, success: true };
      },
    });
    const a = await d.sparqlUpdate('rest', tok.key, S,
      `DELETE WHERE { <${at('entity', 'gone')}> ?p ?o } ; INSERT DATA { <${at('entity', 'e1')}> <${ALIAS}> "z" }`);
    assert.equal(a.status, 200, fmt(a));
    await dispatcher.drainFirstDeliveries({ withinMs: 10_000 });
    const bulk = seen.filter(s => s.event === 'bulk.write');
    assert.equal(bulk.length, 1, `bulk.write emitted ${bulk.length} times`);
    assert.equal(bulk[0].entry?.source, 'sparql.update');
    assert.equal(bulk[0].entry?.deleted?.entity, 1, JSON.stringify(bulk[0].entry));
    assert.equal(bulk[0].entry?.updated?.entity, 1, JSON.stringify(bulk[0].entry));
    assert.deepEqual(seen.filter(s => s.event === 'entity.deleted').map(s => s.entry?._id ?? s.entry?.id), ['gone']);
  });
});
