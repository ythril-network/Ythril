/**
 * A `$ref` naming a schema-library entry that does not exist is refused at 422, in the package's one sentence, by EVERY door a schema
 * reaches: the create, the four inline saves and the two dry runs (Q-668, B5, S6).
 *
 * ## What was found
 *
 * The refusal was written five times, two of them with the "not found" sentence typed out by hand (`PUT /:id/schema`, the single-type
 * PUT), and no test held a door to the status AND the exact text: a hand copy could drift a word and every door test still passed on
 * "refused, mentions the entry". And the dry-run doors — `POST /api/spaces/:id/validate-schema` and MCP `schema_validate`, whose claim
 * is that a proposed meta is "parsed exactly as a schema save would parse it" — did not run the check at all: a meta the save refuses
 * with 422 passed the dry run with 200.
 *
 * ## What each door must do
 *
 * Answer 422 with `brokenRefsError([name])` — the package's own words, read from the package, never retyped here — and store nothing:
 * the space's meta is unchanged, and the create door creates no space. The rows are the table's `missing` rows
 * (`_invalid-schema-fixtures.mjs` REF_ROWS); the doors are `_schema-doors.mjs`'s, production's own handlers.
 *
 * Run: node --test testing/standalone/every-door-refuses-a-missing-library-entry-alike-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { REF_ROWS, EDGE_ENTRY, ENTITY_ENTRY } from './_invalid-schema-fixtures.mjs';
import { bootSchemaInstance, INLINE_DOORS, CREATE_DOOR, VALIDATE_DOORS } from './_schema-doors.mjs';
import { brokenRefsError } from '../../schema/dist/internal.js';

const dir = tempInstanceDir('ythril-missing-ref-');
const skip = await mongoSkipReason();
const SPACE = 'sch';
const DOORS = [CREATE_DOOR, ...INLINE_DOORS, ...VALIDATE_DOORS];
const MISSING_ROWS = REF_ROWS.filter(r => r.missing === true);

/** The meta a row is driven as: one type that is nothing but its `$ref`. */
const refMeta = (kind, type, entry) => ({ typeSchemas: { [kind]: { [type]: { $ref: `library:${entry}` } } } });

describe('every door refuses a $ref to a missing library entry alike', { skip }, () => {
  let inst;
  before(async () => {
    await openTestMongo('missing_library_entry_doors');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: SPACE, label: 'Schema space', folders: [], meta: { validationMode: 'strict' } },
        { id: 'general', label: 'General', builtIn: true, folders: [] },
      ],
      library: [EDGE_ENTRY, ENTITY_ENTRY].map(e => ({ ...e, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })),
    });
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  it('the table and the doors are read in full', () => {
    assert.ok(MISSING_ROWS.length >= 1, 'REF_ROWS carries no missing-entry row: every door below would pass about nothing');
    assert.equal(DOORS.length, 7);
    for (const door of DOORS) assert.equal(typeof inst.doors[door], 'function', `the harness has no ${door} door`);
    for (const row of MISSING_ROWS) assert.ok(!inst.heldEntry(row.ref), `the library holds ${row.ref}, so the row is not about a missing entry`);
  });

  for (const row of MISSING_ROWS) {
    for (const door of DOORS) {
      it(`${door} refuses ${row.id} at 422 in the package's words, and stores nothing`, async () => {
        inst.reset();
        const before = inst.heldMeta(SPACE);
        const spacesBefore = inst.loader.getConfig().spaces.map(s => s.id).sort();
        const expected = brokenRefsError([row.ref]);
        const answer = await inst.doors[door](SPACE, refMeta(row.kind, row.type, row.ref));
        assert.equal(answer.status, 422, `${door} answered ${answer.status} for ${row.id}: ${answer.text.slice(0, 300)}`);
        assert.ok(answer.text.includes(expected), `${door} refused, but not in the package's words.\n  expected: ${expected}\n  answered: ${answer.text.slice(0, 400)}`);
        if (answer.body && typeof answer.body === 'object' && 'error' in answer.body) assert.equal(answer.body.error, expected, `${door}'s error field`);
        assert.deepEqual(inst.heldMeta(SPACE), before, `${door} refused ${row.id} but the space's meta changed`);
        assert.deepEqual(inst.loader.getConfig().spaces.map(s => s.id).sort(), spacesBefore, `${door} refused ${row.id} but a space was created`);
      });
    }
  }

  for (const door of VALIDATE_DOORS) {
    it(`${door} answers a $ref of an entry that exists (the control: the door is reached and answers)`, async () => {
      inst.reset();
      const answer = await inst.doors[door](SPACE, refMeta('entity', 'Person', ENTITY_ENTRY.name));
      assert.equal(answer.status, 200, `${door} refused a $ref to an entry the library holds: ${answer.text.slice(0, 300)}`);
    });
  }
});
