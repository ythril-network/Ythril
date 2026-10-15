/**
 * A merge the strict schema refuses answers the ONE schema-refusal body, with status 400, on every door that can run
 * a merge — including `graph_merge` and `POST /api/graph_merge` (`Q-315`, R5-3).
 *
 * ## The finding
 *
 * A merge whose survivor would break its space's schema answers `{ error: <the sentence>, violations }` on REST — and the
 * same refusal is `{ error: 'schema_violation', message, introduced, preExisting, violations }` everywhere else a record
 * is refused. A caller that handles the schema refusal (reads `introduced` to say which of its fields to fix, reads
 * `error` as the code) has to special-case merge. `a-refused-merge-answers-alike-on-every-door-db` pins the STATUS (400)
 * and that nothing is written; this pins the BODY, and keeps the status: the refusal stays 400 on every merge door
 * (published, CHANGELOG [Unreleased]), so a merge that became a `SchemaViolationError` and was mapped by the generic
 * branch of `callTool` would flip `graph_merge` to 422 — which is what the last case below holds off.
 *
 * ## The doors are derived, not listed
 *
 * The callers of `mergeEntities` are read from the source (as the sibling test reads them), and a door without a driver
 * here fails the derivation. `graph_merge` is driven twice, because it has two entrances: the MCP transport and
 * `POST /api/graph_merge` (`api/tools.ts`), whose body is `{ ok, error, data }` with the refusal in `data`. Automerge has no
 * body to answer and is the sibling test's.
 *
 * ## The fixture refuses by what the merge INTRODUCES
 *
 * A survivor with no `age`, an absorbed person aged 11 (a value only it holds, so there is no conflict for the
 * duplicate route to leave unresolved), and a schema that caps `age` at 10: the survivor is valid before the merge and
 * not after, so the refusal is an `introduced` violation and `preExisting` is empty. (A survivor whose own type already
 * broke an allowlist would be a pre-existing violation, which a merge that follows the write path's split no longer
 * refuses.)
 *
 * ## Seen red
 *
 * On 85c4c564 the REST doors answer `{ error: 'merge refused: …', violations }` — no `introduced`, no `preExisting`, and
 * `error` is a sentence, not the code.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-refused-merge-answers-the-standard-body-on-every-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const SPACE = 'mergebody';
const META = {
  validationMode: 'strict',
  typeSchemas: { entity: { person: { propertySchemas: { age: { type: 'number', maximum: 10 } } } } },
};

const BODY_KEYS = ['error', 'introduced', 'message', 'preExisting', 'violations'];
const AUTHOR = { instanceId: 'mergebody-receiver', instanceLabel: 'Receiver' };

let door, bumpSeq, entitiesRouter, duplicatesRouter, toolsRouter;

/** Every caller of `mergeEntities` outside its module — the doors, from the source. */
const mergeDoors = () => readTrackedSources('server/src', { untracked: true, floor: 300 })
  .filter(({ file, text }) => file !== 'server/src/brain/merge.ts' && /\bmergeEntities\s*\(/.test(stripComments(text)))
  .map(f => f.file);

async function seedPair() {
  const [survivorId, absorbedId] = [randomUUID(), randomUUID()];
  const T0 = '2026-09-01T00:00:00.000Z';
  await door.coll(SPACE, 'entities').insertMany([[survivorId, 'North', {}, 1], [absorbedId, 'South', { age: 11 }, 2]].map(([_id, name, properties, seq]) => ({
    _id, spaceId: SPACE, name, type: 'person', tags: [], properties, author: AUTHOR, createdAt: T0, updatedAt: T0, seq,
  })));
  await bumpSeq(SPACE, 2);
  return { survivorId, absorbedId };
}

/** What each door answers for the same refused merge: `{ status, body }`, `body` being the refusal body wherever the door carries it. */
const DRIVERS = {
  /** POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId */
  'server/src/api/brain/entities.ts': async ({ survivorId, absorbedId }) => {
    const h = door.routeHandler(entitiesRouter, 'post', '/spaces/:spaceId/entities/:survivorId/merge/:absorbedId');
    const out = await door.request(h, { params: { spaceId: SPACE, survivorId, absorbedId }, body: {} });
    return { status: out.status, body: out.body };
  },
  /** POST /api/duplicates/:id/merge — the candidate the scanner would have recorded. */
  'server/src/api/duplicates.ts': async ({ survivorId, absorbedId }) => {
    const [aId, bId] = [survivorId, absorbedId].sort();
    const _id = `entity:${aId}:${bId}`;
    await door.coll(SPACE, 'dupe_candidates').insertOne({ _id, spaceId: SPACE, type: 'entity', aId, bId,
      aSeq: aId === survivorId ? 1 : 2, bSeq: bId === survivorId ? 1 : 2, score: 0.99, status: 'open', detectedAt: 'x', updatedAt: 'x' });
    const h = door.routeHandler(duplicatesRouter, 'post', '/:id/merge');
    const out = await door.request(h, { params: { id: _id }, body: {} });
    return { status: out.status, body: out.body };
  },
  /** `graph_merge` through the MCP transport. */
  'server/src/mcp/tools/entity.ts': async ({ survivorId, absorbedId }) => {
    const out = await door.call('graph_merge', { space: SPACE, survivorId, absorbedId });
    return { status: out.status, body: out.structured, text: out.text };
  },
};

/** `POST /api/graph_merge`: the same tool through the generic REST door, whose body is `{ ok, error, data }`. */
async function restGraphMerge({ survivorId, absorbedId }) {
  const h = door.routeHandler(toolsRouter, 'post', '/:tool');
  const out = await door.request(h, { params: { tool: 'graph_merge' }, body: { space: SPACE, survivorId, absorbedId } });
  return { status: out.status, body: out.body?.data, envelope: out.body };
}

describe('a refused merge answers the one schema-refusal body on every merge door', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'mergebody', spaces: [{ id: SPACE, label: SPACE, folders: [], meta: META }] });
    ({ bumpSeq } = await import('../../server/dist/util/seq.js'));
    ({ entitiesRouter } = await import('../../server/dist/api/brain/entities.js'));
    ({ duplicatesRouter } = await import('../../server/dist/api/duplicates.js'));
    ({ toolsRouter } = await import('../../server/dist/api/tools.js'));
  });
  after(async () => { await door?.close(); });

  it('every merge door has a driver here (derived from the callers of mergeEntities)', () => {
    const doors = mergeDoors();
    assert.ok(doors.length >= 4, `only ${doors.length} caller(s) of mergeEntities found — the derivation is broken: ${doors}`);
    const unreached = doors.filter(f => !(f in DRIVERS) && f !== 'server/src/brain/dupe-scanner.ts');
    assert.deepEqual(unreached, [], 'a merge door has no driver in this file — every door a merge can run through must be asked how it refuses one');
  });

  const everyDoor = () => [...Object.entries(DRIVERS), ['POST /api/graph_merge', restGraphMerge]];

  for (const [name] of [...Object.entries(DRIVERS), ['POST /api/graph_merge']]) {
    it(`${name}: status 400, and the body is { error: 'schema_violation', message, introduced, preExisting, violations }`, async () => {
      const drive = everyDoor().find(([n]) => n === name)[1];
      const out = await drive(await seedPair());
      assert.equal(out.status, 400, `${name} answered ${out.status} for a merge the strict schema refuses — the refusal is the caller's, on every door`);
      assert.ok(out.body && typeof out.body === 'object', `${name}: no refusal body (${JSON.stringify(out)})`);
      assert.deepEqual(Object.keys(out.body).sort(), BODY_KEYS, `${name}: the body is not the schema-refusal body: ${JSON.stringify(out.body).slice(0, 300)}`);
      assert.equal(out.body.error, 'schema_violation', `${name}: \`error\` is the sentence, not the code`);
      assert.equal(typeof out.body.message, 'string');
      assert.match(out.body.message, /properties\.age/, `${name}: the message does not name the field the merge broke`);
    });
  }

  it('what the merge introduced is `introduced`, and the survivor\'s own (valid) state has no pre-existing violation', async () => {
    const pair = await seedPair();
    const { body } = await DRIVERS['server/src/api/brain/entities.ts'](pair);
    assert.deepEqual(body?.introduced?.map(v => v.field), ['properties.age'], `introduced: ${JSON.stringify(body?.introduced)}`);
    assert.equal(body.introduced[0].value, 11, 'the violation does not carry the merged value');
    assert.deepEqual(body.preExisting, [], 'the survivor was valid before the merge and the body calls something pre-existing');
    assert.deepEqual(body.violations, body.introduced, '`violations` is not the list of everything the merged survivor fails');
  });

  it('all four doors answer the same body for the same refusal (the door the caller picked does not change it)', async () => {
    const seen = [];
    for (const [name, drive] of everyDoor()) {
      const { body } = await drive(await seedPair());
      // The sentence names the two ids, which differ per seeded pair: compared with them taken out.
      const stable = { ...body, message: String(body?.message).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>') };
      seen.push([name, JSON.stringify(stable)]);
    }
    const [first, ...rest] = seen;
    for (const [name, body] of rest) assert.equal(body, first[1], `${name} answered a different body than ${first[0]}`);
  });

  it('graph_merge is still 400 on both of its entrances, with the refusal as its structured content', async () => {
    const mcp = await DRIVERS['server/src/mcp/tools/entity.ts'](await seedPair());
    const rest = await restGraphMerge(await seedPair());
    assert.equal(mcp.status, 400, `graph_merge over MCP answered ${mcp.status}`);
    assert.equal(rest.status, 400, `POST /api/graph_merge answered ${rest.status}`);
    assert.equal(rest.envelope.ok, false);
    assert.match(mcp.text, /^Error: /, 'the MCP text is not an error sentence');
    assert.equal(rest.body?.error, 'schema_violation', 'POST /api/graph_merge carries no schema-refusal body in `data`');
    assert.equal(mcp.body?.error, 'schema_violation', 'graph_merge carries no schema-refusal body as structuredContent');
  });
});
