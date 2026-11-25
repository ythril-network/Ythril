/**
 * A Linked Data read is bounded by `sparql.maxResults` and recorded as `ld.read` (bundle-271, Q-758; design §3, r2 R1.4, R4.6, R5).
 *
 * ## The rules
 *
 * 1. **The inbound half stops at the cap, and says so.** A record's answer is the statements about it, then the statements that point at
 *    it. A hub that many records point at answers at most `sparql.maxResults` statements: every statement about it, then the pointing ones
 *    up to the cap, with `X-Ythril-Truncated: inbound` naming the half that was cut. Under the cap the answer is whole and carries no such
 *    header.
 * 2. **Audited as a read.** With `audit.logReads` on, a read is one row of operation `ld.read`: the space whose base holds the address, the
 *    record's id as `entryId`, and in `changes` only the kind, the statement count and whether it was cut. No field names the address
 *    beyond what the request path and the id hold: the absolute address appears nowhere in the row.
 *
 * ## Seen red
 *
 * On c647bd24f the address answers the 404 placeholder and no `/ld/` request is audited. Mutations: the inbound half read on past the cap
 * (rule 1: more statements than the cap, no header); the address written into `changes` (rule 2).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-linked-data-read-is-capped-and-audited-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { openRdfExportDoors, rdfMeta, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const PUBLIC = 'https://rdf.example.org';
const S = 'ldcap';
const HUB = `${PUBLIC}/ld/${S}/entity/hub`;
const POINTING = 12;
const TRUNCATED = 'x-ythril-truncated';

let d, key;
const previousPublic = process.env['PUBLIC_BASE_URL'];
const fmt = (r) => `${r.status} ${r.text.slice(0, 200)}`;

describe('a linked data read is capped and audited', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({ suite: 'ld_cap', spaces: [{ id: S, meta: rdfMeta(S, { typeSchemas: { edge: { knows: {} } } }) }] });
    const ids = Array.from({ length: POINTING }, (_, i) => `n${String(i).padStart(2, '0')}`);
    await d.seed(S, 'entity', [{ _id: 'hub', name: 'Hub' }, ...ids.map(id => ({ _id: id, name: `Node ${id}` }))]);
    await d.seed(S, 'edge', ids.map(id => ({ _id: `edge-${id}`, from: id, to: 'hub', label: 'knows' })));
    key = (await d.mint('ld-cap', { [S]: d.row({ knowledge: 'read' }) })).key;
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
  });
  after(async () => {
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await d?.loader.mutateConfig(cfg => { delete cfg.sparql; });
    await d?.close();
  });

  it('a hub\'s pointing statements stop at sparql.maxResults, and the answer says the inbound half was cut', async () => {
    const whole = await d.restGet(key, `/ld/${S}/entity/hub`, { Accept: 'application/n-quads' });
    assert.equal(whole.status, 200, fmt(whole));
    assert.equal(whole.headers[TRUNCATED], undefined, 'an answer under the cap says it was cut');
    const quads = await parseRdf('nquads', whole.text);
    const about = quads.filter(q => q.subject.value === HUB);
    const pointing = quads.filter(q => q.object.value === HUB && q.subject.value !== HUB);
    assert.ok(about.length > 0, 'the hub has statements about it');
    assert.equal(pointing.length, POINTING, 'every record pointing at the hub is in the whole answer');

    const cap = about.length + 3;
    await d.loader.mutateConfig(cfg => { cfg.sparql = { maxResults: cap }; });
    const cut = await d.restGet(key, `/ld/${S}/entity/hub`, { Accept: 'application/n-quads' });
    assert.equal(cut.status, 200, fmt(cut));
    assert.equal(cut.headers[TRUNCATED], 'inbound', 'the cut answer names the half that was cut');
    const cutQuads = await parseRdf('nquads', cut.text);
    assert.equal(cutQuads.length, cap, `the cut answer holds sparql.maxResults statements (${cap})`);
    assert.equal(cutQuads.filter(q => q.subject.value === HUB).length, about.length, 'every statement about the hub is kept');
    await d.loader.mutateConfig(cfg => { delete cfg.sparql; });
  });

  it('a read is one ld.read row naming the space and the record, and no address', async () => {
    await d.loader.mutateConfig(cfg => { cfg.audit = { ...(cfg.audit ?? {}), logReads: true }; });
    const before_ = (await auditRowsOf(d.door.mongo, { operation: 'ld.read' })).length;
    const r = await d.restGet(key, `/ld/${S}/entity/hub`, { Accept: 'text/turtle' });
    assert.equal(r.status, 200, fmt(r));
    const rows = (await auditRowsOf(d.door.mongo, { operation: 'ld.read' })).slice(before_);
    assert.equal(rows.length, 1, `rows of ld.read: ${rows.map(x => `${x.method} ${x.status}`).join(', ')}`);
    const [row] = rows;
    assert.equal(row.status, 200);
    assert.equal(row.spaceId, S, 'the row names the space whose base holds the address');
    assert.equal(row.entryId, 'hub', 'the row names the record by its id');
    const fields = (row.changes ?? []).map(c => c.field).sort();
    assert.deepEqual(fields.filter(f => !['kind', 'statements', 'truncated'].includes(f)), [], `changes hold more than the counts: ${fields.join(', ')}`);
    assert.ok(fields.includes('statements'), `the row counts the statements answered: ${JSON.stringify(row.changes)}`);
    assert.ok(!JSON.stringify(row).includes(PUBLIC), `the row holds the absolute address: ${JSON.stringify(row).slice(0, 400)}`);
  });
});
