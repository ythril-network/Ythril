/**
 * A create door and its update door never disagree about what a value must LOOK like.
 *
 * ## The nine defects behind this
 *
 * `W-14`..`W-22`, measured one by one. Every one is the same shape: the same field, two doors, two rules,
 * and the weaker one wins for whoever happened to use it.
 *
 *   - a chrono `PATCH` validated NOTHING it destructured, so one request stored `title: 42` and
 *     `startsAt: {"$gte": "…"}` — a query operator sitting where a date belongs, in a field
 *     `validateDeleteFields` will not even let you DELETE because it is required.
 *   - `fact` was capped at 50 000 on all four CREATE doors and neither UPDATE door.
 *   - edge `weight` was bounded 0–1 on both MCP doors and unbounded on both REST doors.
 *   - a blank `name` or `label` got in through whichever door did not trim before testing — and since an
 *     edge `_id` is derived from its label, the blank one RE-KEYED the record.
 *
 * ## Why this gate is small
 *
 * Because the fix is not a gate. `brain/write-shape.ts` holds one table per record type, and both doors read
 * it — so the disagreement is structurally impossible rather than detected, and all this has to check is
 * that every door reads it.
 *
 * The alternative was a gate that extracts each door's checks from source and diffs them. This repo has
 * burned on that repeatedly: a check written against a SPELLING goes red when the spelling improves, and
 * passes when the rule is reimplemented in different words. `linkClassFor('fact')` was matched literally
 * by one gate and `from: entityId` by another, and both went red on refactors that made the code better.
 *
 * ## The three things the table must never do
 *
 * Asserted here rather than trusted, because each would break something that works today.
 *
 * Run: node --test testing/standalone/a-create-and-its-update-agree-on-shape.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { CHRONO_STATUSES } from '../../server/dist/config/types.js';
/*
 * The record types come from the SOURCE that defines them, never from a list written here.
 *
 * `write-shape.ts` derives its own table type from `KnowledgeType` for exactly this reason, so a fifth type
 * would give it a table entry and a compiler error — while a list copied into this file would keep passing,
 * asserting the rule over four types and reporting nothing about the fifth. That is the whole subject of the
 * `Q-6` sweep, and this file is one of its own suspicions.
 */
import { KNOWLEDGE_TYPES } from '../../server/dist/config/types-knowledge.js';

const { shapeError, shapedFields, MAX_FACT_LENGTH } =
  await import('../../server/dist/brain/write-shape.js');

const code = (f) => stripComments(readFileSync(f, 'utf8'));

/**
 * Every door that writes one of the four types, and which type it writes.
 *
 * Named individually rather than swept, because "writes a memory" is not greppable — the bulk importer
 * validates its own items inline and `update_chrono` writes through a computed key. A derived list would
 * miss the two that carried the worst of the nine.
 */
const DOORS = {
  'server/src/api/brain/facts.ts': ['fact'],
  'server/src/api/brain/chrono.ts': ['chrono'],
  'server/src/api/brain/entities.ts': ['entity'],
  'server/src/api/brain/edges.ts': ['edge'],
  'server/src/mcp/tools/fact.ts': ['fact'],
  'server/src/mcp/tools/chrono.ts': ['chrono'],
  'server/src/mcp/tools/entity.ts': ['entity'],
  'server/src/mcp/tools/edge.ts': ['edge'],
  // The importer writes every knowledge type there is, which is a statement about the SET rather than
  // about four names — so it is spelled that way.
  'server/src/brain/bulk.ts': [...KNOWLEDGE_TYPES],
};

describe('the table itself', () => {
  it('holds a rule for every field the nine rows named', () => {
    // Asserted as membership rather than as a count: a count of N is satisfied by any N fields, including a
    // duplicate and a missing one.
    for (const [type, fields] of Object.entries({
      fact: ['fact', 'type', 'tags', 'description', 'properties'],
      chrono: ['title', 'startsAt', 'endsAt', 'status', 'confidence', 'tags',
        'description', 'properties'],
      entity: ['name', 'type', 'tags', 'description', 'properties'],
      edge: ['label', 'weight', 'type', 'description', 'tags', 'properties', 'fromKind', 'toKind'],
    })) {
      for (const f of fields) {
        assert.ok(shapedFields(type).includes(f), `${type}.${f} has no shape rule`);
      }
    }
  });

  it('takes the chrono statuses from the one tuple, and nothing writes them out again', () => {
    /*
     * **This case exists because the first version of this table invented them.**
     *
     * The five names were already written out twice — a `Set` in `api/brain/chrono.ts` and an identical one
     * in `brain/bulk.ts` — and the table added a third that had `ongoing` and `unknown` where the product has
     * `active` and `overdue`. Every unit test here passed: they assert that a BAD status is refused, and a
     * wrong list still refuses bad ones. It took a Docker suite asking for `status=overdue` to see it.
     *
     * So the assertion is not "the list is right" — it is that there is only ONE list. A second copy can be
     * wrong; a derived one cannot.
     */
    assert.equal(shapeError('chrono', { status: 'overdue' }), null, 'overdue is a real status');
    assert.equal(shapeError('chrono', { status: 'active' }), null, 'so is active');
    assert.ok(shapeError('chrono', { status: 'ongoing' }), 'ongoing is not, and never was');

    /*
     * **BOTH the pattern and the file list are derived now** (`Q-6`, 2026-09-07).
     *
     * The pattern was the literal `['upcoming', 'active'` — itself a copy of the first two words of the list
     * it exists to keep singular, and one that would stop matching the day the order changes, passing over
     * every copy of the new list. It is built from `CHRONO_STATUSES` instead.
     *
     * The file list named the four modules that had a copy when it was written, while the title claims
     * "nothing writes them out again". A fifth was outside everything it read.
     */
    const written = new RegExp(`\\[\\s*${[...CHRONO_STATUSES].map(v => `'${v}'`).join('\\s*,\\s*')}`);
    const files = trackedSources('server/src')
      .filter(f => f.endsWith('.ts') && f !== 'server/src/config/types.ts');
    assert.ok(files.length > 100, `only ${files.length} server sources found; the listing is broken`);
    const offenders = files.filter(f => written.test(code(f)));
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} writes the chrono statuses out instead of importing CHRONO_STATUSES. A second `
      + 'copy of a five-word list is a copy that can be two words wrong while every test that only asks it to '
      + 'refuse rubbish keeps passing.');
  });

  it('says nothing about a field that is ABSENT', () => {
    // The property that lets an update door use the same table as its create. A PATCH naming one field must
    // not be told about the nine it did not send.
    assert.equal(shapeError('chrono', { title: 'ok' }), null);
    assert.equal(shapeError('chrono', {}), null);
    assert.equal(shapeError('fact', undefined), null);
  });

  it('treats `undefined` as absent and `null` as sent', () => {
    /*
     * `{"description": undefined}` does not survive JSON, so a door seeing it got it from a destructure with
     * no value — that is absence. `null` is a caller having sent something, and it is not a string. Reading
     * them the same way is how a PATCH comes to accept `null` into a field typed as a string.
     */
    assert.equal(shapeError('fact', { description: undefined }), null);
    assert.ok(shapeError('fact', { description: null }));
  });

  it('refuses each of the nine defects by example, not by name', () => {
    // W-14: the chrono PATCH body that answered 200
    assert.ok(shapeError('chrono', { title: 42 }), 'a numeric title');
    assert.ok(shapeError('chrono', { startsAt: { $gte: '2026-01-01' } }), 'a query operator in a date field');
    assert.ok(shapeError('chrono', { tags: 'urgent' }), 'a bare string where an array belongs');
    assert.ok(shapeError('chrono', { description: { note: 'x' } }), 'an object in a description');
    /*
     * W-14's fifth example was `entityIds: 'not-an-array'` — the one that damaged READS, because it broke
     * every `$in` over that field. The field is gone: a connection is an instruction to write link
     * records, `linkEntities` and its siblings, whose shape `write-connections.ts` owns. Refusing it
     * HERE as well would be the second copy this table exists to end, so the claim moved rather than
     * being dropped — see `a-retired-write-field-is-refused-by-name.test.js`.
     */

    // W-15: the cap that only the create doors had
    assert.ok(shapeError('fact', { fact: 'x'.repeat(MAX_FACT_LENGTH + 1) }), 'an oversized fact');
    assert.equal(shapeError('fact', { fact: 'x'.repeat(MAX_FACT_LENGTH) }), null, 'exactly the cap is fine');

    // W-18: blank after trimming, both fields
    assert.ok(shapeError('entity', { name: '   ' }), 'a whitespace-only name');
    assert.ok(shapeError('edge', { label: '   ' }),
      'a whitespace-only label — an edge _id is DERIVED from it, so this re-keys the record');

    // W-19: the type that three doors of four required
    assert.ok(shapeError('entity', { type: '' }), 'an empty entity type selects no schema at all');

    // W-20: the bound both MCP doors had and neither REST door did
    assert.ok(shapeError('edge', { weight: 47 }), 'a weight above 1');
    assert.ok(shapeError('edge', { weight: -1 }), 'and below 0');
    assert.equal(shapeError('edge', { weight: 0.5 }), null);
  });

  it('does NOT widen the property-value rule beyond entities', () => {
    /*
     * `04-brain-api.md` states this carve-out deliberately: only the entity doors refuse a nested property
     * value. Applying it to the other three would refuse writes that work today, which is a product decision
     * and not one a unification gets to take in passing.
     */
    assert.equal(shapeError('fact', { properties: { nested: { a: 1 } } }), null,
      'the memory property rule was widened — that is a breaking change, not a unification');
    assert.equal(shapeError('chrono', { properties: { nested: { a: 1 } } }), null);
    assert.equal(shapeError('edge', { properties: { nested: { a: 1 } } }), null);
    assert.ok(shapeError('entity', { properties: { nested: { a: 1 } } }),
      'and the entity rule that DOES exist has been lost');
    // The container rule still applies to all four — a non-object cannot have its values read.
    for (const t of KNOWLEDGE_TYPES) {
      assert.ok(shapeError(t, { properties: 'not-an-object' }), `${t} accepted a non-object property bag`);
    }
  });

  it('never checks REQUIREDNESS, which stays at the create door', () => {
    // A table that cannot see whether a request is a create must not decide whether a field is required. An
    // empty body is a create problem and never a shape problem.
    for (const t of KNOWLEDGE_TYPES) {
      assert.equal(shapeError(t, {}), null, `${t} refused an empty body — that is requiredness, not shape`);
    }
  });
});

describe('every door reads it', () => {
  it('the module exports what the doors call', () => {
    // The floor. Renamed, every match below would be on a function that no longer exists.
    assert.match(code('server/src/brain/write-shape.ts'), /export function shapeError\(/);
    assert.equal(typeof shapeError, 'function');
  });

  it('each of the nine door files calls it', () => {
    for (const [f, types] of Object.entries(DOORS)) {
      assert.match(code(f), /shapeError\(/,
        `${f} writes ${types.join('/')} and does not check field shapes against the shared table — so its `
        + 'create and its update can disagree about what a value must look like, which is the whole of '
        + 'W-14..W-22');
    }
  });

  it('and the ones with TWO doors call it twice — a create is not an update', () => {
    /*
     * The half that hides. A file calling it once passes the case above while one of its two doors is still
     * unguarded, and it is always the UPDATE that is missing: a create is written carefully and an update is
     * written to be permissive. That is the direction all nine defects ran in.
     */
    for (const f of ['server/src/api/brain/facts.ts', 'server/src/api/brain/chrono.ts',
      'server/src/api/brain/entities.ts', 'server/src/api/brain/edges.ts',
      'server/src/mcp/tools/fact.ts', 'server/src/mcp/tools/chrono.ts',
      'server/src/mcp/tools/entity.ts', 'server/src/mcp/tools/edge.ts']) {
      const calls = (code(f).match(/shapeError\(/g) ?? []).length;
      assert.ok(calls >= 2, `${f} calls shapeError ${calls} time(s) — it has a create door AND an update door`);
    }
  });
});
