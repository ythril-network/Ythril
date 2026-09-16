/**
 * A space whose links are all records refuses an array write — from its OWN callers, and from nothing else.
 *
 * ## What the refusal is for
 *
 * The six array fields are the 3.x way of saying one record concerns another. `M-2` replaced them with link
 * records, and a space that has finished converting has a door of its own for writing one. Left open, the
 * arrays are a second write surface for the same fact — and the two can then disagree on a converted space,
 * which is exactly what the migration was for.
 *
 * `completeLinkage` is what arms it. Nothing else may: the marker means *"this space has been converted on
 * this instance"*, which is the only honest precondition for refusing the old way of writing.
 *
 * ## The three things it must NEVER do, each of which breaks something that works
 *
 * **1. It is not `validationMode: strict`.** That switch governs schema rules — type allowlists, required
 * properties, naming patterns — and it is already set on live spaces. Hung off it, every space already on
 * `strict` starts refusing array writes the moment it upgrades, before its operator has run anything. A
 * working caller broken by an upgrade is the one thing a major release is supposed to announce rather than
 * spring.
 *
 * **2. Never on the sync ingest path.** Owner's ruling `P-21`: ingest is *"validated, counted, and let in"* —
 * *"a peer validated these records against ITS schema, and discarding data the sender believes it delivered
 * is not ours to decide."* Mechanically it is worse than a policy mistake: a refusal there holds the
 * watermark, so the channel stops making progress and the space silently falls behind.
 *
 * **3. Never on a write that does not MENTION the array.** A `PATCH` touching a memory's `fact` on a record
 * that still carries a legacy array must succeed, or every unconverted record in a converted space becomes
 * uneditable. This is the `introduced` vs `preExisting` rule the schema validator already has, and the hazard
 * it exists for: tightening a rule freezes the records that no longer fit it.
 *
 * Run: node --test testing/standalone/a-converted-space-refuses-an-array-write.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const { arrayWriteError, LINK_ARRAY_FIELDS } =
  await import('../../server/dist/brain/array-write-refusal.js');

const code = (f) => stripComments(readFileSync(f, 'utf8'));

/**
 * Every door that accepts one of the six arrays from a caller.
 *
 * Named individually rather than swept, because "accepts an array" is not greppable: `update_chrono` writes
 * through a computed key and the bulk items are validated by a helper. A derived list would miss the two
 * that matter, which is the same reason the writer-coverage gate names its five.
 */
const DOORS = {
  'server/src/api/brain/facts.ts': 'POST and PATCH — `fact.entityIds`',
  'server/src/api/brain/chrono.ts': 'POST and PATCH — `chrono.entityIds` and `chrono.memoryIds`',
  'server/src/api/brain/file-meta.ts': "PATCH — a file's three arrays",
  'server/src/mcp/tools/fact.ts': 'save_fact and update_fact',
  'server/src/mcp/tools/chrono.ts': 'create_chrono and update_chrono',
  'server/src/mcp/tools/file.ts': 'update_file_meta',
  'server/src/brain/bulk.ts': 'the batch importer, which validates its own items',
};

describe('the refusal itself', () => {
  it('names the six fields, and they are the six', () => {
    // Derived from the link classes rather than written out — the seventh class added later must be refused
    // by the commit that declares it, not by a list somebody remembers to extend.
    assert.deepEqual([...LINK_ARRAY_FIELDS].sort(), ['chronoIds', 'entityIds', 'memoryIds']);
  });

  it('says nothing about a body that mentions no array', () => {
    assert.equal(arrayWriteError({ converted: true, spaceId: 'sp', body: { fact: 'a revised fact' }, actor: undefined }), null,
      'a PATCH that does not mention an array must succeed on a converted space, or every record still '
      + 'carrying a legacy array becomes uneditable');
    assert.equal(arrayWriteError({ converted: true, spaceId: 'sp', body: {}, actor: undefined }), null);
    assert.equal(arrayWriteError({ converted: true, spaceId: 'sp', body: undefined, actor: undefined }), null);
  });

  it('refuses a body that mentions one, and names the door to use instead', () => {
    const err = arrayWriteError({ converted: true, spaceId: 'sp', body: { fact: 'x', entityIds: ['a'] }, actor: undefined });
    assert.ok(err, 'a converted space accepted an array write');
    assert.match(err, /entityIds/, 'the refusal must say WHICH field');
    assert.match(err, /links/i, 'and point at the door that replaces it — a refusal with no alternative is a wall');
  });

  it('refuses an EMPTY array too, because that is a write as well', () => {
    /*
     * `entityIds: []` means "remove every entity link", which is a change and has to go through the door
     * like any other. Treating an empty array as "no array mentioned" is the tempting shortcut and it leaves
     * exactly one way to clear links behind the old surface.
     */
    assert.ok(arrayWriteError({ converted: true, spaceId: 'sp', body: { entityIds: [] }, actor: undefined }), 'an empty array is a removal, not an absence');
  });

  it('refuses a NULL as well — it is the other spelling of the same removal', () => {
    assert.ok(arrayWriteError({ converted: true, spaceId: 'sp', body: { memoryIds: null }, actor: undefined }));
  });

  it('says nothing at all when the space has not converted', () => {
    // The whole point. An unconverted space has no door to redirect to for records written before the
    // upgrade, and its arrays are still the complete answer.
    for (const body of [{ entityIds: ['a'] }, { memoryIds: [] }, { chronoIds: null }]) {
      assert.equal(arrayWriteError({ converted: false, spaceId: 'sp', body: body, actor: undefined }), null, `refused ${JSON.stringify(body)} on an unconverted space`);
    }
  });
});

describe('every door consults it, and the ingest path never does', () => {
  it('the module exports what the doors call', () => {
    // Floors the sweep below: renamed, every match would be on a function that no longer exists.
    const src = code('server/src/brain/array-write-refusal.js'.replace('.js', '.ts'));
    assert.match(src, /export function arrayWriteError\(/);
    assert.match(src, /export const LINK_ARRAY_FIELDS/);
  });

  it('each door calls it', () => {
    for (const [f, why] of Object.entries(DOORS)) {
      assert.match(code(f), /arrayWriteError\(/,
        `${f} accepts one of the six arrays and never refuses it on a converted space — ${why}`);
    }
  });

  it('the SYNC INGEST path does not, and that is the ruling not an oversight', () => {
    /*
     * `P-21`, verbatim: "validated, counted, and let in". Asserted as an ABSENCE because the tempting change
     * is to add it — the ingest router looks like a write door and is not one, and the failure it would
     * cause is not a refused record but a HELD WATERMARK: a 400 on a batch stops the channel, and the space
     * quietly stops receiving anything at all.
     */
    for (const f of ['server/src/api/sync/_shared.ts', 'server/src/api/sync/docs.ts', 'server/src/sync/engine.ts']) {
      assert.doesNotMatch(code(f), /arrayWriteError\(/,
        `${f} refuses an arriving record's array. Sync ingest is "validated, counted, and let in" — a `
        + 'refusal there holds the watermark and the channel stops making progress.');
    }
  });

  it('and the refusal is armed by completeLinkage ALONE, never by validationMode', () => {
    /*
     * The trap this is here for: `validationMode: 'strict'` is already set on live spaces, so arming the
     * refusal from it would break every one of them on upgrade — before the operator has run anything, and
     * with no way to tell that the upgrade is what did it.
     */
    const src = code('server/src/brain/array-write-refusal.ts');
    assert.doesNotMatch(src, /validationMode/,
      'the array refusal reads validationMode. Spaces already on `strict` would start refusing array writes '
      + 'the moment they upgrade — a working caller broken by a release rather than by a decision.');
    assert.doesNotMatch(src, /strictLinkage/,
      'the array refusal reads strictLinkage, which says every reference must RESOLVE — a different question '
      + 'from whether every link IS a record');
  });
});

describe('the deprecation is announced', () => {
  const DEPRECATIONS = 'todo/_DEPRECATIONS.md';

  it('the six fields have a row, and it names the delete behaviour as well as the fields', () => {
    /*
     * The half that gets left out. The fields being deprecated is a fact about an API surface; the scan that
     * refuses a delete now seeing three more classes is a BEHAVIOUR CHANGE a running script can hit — a
     * memory a chrono entry names stops being deletable. A notice that lists only the fields leaves the
     * caller to discover the second half as a 409 in production.
     */
    let row;
    try {
      row = readFileSync(DEPRECATIONS, 'utf8');
    } catch {
      // The tracker is gitignored, so CI does not have it. Locally it must be right.
      return;
    }
    assert.match(row, /entityIds/, 'the six array fields need a deprecation row');
    assert.match(row, /delete/i, 'the row must announce the delete-blocking change, not only the fields');
  });
});
