/**
 * A record carries `schemaFingerprint` exactly while it conforms AS STORED to that schema: a record written before this release gains
 * the current fingerprint on its next conforming update, and every write that leaves it non-conforming, or changes it without a
 * conforming validation, removes the stamp (Q-736; owner D-77; parent D-N1..D-N4; bundle-265 design revision 4 section 4.1).
 *
 * ## The cases (D-77 1-11)
 *
 *  1. An unstamped row of each kind, updated conformingly, carries the current fingerprint.
 *  2. An update that introduces a violation on a strict space is refused (422) and the row stays unstamped.
 *  3. A writer that validates nothing never ADDS a stamp: redaction and relink leave an unstamped row unstamped.
 *  4. The schema changes between two updates: each update's stamp is the fingerprint of the schema it was validated against (stored
 *     outcomes only, T4).
 *  5. Stamp only if conforming, UNSTAMP otherwise (R4-5): a row that no longer conforms (its stored enum value removed from the
 *     schema), updated on its description only, lands (P-6: a pre-existing violation does not refuse) and loses the older stamp it
 *     held; an unstamped twin stays unstamped.
 *  6. The mirror: an update that fixes the value stamps the current fingerprint, and the next description-only update stamps again.
 *  7. Creates: a `warn` create with a violation lands with its warning and no stamp; an `off` create with a violation gets none either
 *     (the rule reads `check.all`, not `warnings`); a conforming create is stamped.
 *  8. DI-4: an update without If-Match whose row moves between its validation and its write (a peer's copy lands in between, the
 *     write retries on the new version) lands UNSTAMPED — a previously stamped row loses its stamp; the same update unraced stamps.
 *  9. Redaction of a stamped chrono removes the stamp (it removes `description`, which a rule may read: D-N4).
 * 10. A relink of a stamped edge (a merge of its end) removes the stamp, re-keyed and written in place alike (D-N1).
 * 11. A KEEP writer (the retention-stamp heal) leaves a stamp as it was.
 *
 * ## Red on the unchanged code (ce37b83a)
 *
 * `spaces/schema-stamp.ts` does not exist and no write stamps or unstamps: (1), (4), (6), (7) and (8) fail on the missing stamp; (5),
 * (9) and (10) fail because the older stamp stays. (2), (3) and (11) pass today by absence or by not touching the field; they are the
 * controls that keep the implementation from stamping where it must not.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/an-unstamped-record-gains-the-schema-it-was-checked-against-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaStampDoor, STRICT_META, STAMPED_PARTS } from './_schema-stamp-door.mjs';
import { parkWrites } from './_write-faults.mjs';
import { build, peerToken } from './_push-door.mjs';

const skip = await mongoSkipReason();
const SPACE = 'd77';
const WARN = 'd77warn';
const OFF = 'd77off';
const B = `/api/brain/spaces/${SPACE}`;
const T0 = '2026-10-01T00:00:00.000Z';
const OLDER = 'b'.repeat(64);
const PEER = 'b265-d77-peer';
const PEER_AUTHOR = { instanceId: PEER, instanceLabel: 'Peer' };
const UPDATE_SHAPED = (m) => /^(findOneAndUpdate|updateOne|findOneAndReplace|replaceOne)$/.test(m);
const uniq = (s) => `${s} ${randomUUID().slice(0, 8)}`;

let door;

async function ok(method, url, body, what) {
  const r = await door.rest(method, url, body);
  assert.ok(r.status >= 200 && r.status < 300, `${what} answered ${r.status}: ${r.text}`);
  return r.body;
}
const stampOf = async (part, id, space = SPACE) => (await door.stored(space, part, id))?.schemaFingerprint;
const setStamp = (part, id, fp, space = SPACE) => door.coll(space, part).updateOne({ _id: id }, { $set: { schemaFingerprint: fp } });

/** One conforming record of each kind, made through REST and then unstamped, as a row written before this release is. */
async function preReleaseRows() {
  const from = (await ok('POST', `${B}/entities`, { name: uniq('Ann'), type: 'person', properties: { age: 3 } }, 'entity'))._id;
  const to = (await ok('POST', `${B}/entities`, { name: uniq('Bo'), type: 'person' }, 'entity'))._id;
  const ids = {
    entities: from,
    facts: (await ok('POST', `${B}/facts`, { fact: uniq('a fact'), type: 'claim', properties: { confidence: 1 } }, 'fact'))._id,
    chrono: (await ok('POST', `${B}/chrono`, { title: uniq('an event'), type: 'event', startsAt: T0, properties: { priority: 'high' } }, 'chrono'))._id,
    edges: (await ok('POST', `${B}/edges`, { from, to, label: 'knows', properties: { since: 2001 } }, 'edge'))._id,
  };
  for (const part of STAMPED_PARTS) await door.unstamp(SPACE, part, ids[part]);
  await door.unstamp(SPACE, 'entities', to);
  return { ...ids, from, to };
}

describe('a stamp means the record conforms as stored (D-77)', { skip }, () => {
  before(async () => {
    door = await openSchemaStampDoor({
      name: 'b265d77', spaces: [SPACE, WARN, OFF],
      metaOf: (s) => ({ ...STRICT_META, validationMode: s === WARN ? 'warn' : s === OFF ? 'off' : 'strict' }),
    });
  });
  after(async () => { await door?.close(); });

  it('(1) an unstamped row of each kind, updated conformingly, carries the current fingerprint', async () => {
    const r = await preReleaseRows();
    for (const part of STAMPED_PARTS) {
      assert.equal(await stampOf(part, r[part]), undefined, `${part}: the seed is not unstamped`);
      await ok('PATCH', `${B}/${part}/${r[part]}`, { description: `edited ${part}` }, `update of ${part}`);
      await door.assertStamped(SPACE, await door.stored(SPACE, part, r[part]), `${part}: a conforming update of a pre-release row`);
    }
  });

  it('(2) an update introducing a violation is refused and the row stays unstamped', async () => {
    const r = await preReleaseRows();
    const res = await door.rest('PATCH', `${B}/facts/${r.facts}`, { properties: { confidence: 'sure' } });
    assert.equal(res.status, 422, `a strict space let a violation through: ${res.text}`);
    assert.equal(await stampOf('facts', r.facts), undefined, 'a refused update stamped the row');
  });

  it('(3) redaction and relink never add a stamp to an unstamped row', async () => {
    const r = await preReleaseRows();
    const { redactLapsedChronoContent } = await import('../../server/dist/brain/chrono-redaction.js');
    await door.coll(SPACE, 'chrono').updateOne({ _id: r.chrono }, { $set: { description: 'to be redacted', _contentExpireAt: new Date('2020-01-01') } });
    await redactLapsedChronoContent(SPACE, new Date());
    const red = await door.stored(SPACE, 'chrono', r.chrono);
    assert.equal(red.contentRedacted, true, 'the fixture did not redact');
    assert.equal(red.schemaFingerprint, undefined, 'redaction added a stamp');

    const survivor = (await ok('POST', `${B}/entities`, { name: uniq('Cy'), type: 'person' }, 'entity'))._id;
    await door.unstamp(SPACE, 'entities', survivor);
    const m = await door.mcp('graph_merge', { space: SPACE, survivorId: survivor, absorbedId: r.from });
    assert.ok(!m.isError, m.text);
    const moved = await door.coll(SPACE, 'edges').findOne({ from: survivor, to: r.to, label: 'knows' });
    assert.ok(moved, 'the merge did not relink the edge');
    assert.equal(moved.schemaFingerprint, undefined, 'a relink added a stamp');
  });

  it('(4) the schema changes between two updates: each stamp is the fingerprint of the schema that update was checked against', async () => {
    const r = await preReleaseRows();
    try {
      await ok('PATCH', `${B}/facts/${r.facts}`, { description: 'first' }, 'first update');
      await door.assertStamped(SPACE, await door.stored(SPACE, 'facts', r.facts), 'the first update');
      const first = await door.fp(SPACE);
      const next = structuredClone(STRICT_META);
      next.typeSchemas.fact.claim.propertySchemas.source = { type: 'string' };
      door.setMeta(SPACE, next);
      const second = await door.fp(SPACE);
      assert.notEqual(second, first, 'a schema change did not change the fingerprint: the case proves nothing');
      await ok('PATCH', `${B}/facts/${r.facts}`, { description: 'second' }, 'second update');
      assert.equal(await stampOf('facts', r.facts), second, 'the second update kept the older fingerprint, or stamped another');
    } finally { door.setMeta(SPACE, STRICT_META); }
  });

  it('(5) a row that no longer conforms loses its older stamp on a description-only update, which still lands (P-6)', async () => {
    const r = await preReleaseRows();
    const twin = (await ok('POST', `${B}/chrono`, { title: uniq('the twin'), type: 'event', startsAt: T0, properties: { priority: 'high' } }, 'chrono'))._id;
    await door.unstamp(SPACE, 'chrono', twin);
    await setStamp('chrono', r.chrono, OLDER);
    const narrower = structuredClone(STRICT_META);
    narrower.typeSchemas.chrono.event.propertySchemas.priority.enum = ['low'];
    door.setMeta(SPACE, narrower);
    try {
      const res = await door.rest('PATCH', `${B}/chrono/${r.chrono}`, { description: 'only the description' });
      assert.equal(res.status, 200, `a pre-existing violation refused an unrelated update: ${res.text}`);
      assert.equal((await door.stored(SPACE, 'chrono', r.chrono)).description, 'only the description', 'the update did not land');
      assert.equal(await stampOf('chrono', r.chrono), undefined,
        'a non-conforming update kept the older stamp: the stamp now claims a conformance the stored record does not have');
      await ok('PATCH', `${B}/chrono/${twin}`, { description: 'the twin\'s description' }, 'twin update');
      assert.equal(await stampOf('chrono', twin), undefined, 'a non-conforming update stamped an unstamped row');
    } finally { door.setMeta(SPACE, STRICT_META); }
  });

  it('(6) an update that fixes the value stamps the current fingerprint, and the next description-only update stamps again', async () => {
    const r = await preReleaseRows();
    const narrower = structuredClone(STRICT_META);
    narrower.typeSchemas.chrono.event.propertySchemas.priority.enum = ['low'];
    door.setMeta(SPACE, narrower);
    try {
      await ok('PATCH', `${B}/chrono/${r.chrono}`, { properties: { priority: 'low' } }, 'the fixing update');
      await door.assertStamped(SPACE, await door.stored(SPACE, 'chrono', r.chrono), 'the update that made the row conform');
      await setStamp('chrono', r.chrono, OLDER);
      await ok('PATCH', `${B}/chrono/${r.chrono}`, { description: 'and again' }, 'a description-only update');
      await door.assertStamped(SPACE, await door.stored(SPACE, 'chrono', r.chrono), 'a conforming description-only update over an older stamp');
    } finally { door.setMeta(SPACE, STRICT_META); }
  });

  it('(7) a non-conforming create carries no stamp in warn and in off; a conforming create is stamped', async () => {
    for (const space of [WARN, OFF]) {
      const res = await door.rest('POST', `/api/brain/spaces/${space}/facts`, { fact: uniq('a breaking fact'), type: 'claim', properties: { confidence: 'very' } });
      assert.ok(res.status < 300, `${space}: the create was refused: ${res.text}`);
      if (space === WARN) assert.ok(JSON.stringify(res.body?.warnings ?? []).includes('confidence'), `${space}: the violation was not warned: ${res.text}`);
      const row = await door.stored(space, 'facts', res.body._id);
      assert.ok(row, `${space}: nothing stored`);
      assert.equal('schemaFingerprint' in row, false, `${space}: a non-conforming create carries a stamp`);
    }
    const good = await ok('POST', `/api/brain/spaces/${WARN}/facts`, { fact: uniq('a conforming fact'), type: 'claim', properties: { confidence: 2 } }, 'conforming create');
    await door.assertStamped(WARN, await door.stored(WARN, 'facts', good._id), 'a conforming create');
  });

  it('(8) DI-4: an update whose row moved between validation and write lands unstamped; unraced it stamps', { timeout: 60_000 }, async () => {
    const FACT = randomUUID();
    const CONTROL = randomUUID();
    await door.coll(SPACE, 'facts').insertMany([
      build.fact(SPACE, FACT, 3, { author: PEER_AUTHOR, type: 'claim', schemaFingerprint: OLDER }),
      build.fact(SPACE, CONTROL, 4, { author: PEER_AUTHOR, type: 'claim' }),
    ]);
    await door.setCounter(SPACE, Math.max(await door.counter(SPACE), 10));

    const park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
    try {
      const hold = park.arm(`${SPACE}_facts`, { when: UPDATE_SHAPED });
      const call = door.rest('PATCH', `${B}/facts/${FACT}`, { description: 'raced' });
      await Promise.race([hold.reached, call.then(() => { throw new Error('the update finished without parking its write'); })]);
      try {
        const landed = await door.push('/facts',
          // The peer's copy carries the peer's stamp (an arrival keeps it, Q-737), so the retried write lands on a stamped row.
          build.fact(SPACE, FACT, 5000, { author: PEER_AUTHOR, type: 'claim', fact: 'the peer\'s newer copy', schemaFingerprint: OLDER }),
          { spaceId: SPACE, token: peerToken(PEER) });
        assert.equal(landed.code, 200, `the arrival was not stored: ${JSON.stringify(landed.body)}`);
      } finally { hold.release(); }
      const answer = await call;
      assert.equal(answer.status, 200, answer.text);
    } finally { park.restore(); }
    const row = await door.stored(SPACE, 'facts', FACT);
    assert.equal(row.description, 'raced', 'the retried update is not what is stored');
    assert.ok(row.seq > 5000, `the update did not land above the arrival (seq ${row.seq}): the row did not move under it`);
    assert.equal('schemaFingerprint' in row, false,
      `a write retried onto a moved row is stamped (${row.schemaFingerprint}) without a validation of what it landed on`);

    // The control: the same update, unraced, stamps — without it the raced row's absent stamp proves nothing.
    await ok('PATCH', `${B}/facts/${CONTROL}`, { description: 'unraced' }, 'the control update');
    await door.assertStamped(SPACE, await door.stored(SPACE, 'facts', CONTROL), 'the unraced control update');
  });

  it('(9) redaction of a stamped chrono removes the stamp', async () => {
    const r = await preReleaseRows();
    const { redactLapsedChronoContent } = await import('../../server/dist/brain/chrono-redaction.js');
    await door.coll(SPACE, 'chrono').updateOne({ _id: r.chrono },
      { $set: { description: 'a redacted rule may read this', _contentExpireAt: new Date('2020-01-01'), schemaFingerprint: OLDER } });
    await redactLapsedChronoContent(SPACE, new Date());
    const row = await door.stored(SPACE, 'chrono', r.chrono);
    assert.equal(row.contentRedacted, true, 'the fixture did not redact');
    assert.equal(row.description, undefined, 'redaction kept the description');
    assert.equal('schemaFingerprint' in row, false, 'a redacted chrono keeps a stamp that claims a conformance redaction may have broken');
  });

  it('(10) a relink of a stamped edge removes the stamp, re-keyed and in place', async () => {
    const r = await preReleaseRows();
    await setStamp('edges', r.edges, OLDER);
    // A peer-authored edge is written in place, never re-keyed.
    const foreign = randomUUID();
    await door.coll(SPACE, 'edges').insertOne(build.edge(SPACE, foreign, 7, { author: PEER_AUTHOR, from: r.from, to: r.to, label: 'likes', schemaFingerprint: OLDER }));
    const survivor = (await ok('POST', `${B}/entities`, { name: uniq('Dee'), type: 'person' }, 'entity'))._id;
    const m = await door.mcp('graph_merge', { space: SPACE, survivorId: survivor, absorbedId: r.from });
    assert.ok(!m.isError, m.text);
    const rekeyed = await door.coll(SPACE, 'edges').findOne({ from: survivor, to: r.to, label: 'knows' });
    assert.ok(rekeyed, 'the merge did not relink the local edge');
    assert.equal('schemaFingerprint' in rekeyed, false, 'a re-keyed edge keeps a stamp its new ends were never checked against');
    const inPlace = await door.stored(SPACE, 'edges', foreign);
    assert.equal(inPlace?.from, survivor, 'the peer-authored edge was not relinked in place');
    assert.equal('schemaFingerprint' in inPlace, false, 'an edge relinked in place keeps its stamp');
  });

  it('(11) a KEEP writer (the retention-stamp heal) leaves a stamp as it was', async () => {
    const r = await preReleaseRows();
    const { healStoredStamps } = await import('../../server/dist/brain/retention-stamp-heal.js');
    await door.coll(SPACE, 'facts').updateOne({ _id: r.facts }, { $set: { _expireAt: '2031-01-01T00:00:00.000Z', schemaFingerprint: OLDER } });
    const healed = await healStoredStamps(SPACE, 'facts', '_expireAt');
    assert.ok(healed >= 1, 'the heal rewrote nothing: the fixture does not reach the writer');
    const row = await door.stored(SPACE, 'facts', r.facts);
    assert.ok(row._expireAt instanceof Date, 'the heal did not run on the row');
    assert.equal(row.schemaFingerprint, OLDER, 'a writer that changes no schema-relevant content changed the stamp');
  });
});
