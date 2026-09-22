/**
 * A record and the links it needs are ONE write, and the field says so in its name.
 *
 * ## The report (`F-27`)
 *
 * A fleet operator, 2026-09-06, on why they have not converted to link records: every write door takes a
 * reference at create time today, and after conversion those fields are refused — so attaching a record to
 * three things becomes four calls, and `save_bulk`'s reason for existing is undone on a converted space.
 *
 * **They are not asking to keep the arrays.** *"If links become the only truth and the arrays are deleted,
 * that is cleaner than carrying two things that must be kept in step forever."* The single call is what has
 * to survive.
 *
 * ## What these cases pin, and why each is a decision rather than a detail
 *
 *  - **The names are derived from the kind vocabulary**, so a fifth kind gets its field on the day it is
 *    declared. A hand-written map of four is the defect the rest of this suite spent a week removing.
 *  - **Absent is not empty.** `desiredLinksFrom` returns `null` for a body that mentions no link field, and
 *    `{ entity: [] }` for one that writes an empty array. Those mean "leave the links alone" and "detach
 *    every entity", and a mapper that collapsed them would make every partial update destructive.
 *  - **`null` is the caller writing "none".** JSON has no `undefined`, so a client clearing a field sends
 *    `null`, and reading that as a shape error refuses the one spelling of "remove these" that a generated
 *    client will produce.
 *  - **A bare string is refused rather than read as one id.** `"abc"` treated as a single reference is how a
 *    filter silently matches nothing.
 *
 * Run: node --test testing/standalone/one-call-creates-a-record-and-its-links.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { LINK_INPUT_FIELDS, LINK_INPUT_NAMES, desiredLinksFrom, linkInputError, linkInputSchemas, edgeInputsFrom, edgeInputError, edgeInputSchema } =
  await import('../../server/dist/brain/write-connections.js');
const { REF_KINDS } = await import('../../server/dist/config/types-knowledge.js');

const UUID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

describe('the field names come from the kind vocabulary', () => {
  it('there is exactly one field per kind, and no kind without one', () => {
    assert.deepEqual(Object.keys(LINK_INPUT_FIELDS).sort(), [...REF_KINDS].sort());
    assert.equal(new Set(LINK_INPUT_NAMES).size, LINK_INPUT_NAMES.length, 'two kinds share a field name');
  });

  it('and they read as VERBS, which is the whole point of the rename', () => {
    /*
     * `entityIds` reads as *store this value*, which is what it did for all of 3.x. The same name after
     * conversion would mean *go and create these links* — a field named like a property and behaving like an
     * instruction reads correctly and is understood wrongly.
     */
    for (const name of LINK_INPUT_NAMES) {
      assert.match(name, /^link[A-Z]/, `${name} does not read as an instruction`);
      assert.doesNotMatch(name, /Ids$/, `${name} is the noun spelling this rename exists to leave behind`);
    }
    assert.equal(LINK_INPUT_FIELDS.entity, 'linkEntities');
    assert.equal(LINK_INPUT_FIELDS.chrono, 'linkChronos', 'the y-plural must not become `linkChronoies`');
  });
});

describe('absent, empty and null are three different things', () => {
  it('a body naming no link field says nothing about links', () => {
    // NOT `{}`. An empty object and `{ entity: [] }` are the same value to the writer, and they mean
    // opposite things — so a partial update that mentions no links must not reach it at all.
    assert.equal(desiredLinksFrom({ fact: 'x' }), null);
    assert.equal(desiredLinksFrom(undefined), null);
    assert.equal(desiredLinksFrom('nonsense'), null);
  });

  it('an empty array detaches that kind, and leaves the others alone', () => {
    const desired = desiredLinksFrom({ linkEntities: [] });
    assert.deepEqual(desired, { entity: [] });
    assert.ok(!('fact' in desired), 'a kind the caller did not name must not appear');
  });

  it('null is the caller writing "none", because JSON has no undefined', () => {
    assert.deepEqual(desiredLinksFrom({ linkFacts: null }), { fact: [] });
    assert.equal(linkInputError({ linkFacts: null }), null, 'null is a value, not a shape error');
  });

  it('several kinds in one call, which is the point of the feature', () => {
    const desired = desiredLinksFrom({ linkEntities: [UUID], linkChronos: [OTHER] });
    assert.deepEqual(desired, { entity: [UUID], chrono: [OTHER] });
  });
});

describe('what it refuses', () => {
  it('a bare string, rather than reading it as one id', () => {
    assert.match(linkInputError({ linkEntities: UUID }), /must be an array/);
  });

  it('an entry that is not a well-formed reference for its kind, NAMING the value', () => {
    /*
     * The message comes from `entity-refs.ts` now, and that is the point of the change: this returned
     * "linkEntities must contain UUIDs" while the writer's own refusal named the offending value. Two
     * messages for one rule, and the weaker one won because the door runs first — so a caller who sent a
     * NAME was told the shape was wrong and not which of their ids was the name.
     */
    const bad = linkInputError({ linkEntities: ['not-a-uuid'] });
    assert.match(bad, /UUID v4/);
    assert.match(bad, /not-a-uuid/, 'the refusal must name the value, or a caller with twenty ids cannot act on it');
    assert.match(linkInputError({ linkEntities: [''] }), /non-empty/);
    assert.match(linkInputError({ linkEntities: [42] }), /non-empty/);
  });

  it('and NOT the well-formedness when the space accepts dangling references', () => {
    /*
     * `strictLinkage: false` is a deliberate per-space choice for a staged import whose targets resolve
     * in a later pass, and the 4.x arrays honoured it here too — a lax space stored
     * `entityIds: ['created-later']` on purpose. The SHAPE is still checked: an array of non-empty
     * strings is what the field IS, whatever the space says about resolution.
     */
    assert.equal(linkInputError({ linkEntities: ['created-later'] }, { strict: false }), null);
    assert.match(linkInputError({ linkEntities: [''] }, { strict: false }), /non-empty/);
    assert.match(linkInputError({ linkEntities: 'nope' }, { strict: false }), /must be an array/);
  });

  it('a file reference is a PATH, and a UUID there is refused', () => {
    // The hazard `save_link` names: the same UUID can name records in two collections, so a file field
    // holding one is a link that reads as correct and points at nothing.
    assert.equal(linkInputError({ linkFiles: ['notes/report.md'] }), null);
    assert.match(linkInputError({ linkFiles: ['../secrets/keys.txt'] }), /space-relative/);
  });

  it('and says nothing about a body that names no link field', () => {
    assert.equal(linkInputError({ fact: 'x' }), null);
    assert.equal(linkInputError(undefined), null);
  });

  it('the message names the FIELD the caller sent, not the kind', () => {
    // A refusal saying "entity" when they wrote `linkEntities` makes them look for a field they did not use.
    assert.match(linkInputError({ linkChronos: ['nope'] }), /linkChronos/);
  });
});

describe('both doors are built from the same map', () => {
  it('the MCP tool declares every field the REST door reads', () => {
    /*
     * A tool schema is `additionalProperties: false` and the dispatcher enforces it BEFORE the handler
     * runs, so a field declared on one door and not the other is refused outright while the other accepts
     * it. `traverse`'s three link flags shipped exactly that way, and this is the structural version of not
     * repeating it: one builder, both surfaces.
     */
    const props = Object.keys(linkInputSchemas());
    assert.deepEqual(props.sort(), [...LINK_INPUT_NAMES].sort());
  });

  it('and every description states the REPLACE rule, because a caller cannot infer it', () => {
    // The operator asked for this in as many words, having been caught by tags that union-merge and can
    // never be removed. A description that leaves it out is how they get caught again.
    for (const [field, schema] of Object.entries(linkInputSchemas())) {
      assert.match(schema.description, /REPLACES/, `${field} does not say what an update does`);
      assert.match(schema.description, /omitting/i, `${field} does not say what omitting it does`);
    }
  });

  it('the file field says PATH, and the others say UUID', () => {
    const schemas = linkInputSchemas();
    assert.match(schemas[LINK_INPUT_FIELDS.file].description, /PATH/);
    assert.match(schemas[LINK_INPUT_FIELDS.entity].description, /UUID/);
  });
});

describe('and the LABELLED half, which links deliberately cannot carry', () => {
  /*
   * The operator drew this line and it is the right one: a link is unlabelled and its direction follows from
   * the kinds at its ends, so a bare UUID is complete. An edge carries a label, a direction that is data, and
   * optionally properties — `posted_by` and `addressed_to` from the same post to two parties are two facts,
   * and no array of UUIDs can say which is which.
   */
  it('needs a label and a target, and says which is missing', () => {
    assert.match(edgeInputError({ edges: [{ to: UUID }] }), /label is required/);
    assert.match(edgeInputError({ edges: [{ label: 'owns' }] }), /to is required/);
    assert.match(edgeInputError({ edges: ['nope'] }), /must be an object/);
    assert.match(edgeInputError({ edges: 'nope' }), /must be an array/);
  });

  it('the message names WHICH entry, because a batch of ten needs the index', () => {
    assert.match(edgeInputError({ edges: [{ to: UUID, label: 'ok' }, { to: UUID }] }), /edges\[1\]/);
  });

  it('a file end takes a path, and an entity end refuses one', () => {
    assert.equal(edgeInputError({ edges: [{ to: 'notes/a.md', label: 'about', toKind: 'file' }] }), null);
    assert.match(edgeInputError({ edges: [{ to: 'not-a-uuid', label: 'about' }] }), /UUID/);
    assert.match(edgeInputError({ edges: [{ to: '../secrets/keys.txt', label: 'x', toKind: 'file' }] }), /path/);
  });

  it('and a UUID sent as a FILE path is not a shape error, which is the honest limit here', () => {
    /*
     * A UUID is a legal filename, so no amount of shape checking distinguishes "the path of a file" from
     * "an entity id somebody put in the wrong field". That is precisely the hazard the operator names for
     * `save_link`: the same UUID can address records in two collections, and a wrong guess stores a
     * relationship that reads as correct and points at nothing.
     *
     * Only EXISTENCE separates them, and that is `assertRefsResolve` at the writer — which is why this
     * module deliberately does not attempt it here. Asserted rather than left implicit, so the next reader
     * does not "fix" this by adding a rule that cannot work.
     */
    assert.equal(edgeInputError({ edges: [{ to: UUID, label: 'about', toKind: 'file' }] }), null);
  });

  it('refuses a weight outside 0-1 and a non-primitive property', () => {
    assert.match(edgeInputError({ edges: [{ to: UUID, label: 'x', weight: 2 }] }), /between 0 and 1/);
    assert.match(edgeInputError({ edges: [{ to: UUID, label: 'x', properties: { a: { b: 1 } } }] }), /properties/);
  });

  it('absent is not empty here either', () => {
    assert.equal(edgeInputsFrom({ fact: 'x' }), null);
    assert.deepEqual(edgeInputsFrom({ edges: [] }), []);
  });

  it('the schema says these UPSERT, and says links do the opposite', () => {
    // The two fields disagree on purpose, and a caller cannot infer which is which. An edge carries a label,
    // properties and possibly another author, so clearing the set would delete work nobody asked to delete.
    const desc = edgeInputSchema().description;
    assert.match(desc, /UPSERT/);
    assert.match(desc, /do not replace/);
    assert.match(desc, /linkEntities/, 'the contrast with the replacing field has to be stated here');
    assert.match(desc, /ALREADY EXIST/, 'a caller must be told this cannot connect two records it creates');
  });

  it('and points at save_bulk for the case it does NOT cover', () => {
    // Creating a post and three labelled relationships to records the same call mints is the correlation
    // key, and it lives in `save_bulk`. Saying so here is what stops a caller trying it and failing.
    assert.match(edgeInputSchema().description, /save_bulk/);
  });
});
