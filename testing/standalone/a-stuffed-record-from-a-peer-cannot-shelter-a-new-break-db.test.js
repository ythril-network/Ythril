/**
 * A record a peer pushed with a value too large for a rule to read is recorded, never refused — and it cannot then be used to
 * shelter a new break of the same rule (F-46, ruling R6-3; security review S5).
 *
 * ## The path, end to end
 *
 * 1. A peer pushes an entity whose property `a` is 50 000 characters. The receiver's rule `present` reads `a`, so for this record
 *    the rule is "too large to check" — a violation. A record that arrives over sync is RECORDED and never refused (the receiver
 *    applies its own rules to what it holds, it does not veto what a peer already wrote), so the push answers 200 and the record
 *    is stored with its stuffed value.
 * 2. An operator or an agent then edits it. A write that changes nothing the rule reads (a description) is allowed: the break is
 *    pre-existing, and a record that was already broken must stay editable (P-6). A write that REPLACES the stuffed value with
 *    another one over the cap is a new break of the same rule and is refused — otherwise "too large to check" would be a
 *    permanent exemption any peer could hand a record, and the strict space's rule would be a rule on records nobody pushed.
 *    A write that shrinks the value to something the rule can read is allowed (the repair passes).
 *
 * Both write doors are asked (REST PATCH and MCP `save_entity`), because the clause is the planner's and the planner has two
 * callers.
 *
 * ## Why this is a database test and the classifier test is not enough
 *
 * `a-cel-rule-break-is-introduced-by-the-write-that-touches-it` holds the clause on `classifyEntityUpsertAgainst` with objects. What
 * only this proves is that the record the PUSH door stored is the record the write door then reads back and compares: that the
 * arrival writer did not truncate, reject or re-shape the value, and that "before" is what the collection holds and not what the
 * test says it holds.
 *
 * ## Why this is red on the base
 *
 * The base has no rule engine: the push stores the record (as it should), but the `present` rule is not even accepted in a
 * schema, so the space the case needs cannot be configured (the config loader drops what the strict body refuses), and the
 * replace-the-value write is allowed.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-stuffed-record-from-a-peer-cannot-shelter-a-new-break-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { response, adminRights, routeOf, chainFrom, requestOf, callMcp } from './_cel-doors.mjs';

const skip = await mongoSkipReason();

const SPACE = 'stuffed';
const ID = 'aaaaaaaa-0000-4000-8000-0000000057ff';
const HUGE = 'x'.repeat(50_000);
const META = {
  validationMode: 'strict', suppressEmbeddings: true,
  typeSchemas: { entity: { thing: {
    propertySchemas: { a: { type: 'string' } },
    rules: { present: { rule: 'size(self.properties.a) > 0', message: 'a must not be empty' } },
  } } },
};

let door, restPatch, ADMIN;

const restEdit = async (body) => {
  const res = await chainFrom(restPatch, 'denyReadOnly', requestOf({ params: { spaceId: SPACE, id: ID }, body, rights: ADMIN }), response());
  return { refused: res.statusCode >= 400, status: res.statusCode, text: JSON.stringify(res.body ?? '') };
};
const mcpEdit = async (body) => {
  const o = await callMcp('save_entity', { space: SPACE, id: ID, name: 'Entity stuffed', type: 'thing', ...body }, ADMIN);
  return { refused: o.isError, status: o.status, text: `${o.text} ${JSON.stringify(o.structured ?? {})}` };
};
const EDITS = { 'PATCH /api/brain/spaces/:spaceId/entities/:id': restEdit, 'save_entity': mcpEdit };

const storedA = async () => (await door.coll(SPACE, 'entities').findOne({ _id: ID }))?.properties?.a;

describe('a record a peer stuffed cannot shelter a new break', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'stuffedrecord', spaces: [{ id: SPACE, label: 'Stuffed', folders: [], completeLinkage: true, meta: META }] });
    const { entitiesRouter } = await import('../../server/dist/api/brain/entities.js');
    restPatch = routeOf(entitiesRouter, 'patch', '/spaces/:spaceId/entities/:id');
    ADMIN = await adminRights();
  });
  after(async () => { await door?.close(); });

  /** Put the stuffed record in the space the way a peer does, and return what the push answered. */
  async function arrive() {
    await door.wipe(SPACE);
    return door.push('/entities', build.entity(SPACE, ID, 1, { name: 'Entity stuffed', type: 'thing', properties: { a: HUGE } }), { spaceId: SPACE });
  }

  it('the push is accepted and the record is stored whole, with the break recorded by name and the value not quoted', async () => {
    const pushed = await arrive();
    assert.equal(pushed.code, 200, `the push of a stuffed record was refused: ${JSON.stringify(pushed.body).slice(0, 300)}`);
    assert.equal(await storedA(), HUGE, 'the arrival writer changed the value it stored');
    const recorded = JSON.stringify(pushed.body?.schemaViolations ?? null);
    assert.match(recorded, /present/, `the arrival did not record that the rule could not judge this record: ${recorded.slice(0, 300)}`);
    assert.ok(!recorded.includes('xxxxxxxxxx'), 'the record of the break quotes the stuffed value');
  });

  for (const [door_, edit] of Object.entries(EDITS)) {
    it(`${door_}: an edit that leaves the property alone is allowed, an edit that replaces it with another oversize value is refused, a repair is allowed`, async () => {
      await arrive();
      const unrelated = await edit({ description: 'an unrelated edit' });
      assert.equal(unrelated.refused, false, `${door_}: a record that arrived stuffed became uneditable: ${unrelated.text.slice(0, 300)}`);

      const replaced = await edit({ properties: { a: `${HUGE}y` } });
      assert.equal(replaced.refused, true, `${door_}: a stuffed record sheltered a new oversize value (any peer can hand out that exemption)`);
      assert.match(replaced.text, /rules\.present/, `${door_}: the refusal does not name the rule: ${replaced.text.slice(0, 300)}`);
      assert.equal(await storedA(), HUGE, `${door_}: a refused write changed the stored value`);

      const repaired = await edit({ properties: { a: 'small' } });
      assert.equal(repaired.refused, false, `${door_}: a write that makes the record satisfy the rule was refused: ${repaired.text.slice(0, 300)}`);
      assert.equal(await storedA(), 'small');
    });
  }
});
