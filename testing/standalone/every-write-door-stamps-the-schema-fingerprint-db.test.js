/**
 * Every door that writes a record's content stamps it with the fingerprint of the schema it was validated against, when the
 * record as written conforms (Q-736, bundle-265 design revision 4 section 2; owner D-77).
 *
 * ## What is held
 *
 * For one strict space whose every record conforms, the stored row carries `schemaFingerprint` equal to the fingerprint the server
 * computes for the space now (`readMetaForWrite(space).stamp.fp`), after each door: a create over REST and over MCP (the four kinds),
 * a converge (`save_*` naming an existing id), an update over REST and over MCP (the four kinds), an edge relabel (the re-keyed row),
 * a merge (the survivor), Review's keep (`writeKeptBody`, the parent), and `save_bulk`. Each seed row is made unstamped first, so a
 * stamp seen afterwards is the door's. The REST answers carry the stamp too (the op rides the update operators, which the answer is
 * built from). Rows are found by the id the door answered or by the content the case wrote, never by a count.
 *
 * And the partial index the gap scan reads (P2): `{schemaFingerprint: 1}` on each of the four collections, partial on
 * `{schemaFingerprint: {$exists: true}}`, policy `report`, not boot-safe, built by the sweep (`ensureTtlIndexes`).
 *
 * ## Red on the unchanged code (ce37b83a)
 *
 * `spaces/schema-stamp.ts` does not exist and no writer stamps, so every case fails on its first assertion; no index on
 * `schemaFingerprint` is declared or built.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/every-write-door-stamps-the-schema-fingerprint-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaStampDoor, STAMPED_PARTS } from './_schema-stamp-door.mjs';

const skip = await mongoSkipReason();
const SPACE = 'stampdoors';
const B = `/api/brain/spaces/${SPACE}`;
const T0 = '2026-10-01T00:00:00.000Z';

let door;
const uniq = (s) => `${s} ${randomUUID().slice(0, 8)}`;

/** A REST call that must succeed; its body. */
async function ok(method, url, body, what) {
  const r = await door.rest(method, url, body);
  assert.ok(r.status >= 200 && r.status < 300, `${what} answered ${r.status}: ${r.text}`);
  return r.body;
}
/** An MCP call that must succeed. */
async function mcpOk(tool, args) {
  const r = await door.mcp(tool, { space: SPACE, ...args });
  assert.ok(!r.isError && r.status < 300, `${tool} answered ${r.status}: ${r.text}`);
  return r;
}

/** The one stored row of `part` matching `filter`; fails on none or several. */
async function onlyRow(part, filter) {
  const rows = await door.coll(SPACE, part).find(filter).toArray();
  assert.equal(rows.length, 1, `expected one ${part} row for ${JSON.stringify(filter)}, found ${rows.length}`);
  return rows[0];
}

const assertStamped = (row, what) => door.assertStamped(SPACE, row, what);

/** Two conforming people, unstamped. */
async function people() {
  const a = await ok('POST', `${B}/entities`, { name: uniq('Ann'), type: 'person', properties: { age: 30 } }, 'an entity create');
  const b = await ok('POST', `${B}/entities`, { name: uniq('Bo'), type: 'person' }, 'an entity create');
  await door.unstamp(SPACE, 'entities', a._id);
  await door.unstamp(SPACE, 'entities', b._id);
  return [a._id, b._id];
}

/** One conforming, unstamped record of each kind, made through the REST door; their ids. */
async function seeds() {
  const [from, to] = await people();
  const fact = await ok('POST', `${B}/facts`, { fact: uniq('a seeded fact'), type: 'claim', properties: { confidence: 1 } }, 'a fact create');
  const chrono = await ok('POST', `${B}/chrono`, { title: uniq('a seeded event'), type: 'event', startsAt: T0, properties: { priority: 'low' } }, 'a chrono create');
  const edge = await ok('POST', `${B}/edges`, { from, to, label: 'knows', properties: { since: 2020 } }, 'an edge create');
  await door.unstamp(SPACE, 'facts', fact._id);
  await door.unstamp(SPACE, 'chrono', chrono._id);
  await door.unstamp(SPACE, 'edges', edge._id);
  return { entities: from, facts: fact._id, chrono: chrono._id, edges: edge._id, from, to };
}

describe('every door that writes a conforming record stamps the current fingerprint (Q-736)', { skip }, () => {
  before(async () => { door = await openSchemaStampDoor({ name: 'b265stampdoors', spaces: [SPACE] }); });
  after(async () => { await door?.close(); });

  it('a REST create of each kind is stored stamped, and its answer carries the stamp', async () => {
    const [from, to] = await people();
    const made = {
      entities: await ok('POST', `${B}/entities`, { name: uniq('Cy'), type: 'person', properties: { age: 4 } }, 'entity create'),
      facts: await ok('POST', `${B}/facts`, { fact: uniq('a created fact'), type: 'claim' }, 'fact create'),
      chrono: await ok('POST', `${B}/chrono`, { title: uniq('a created event'), type: 'event', startsAt: T0 }, 'chrono create'),
      edges: await ok('POST', `${B}/edges`, { from, to, label: 'likes' }, 'edge create'),
    };
    for (const [part, answer] of Object.entries(made)) {
      await assertStamped(await door.stored(SPACE, part, answer._id), `REST create of ${part}`);
      assert.equal(answer.schemaFingerprint, await door.fp(SPACE), `REST create of ${part}: the answer does not carry the stamp it stored`);
    }
  });

  it('an MCP create of each kind is stored stamped', async () => {
    const [from, to] = await people();
    const name = uniq('Di'); const fact = uniq('an mcp fact'); const title = uniq('an mcp event');
    await mcpOk('save_entity', { name, type: 'person', properties: { age: 5 } });
    await mcpOk('save_fact', { fact, type: 'claim' });
    await mcpOk('save_chrono', { title, type: 'event', startsAt: T0 });
    await mcpOk('save_edge', { from, to, label: 'likes' });
    await assertStamped(await onlyRow('entities', { name }), 'save_entity');
    await assertStamped(await onlyRow('facts', { fact }), 'save_fact');
    await assertStamped(await onlyRow('chrono', { title }), 'save_chrono');
    await assertStamped(await onlyRow('edges', { from, to, label: 'likes' }), 'save_edge');
  });

  it('a converge (save_* naming a stored id) stamps the row it converges onto', async () => {
    const s = await seeds();
    await mcpOk('save_fact', { id: s.facts, fact: uniq('the fact, converged'), type: 'claim' });
    await mcpOk('save_entity', { id: s.entities, name: uniq('Ann, converged'), type: 'person' });
    await mcpOk('save_chrono', { id: s.chrono, title: uniq('the event, converged'), type: 'event', startsAt: T0 });
    for (const part of ['facts', 'entities', 'chrono']) await assertStamped(await door.stored(SPACE, part, s[part]), `converge of ${part}`);
  });

  it('a REST update of each kind stamps the row, and its answer carries the stamp', async () => {
    const s = await seeds();
    for (const part of STAMPED_PARTS) {
      const answer = await ok('PATCH', `${B}/${part}/${s[part]}`, { description: `updated over REST: ${part}` }, `REST update of ${part}`);
      await assertStamped(await door.stored(SPACE, part, s[part]), `REST update of ${part}`);
      assert.equal(answer.schemaFingerprint, await door.fp(SPACE), `REST update of ${part}: the answer does not carry the stamp`);
    }
  });

  it('an MCP update of each kind stamps the row', async () => {
    const s = await seeds();
    const tool = { entities: 'update_entity', facts: 'update_fact', chrono: 'update_chrono', edges: 'update_edge' };
    for (const part of STAMPED_PARTS) {
      await mcpOk(tool[part], { id: s[part], description: `updated over MCP: ${part}` });
      await assertStamped(await door.stored(SPACE, part, s[part]), `${tool[part]}`);
    }
  });

  it('an edge relabel stamps the row it re-keys the edge onto (validated against the new label)', async () => {
    const s = await seeds();
    await mcpOk('update_edge', { id: s.edges, label: 'likes' });
    await assertStamped(await onlyRow('edges', { from: s.from, to: s.to, label: 'likes' }), 'relabelled edge');
  });

  it('a merge stamps the survivor', async () => {
    const [survivorId, absorbedId] = await people();
    const r = await mcpOk('graph_merge', { survivorId, absorbedId });
    assert.equal(await door.stored(SPACE, 'entities', absorbedId), null, `the merge did not absorb: ${r.text}`);
    await assertStamped(await door.stored(SPACE, 'entities', survivorId), 'merge survivor');
  });

  it('Review\'s keep stamps the parent it writes', async () => {
    const s = await seeds();
    const { writeKeptBody } = await import('../../server/dist/brain/fork-keep.js');
    const parent = await door.stored(SPACE, 'facts', s.facts);
    const out = await writeKeptBody(SPACE, 'facts', parent, { ...parent, fact: uniq('the kept version') },
      { aboveVersion: parent.seq, ifMatchSeq: parent.seq, blank: [] });
    assert.ok(out, 'the keep wrote nothing: the parent moved under the fixture');
    await assertStamped(await door.stored(SPACE, 'facts', s.facts), 'kept parent');
  });

  it('save_bulk stamps every record it writes', async () => {
    const name = uniq('Bulk person'); const fact = uniq('a bulk fact'); const title = uniq('a bulk event');
    await mcpOk('save_bulk', {
      entities: [{ name, type: 'person', properties: { age: 9 } }],
      facts: [{ fact, type: 'claim' }],
      chrono: [{ title, type: 'event', startsAt: T0 }],
    });
    await assertStamped(await onlyRow('entities', { name }), 'save_bulk entity');
    await assertStamped(await onlyRow('facts', { fact }), 'save_bulk fact');
    await assertStamped(await onlyRow('chrono', { title }), 'save_bulk chrono');
  });

  it('the partial index on schemaFingerprint is declared on the four collections and built by the sweep (P2)', async () => {
    const { SPACE_INDEXES, ensureTtlIndexes, spaceIndexName } = await import('../../server/dist/spaces/space-indexes.js');
    // The stamp index leads with the stamp and pairs it with the collection's type field (bundle-267: `type`, or `label` on edges).
    const declared = SPACE_INDEXES.filter(ix => Object.keys(ix.keys)[0] === 'schemaFingerprint');
    assert.deepEqual(declared.map(ix => ix.part).sort(), [...STAMPED_PARTS].sort(), 'the stamp index is not declared on exactly the four record collections');
    for (const ix of declared) {
      assert.deepEqual(Object.keys(ix.keys), ['schemaFingerprint', ix.part === 'edges' ? 'label' : 'type'], `${ix.part}: the stamp index is not (stamp, type field)`);
      assert.deepEqual(ix.options.partialFilterExpression, { schemaFingerprint: { $exists: true } }, `${ix.part}: not partial on the stamp's presence`);
      assert.equal(ix.policy, 'report', `${ix.part}: a failed build must be reported, never block`);
      assert.notEqual(ix.bootSafe, true, `${ix.part}: built at boot, where a big collection would hold the boot`);
      assert.equal(ix.sweep, true, `${ix.part}: not built by the sweep`);
    }
    const { failed } = await ensureTtlIndexes(SPACE);
    assert.deepEqual(failed, [], 'the sweep failed to build an index');
    for (const ix of declared) {
      const built = (await door.coll(SPACE, ix.part).listIndexes().toArray()).find(i => i.name === spaceIndexName(ix));
      assert.ok(built, `${ix.part}: the sweep built no ${spaceIndexName(ix)}`);
      assert.deepEqual(built.partialFilterExpression, { schemaFingerprint: { $exists: true } }, `${ix.part}: the built index is not partial`);
    }
  });
});
