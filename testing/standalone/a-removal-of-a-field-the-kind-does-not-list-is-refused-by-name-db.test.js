/**
 * A planner refuses, by name, a removal of a top-level field its kind does not list (`Q-962`, review A6).
 *
 * ## The rule
 *
 * `DELETABLE_FIELDS[kind]` is the whole answer of what a removal can take from a record of that kind. A path under a field outside it (`weight`
 * on a fact, `suppressEmbeddings` on an entity) used to be accepted and do nothing; the planners (`foldRemovals`) refuse it, naming the path,
 * as they refuse a system field, and a path under a listed field (nested, or a key that is not there) is still taken. The update writers keep
 * their own contract for a path they ignore (`reflectDeleteFields`, `a-removal-is-reflected-by-one-helper-in-the-writers-and-the-planners`).
 *
 * ## Seen red
 *
 * On 96be09a1c `foldRemovals('fact', stored, {}, { deleteFields: ['weight'] })` returns a plan and removes nothing.
 *
 * Run: node --test testing/standalone/a-removal-of-a-field-the-kind-does-not-list-is-refused-by-name-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openWriteGroupFixture } from './_write-group.mjs';

const skip = await mongoSkipReason();

let fx;
let fold;
let RequestRefusal;
// The table's own lists, loaded once the fixture has set the config path: never a copy written out here.
let DELETABLE_FIELDS;
const stored = { tags: ['a'], description: 'd', properties: { k: 1 }, weight: 0.5, recurrence: 'daily', suppressEmbeddings: true };
const KINDS = ['entity', 'fact', 'edge', 'chrono'];

describe('a removal of a field the kind does not list is refused by name', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('removalunlisted');
    ({ foldRemovals: fold } = await import('../../server/dist/brain/write-plan/plan-steps.js'));
    ({ RequestRefusal } = await import('../../server/dist/util/errors.js'));
    ({ DELETABLE_FIELDS } = await import('../../server/dist/brain/delete-fields.js'));
  });
  after(async () => { await fx?.cleanup(); });

  // Every field a record of ANY kind lists, tried on every kind: what a kind does not list is refused there, whatever another kind lists.
  for (const kind of KINDS) {
    it(`${kind}: what its table lists is taken, every other listed field of any kind is refused by name`, () => {
      const fields = [...new Set(KINDS.flatMap(k => DELETABLE_FIELDS[k]))];
      assert.ok(fields.some(f => !DELETABLE_FIELDS[kind].includes(f)) || kind === 'chrono', 'fixture: no field of another kind to refuse');
      for (const field of fields) {
        const call = () => fold(kind, stored, {}, { deleteFields: [field] });
        if (DELETABLE_FIELDS[kind].includes(field)) {
          assert.equal(call().removing, true, `a removal of '${field}' on a ${kind} was not taken`);
        } else {
          assert.throws(call, (err) => err instanceof RequestRefusal && err.message.includes(`'${field}'`), `a removal of '${field}' on a ${kind} was not refused by name`);
        }
      }
    });
  }

  it('a path UNDER an unlisted field is refused by the field it starts with', () => {
    assert.throws(() => fold('fact', stored, {}, { deleteFields: ['weight.x'] }), (err) => err instanceof RequestRefusal && err.message.includes('weight'));
  });

  it('a key that is not there, under a listed field, is still no refusal', () => {
    const folded = fold('fact', stored, {}, { deleteFields: ['properties.absent'] });
    assert.equal(folded.removing, true);
  });
});
