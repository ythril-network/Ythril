/**
 * Q-952: a bulk item's link field takes stored ids. A `$ref:key` is resolved only at the two ends of a top-level edge
 * (`brain/bulk.ts`), so a fact whose `linkEntities` names `$ref:n` is refused, on REST (`POST /api/brain/spaces/:id/bulk`) and
 * on MCP (`save_bulk`) alike.
 *
 * The rule pinned is the refusal AND its words. The bulk door never loses such a link silently: the fact is not stored and its
 * error row says why, in terms a caller can act on. "A name is not a reference" hid the cause; the row names the correlation
 * key and the two remedies (save the entity first, or connect the records by an edge).
 *
 * The control in the same call: a fact linking an entity stored BEFORE the call keeps its link row, and the entity of the
 * call is stored, so the refusal is of the one fact and of nothing else.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor } from './_b81c-door.mjs';

const skip = await mongoSkipReason();
const REST_SPACE = 'q952-rest';
const MCP_SPACE = 'q952-mcp';
const REFUSED_FACT = 'links the entity of this call';

describe('a bulk link field refuses a $ref of the same call and says why (real MongoDB)', { skip }, () => {
  let door;
  before(async () => { door = await openB81cDoor({ name: 'q952', spaces: [REST_SPACE, MCP_SPACE], app: true }); });
  after(async () => { await door?.close(); });

  const DOORS = {
    rest: { space: REST_SPACE, send: (space, body) => door.rest('POST', `/api/brain/spaces/${space}/bulk`, body) },
    mcp: { space: MCP_SPACE, send: (space, body) => door.mcp('save_bulk', { space, ...body }) },
  };

  for (const [name, d] of Object.entries(DOORS)) {
    it(`${name}: the fact naming $ref:n is refused with the cause, the entity and the control fact are stored`, async () => {
      const seeded = await d.send(d.space, { entities: [{ name: 'Stored before', type: 'person', $ref: 'x' }] });
      const storedId = seeded.body.refs?.x?.id;
      assert.ok(storedId, `the seeding call stored nothing: ${JSON.stringify(seeded.body)}`);

      const res = await d.send(d.space, {
        entities: [{ name: 'Same call', type: 'person', $ref: 'n' }],
        facts: [
          { fact: REFUSED_FACT, linkEntities: ['$ref:n'], $ref: 'fn' },
          { fact: 'links the entity stored before', linkEntities: [storedId], $ref: 'fe' },
        ],
      });
      assert.equal(res.body.errors?.length, 1, `exactly the one fact is refused: ${JSON.stringify(res.body)}`);
      const row = res.body.errors[0];
      assert.equal(row.type, 'fact');
      assert.equal(row.index, 0);

      // The fact is not stored: no ref for it, no fact record with its text.
      assert.equal(res.body.refs?.fn, undefined, 'the refused fact has an id');
      assert.equal(await door.coll(d.space, 'facts').countDocuments({ fact: REFUSED_FACT }), 0, 'the refused fact was stored');

      // The refusal names the cause and what to do instead, not "a name is not a reference".
      assert.match(row.reason, /\$ref:n/, 'the row names the offending value');
      assert.match(row.reason, /only at an edge's `from` or `to`/, `the row does not say where a $ref key resolves: ${row.reason}`);
      assert.match(row.reason, /save the entity first/, `the row does not say what to do instead: ${row.reason}`);
      assert.doesNotMatch(row.reason, /a name is not a reference/, 'a $ref key is not a name; the row blames the wrong thing');

      // The entity of the call is stored; the control keeps its one link row.
      const entityId = res.body.refs?.n?.id;
      assert.ok(entityId, `the entity of the call was not stored: ${JSON.stringify(res.body)}`);
      assert.ok(await door.coll(d.space, 'entities').findOne({ _id: entityId }), 'the entity of the call has no record');
      const rows = await door.coll(d.space, 'links').find({ fromKind: 'fact' }).toArray();
      const linksOf = (factRef) => rows.filter(r => r.from === res.body.refs?.[factRef]?.id).map(r => r.to);
      assert.deepEqual(linksOf('fe'), [storedId], 'the control lost its link');
    });
  }
});
