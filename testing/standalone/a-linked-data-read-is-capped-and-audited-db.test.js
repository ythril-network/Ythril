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
 * (rule 1: more statements than the cap, no header); the address written into `changes` (rule 2). On d78b20280 (lens-1 P1, lens-2) a read of
 * the base root `/ld/<space>/` was audited nowhere: the rule demanded a segment after the space.
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
/** A renamed space: its base still names its old id, so the URL segment is no space of this instance. */
const RENAMED = 'ldcapnew';
const OLD = 'ldcapold';
/** A hub with a loop on itself, and what points at it: the cap is held to the statements the answer carries. */
const SELF = 'ldcapself';
const SELF_HUB = `${PUBLIC}/ld/${SELF}/entity/hub`;
const SELF_POINTING = 5;
const TRUNCATED = 'x-ythril-truncated';

let d, key;
const previousPublic = process.env['PUBLIC_BASE_URL'];
const fmt = (r) => `${r.status} ${r.text.slice(0, 200)}`;

describe('a linked data read is capped and audited', { skip }, () => {
  before(async () => {
    const edges = { typeSchemas: { edge: { knows: {} } } };
    d = await openRdfExportDoors({
      suite: 'ld_cap',
      spaces: [
        { id: S, meta: rdfMeta(S, edges) },
        { id: RENAMED, meta: { ...rdfMeta(RENAMED), rdf: { enabled: true, base: `${PUBLIC}/ld/${OLD}/`, vocab: `${PUBLIC}/ld/${OLD}/vocab/`, baseEpoch: 0 } } },
        { id: SELF, meta: rdfMeta(SELF, edges) },
      ],
    });
    await d.seed(RENAMED, 'entity', [{ _id: 'r1', name: 'Renamed' }]);
    const selfIds = Array.from({ length: SELF_POINTING }, (_, i) => `s${i}`);
    await d.seed(SELF, 'entity', [{ _id: 'hub', name: 'Self hub' }, ...selfIds.map(id => ({ _id: id, name: id }))]);
    await d.seed(SELF, 'edge', [{ _id: 'edge-loop', from: 'hub', to: 'hub', label: 'knows' }, ...selfIds.map(id => ({ _id: `edge-${id}`, from: id, to: 'hub', label: 'knows' }))]);
    const ids = Array.from({ length: POINTING }, (_, i) => `n${String(i).padStart(2, '0')}`);
    await d.seed(S, 'entity', [{ _id: 'hub', name: 'Hub' }, ...ids.map(id => ({ _id: id, name: `Node ${id}` }))]);
    await d.seed(S, 'edge', ids.map(id => ({ _id: `edge-${id}`, from: id, to: 'hub', label: 'knows' })));
    key = (await d.mint('ld-cap', { [S]: d.row({ knowledge: 'read' }), [RENAMED]: d.row({ knowledge: 'read' }), [SELF]: d.row({ knowledge: 'read' }) })).key;
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

  it('the row names the space whose base holds the address, not the URL segment', async () => {
    await d.loader.mutateConfig(cfg => { cfg.audit = { ...(cfg.audit ?? {}), logReads: true }; });
    const before_ = (await auditRowsOf(d.door.mongo, { operation: 'ld.read' })).length;
    const r = await d.restGet(key, `/ld/${OLD}/entity/r1`, { Accept: 'text/turtle' });
    assert.equal(r.status, 200, fmt(r));
    const rows = (await auditRowsOf(d.door.mongo, { operation: 'ld.read' })).slice(before_);
    assert.equal(rows.length, 1, `rows of ld.read: ${rows.map(x => `${x.method} ${x.status}`).join(', ')}`);
    assert.equal(rows[0].spaceId, RENAMED, `the row names the segment ('${OLD}') or no space, not the space that holds the base`);
    assert.equal(rows[0].entryId, 'r1');
  });

  it('a read of the base root (the graph itself, no record) is one ld.read row naming the space (lens-1 P1)', async () => {
    await d.loader.mutateConfig(cfg => { cfg.audit = { ...(cfg.audit ?? {}), logReads: true }; });
    const before_ = (await auditRowsOf(d.door.mongo, { operation: 'ld.read' })).length;
    const r = await d.restGet(key, `/ld/${S}/`, { Accept: 'text/turtle' });
    assert.equal(r.status, 200, fmt(r));
    const rows = (await auditRowsOf(d.door.mongo, { operation: 'ld.read' })).slice(before_);
    assert.equal(rows.length, 1, `the base root read is not audited as ld.read: rows ${rows.map(x => `${x.method} ${x.status}`).join(', ')}`);
    assert.equal(rows[0].spaceId, S);
    assert.ok((rows[0].changes ?? []).some(c => c.field === 'kind' && c.to === 'graph'), `the row names the kind graph: ${JSON.stringify(rows[0].changes)}`);
  });

  it('a self-reference is no inbound statement: an answer that fits the cap is whole and says nothing was cut', async () => {
    await d.loader.mutateConfig(cfg => { delete cfg.sparql; });
    const whole = await d.restGet(key, `/ld/${SELF}/entity/hub`, { Accept: 'application/n-quads' });
    assert.equal(whole.status, 200, fmt(whole));
    const quads = await parseRdf('nquads', whole.text);
    const pointing = quads.filter(q => q.object.value === SELF_HUB && q.subject.value !== SELF_HUB);
    assert.ok(quads.some(q => q.subject.value === SELF_HUB && q.object.value === SELF_HUB), `the hub has a statement about itself: ${whole.text.slice(0, 1500)}`);
    assert.ok(pointing.length >= SELF_POINTING, `every record pointing at the hub is in the whole answer (${pointing.length})`);
    try {
      // The cap is exactly the statements the answer holds: nothing is cut, though the self-reference is read from both halves.
      await d.loader.mutateConfig(cfg => { cfg.sparql = { maxResults: quads.length }; });
      const fits = await d.restGet(key, `/ld/${SELF}/entity/hub`, { Accept: 'application/n-quads' });
      assert.equal(fits.status, 200, fmt(fits));
      assert.equal(fits.headers[TRUNCATED], undefined, 'an answer that fits the cap says its inbound half was cut: the self-reference was counted');
      assert.equal((await parseRdf('nquads', fits.text)).length, quads.length);
      // One statement under it, a pointing statement is cut, and the answer says so.
      await d.loader.mutateConfig(cfg => { cfg.sparql = { maxResults: quads.length - 1 }; });
      const cut = await d.restGet(key, `/ld/${SELF}/entity/hub`, { Accept: 'application/n-quads' });
      assert.equal(cut.status, 200, fmt(cut));
      assert.equal(cut.headers[TRUNCATED], 'inbound');
      assert.equal((await parseRdf('nquads', cut.text)).length, quads.length - 1);
    } finally { await d.loader.mutateConfig(cfg => { delete cfg.sparql; }); }
  });

  it('a read that runs out of time in the pointing half answers the record\'s own half and says the inbound half was cut', async () => {
    await d.loader.mutateConfig(cfg => { delete cfg.sparql; });
    const realNow = Date.now;
    // The harness runs the server in this process: the clock jumps when the first find of the pointing half starts (the one that names the
    // hub as an object), so the own half is read in time and every later find of the read is past its deadline.
    const proto = Object.getPrototypeOf(d.col('probe'));
    const realFind = proto.find;
    let jumped = false;
    proto.find = function observed(filter, ...rest) {
      if (!jumped && JSON.stringify(filter ?? {}).includes('"to":"hub"')) { jumped = true; Date.now = () => realNow() + 86_400_000; }
      return realFind.call(this, filter, ...rest);
    };
    let r;
    try { r = await d.restGet(key, `/ld/${S}/entity/hub`, { Accept: 'application/n-quads' }); }
    finally { proto.find = realFind; Date.now = realNow; }
    assert.ok(jumped, 'the pointing half never reached a find that names the hub as an object: re-anchor this test');
    assert.equal(r.status, 200, `a timeout in the pointing half refused the record's own half: ${fmt(r)}`);
    assert.equal(r.headers[TRUNCATED], 'inbound', 'the cut answer names the half that was cut');
    const quads = await parseRdf('nquads', r.text);
    assert.ok(quads.length > 0 && quads.every(q => q.subject.value === HUB), 'the own half, and no pointing statement');
  });
});
