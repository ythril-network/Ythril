/**
 * A rule judges the record a write LEAVES, all of it — not the fields the write happened to name (F-46, ruling R6-3).
 *
 * ## What it prevents
 *
 * `recordViewOf` documents that it is handed the MERGED record, and every classifier (`classify<Kind>UpsertAgainst`) handed it a
 * literal of the fields it had in hand instead: an edge and a fact lost their tags, a fact and a chrono entry their title and
 * description, an entity its description. The before-view was the stored record and had them; the after-view did not. So a rule that
 * reads `self.description`, `self.tags` or `self.title`:
 *
 * - **blamed the write for a break it did not make** — an upsert that touched one property "removed" the description, and a strict
 *   space refused it;
 * - **or hid one** — a write that set the description to a value the rule refuses was judged on `''`, the same break the record
 *   had before, and passed as pre-existing.
 *
 * ## What is asserted
 *
 * Per kind, through the classifier every write goes through: a write that leaves a field alone leaves the rule that reads it
 * satisfied, and a write that changes a field is judged on the value it wrote.
 *
 * Run: node --test testing/standalone/a-rule-reads-the-record-the-write-leaves.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rule, strictMeta, recordOf, ruleRows, evaluation, KINDS } from './_cel-rules.mjs';

const CLASSIFIER = { entity: 'classifyEntityUpsertAgainst', edge: 'classifyEdgeUpsertAgainst', fact: 'classifyFactUpsertAgainst', chrono: 'classifyChronoUpsertAgainst' };

/** The fields that name the record a write lands on: what an upsert of `kind` must carry, and nothing a rule reads. */
const identity = { entity: { name: 'Acme', type: 'thing' }, edge: { label: 'thing' }, fact: { type: 'thing' }, chrono: { type: 'thing' } };

/** The kind's own spelling of its title, for the kinds that have one. */
const TITLE = { entity: 'name', fact: 'fact', chrono: 'title' };

async function classify(kind, rules, existing, incoming) {
  const { writeValidation } = await evaluation();
  return writeValidation[CLASSIFIER[kind]](strictMeta({ kind, rules }), existing, incoming);
}
const fieldsOf = (violations) => ruleRows(violations).map(v => v.field);

describe('a write that leaves a field alone leaves a rule that reads it satisfied', () => {
  for (const kind of KINDS) {
    it(`${kind}: the stored description is the record's after a write that does not name it`, async () => {
      const c = await classify(kind, { described: rule(`self.description != ''`, 'a description is required') },
        recordOf[kind]({ description: 'as stored' }), { ...identity[kind], properties: { a: 'x' } });
      assert.deepEqual(fieldsOf(c.all), [], `${kind}: the after-view lost the stored description, so the rule reads ''`);
      assert.equal(c.blocked, false);
    });

    it(`${kind}: the stored tags are the record's after a write that does not name them`, async () => {
      const c = await classify(kind, { tagged: rule('size(self.tags) > 0', 'a tag is required') },
        recordOf[kind]({ tags: ['kept'] }), { ...identity[kind], properties: { a: 'x' } });
      assert.deepEqual(fieldsOf(c.all), [], `${kind}: the after-view lost the stored tags`);
      assert.equal(c.blocked, false);
    });
  }

  for (const kind of ['entity', 'fact', 'chrono']) {
    it(`${kind}: the stored title is the record's after a write that does not name it`, async () => {
      const stored = recordOf[kind]();
      const incoming = { ...identity[kind], properties: { a: 'x' } };
      if (kind === 'entity') incoming.name = stored.name; // an entity upsert names its record by its name
      const c = await classify(kind, { titled: rule(`self.title != ''`, 'a title is required') }, stored, incoming);
      assert.deepEqual(fieldsOf(c.all), [], `${kind}: the after-view has no ${TITLE[kind]}`);
    });
  }
});

describe('a write that changes a field is judged on the value it wrote', () => {
  for (const kind of KINDS) {
    it(`${kind}: a description the write sets repairs a record that broke the rule`, async () => {
      const c = await classify(kind, { described: rule(`self.description != ''`, 'a description is required') },
        recordOf[kind]({ description: '' }), { ...identity[kind], description: 'now described' });
      assert.deepEqual(fieldsOf(c.all), [], `${kind}: the write's own description was not what the rule read`);
    });

    it(`${kind}: a description the write sets to a refused value is the write's break`, async () => {
      const c = await classify(kind, { notTodo: rule(`self.description != 'TODO'`, 'a placeholder is not a description') },
        recordOf[kind]({ description: 'fine' }), { ...identity[kind], description: 'TODO' });
      assert.deepEqual(fieldsOf(c.introduced), ['rules.notTodo'], `${kind}: the break the write made was not seen`);
      assert.equal(c.blocked, true);
    });
  }

  for (const kind of ['fact', 'chrono']) {
    it(`${kind}: a title the write sets is the one the rule reads`, async () => {
      const c = await classify(kind, { notTodo: rule(`self.title != 'TODO'`, 'a placeholder is not a title') },
        recordOf[kind](), { ...identity[kind], [TITLE[kind]]: 'TODO' });
      assert.deepEqual(fieldsOf(c.introduced), ['rules.notTodo'], `${kind}: the write's own ${TITLE[kind]} was not what the rule read`);
    });
  }
});
