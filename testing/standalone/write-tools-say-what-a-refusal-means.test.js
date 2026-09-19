/**
 * A write tool's schema says what a validation refusal MEANS, and which half is the caller's fault.
 *
 * ## Why this is the write tools' version of the X-2 gap
 *
 * The read tools were missing their response shape. The write tools are missing their REFUSAL shape, which is
 * worse: a refusal is the only response a caller has to branch on, and `introduced` versus `preExisting` is
 * the branch. Nothing said so.
 *
 * It changed underneath callers this release, too. Until #920 both halves refused the write; now a violation
 * the record already carried is REPORTED and does not block, so an unrelated edit is never stopped by a field
 * somebody else broke. A caller that treats any `violations` array as failure is now wrong in a new way —
 * it will report a successful write as an error.
 *
 * ## The other two facts a write tool must state
 *
 * **What the write DOES to an existing record.** `save_entity` merges and validates the merged form, which
 * is why a partial upsert of a conformant record is accepted when the fragment alone would fail. `saveFact`
 * is always an insert and deduplicates nothing, so the same fact stored twice competes with itself in recall.
 *
 * **That embedding is asynchronous.** The write returns before the vector exists, so a recall seconds later
 * can miss it — and `includeFreshWrites` is the escape hatch. This one is measurable as a broken feature: a
 * probe that writes and immediately searches finds nothing and concludes search is down.
 *
 * Run: node --test testing/standalone/write-tools-say-what-a-refusal-means.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toolText = (file, name) => {
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} was not found in ${file} — the scanner is wrong, not the code`);
  const next = src.indexOf("name: '", at + 20);
  return next === -1 ? src.slice(at) : src.slice(at, next);
};

const UPSERT_ENTITY = toolText('server/src/mcp/tools/entity.ts', 'save_entity');
const REMEMBER = toolText('server/src/mcp/tools/fact.ts', 'save_fact');
const UPSERT_EDGE = toolText('server/src/mcp/tools/edge.ts', 'save_edge');
const CREATE_CHRONO = toolText('server/src/mcp/tools/chrono.ts', 'save_chrono');

describe('every write tool explains the refusal shape', () => {
  // Applied across the family rather than per tool: the refusal shape is identical on all four, so one of
  // them documenting it and three not is the drift this loop exists to prevent.
  for (const [label, text] of [
    ['save_entity', UPSERT_ENTITY], ['save_fact', REMEMBER],
    ['save_edge', UPSERT_EDGE], ['save_chrono', CREATE_CHRONO],
  ]) {
    it(`${label} names introduced vs preExisting and says which one refuses`, () => {
      assert.match(text, /introduced/, 'name the half that is the caller\'s fault');
      assert.match(text, /preExisting/, 'name the half that is not');
      assert.match(text, /do NOT block|does NOT block|do NOT refuse/i,
        'say that a pre-existing violation is reported rather than refusing — it changed this release');
      assert.match(text, /Branch on `introduced`/,
        'tell the caller which field to branch on, or the distinction is decoration');
    });
  }
});

describe('each says what its write does to what is already there', () => {
  it('upsert_entity: it merges, and validates the MERGED form', () => {
    // The reason a partial upsert of a conformant record is accepted when the fragment alone would fail.
    assert.match(UPSERT_ENTITY, /MERGES/, 'say that an upsert onto an existing record merges');
    assert.match(UPSERT_ENTITY, /MERGED form/,
      'and that validation runs on the result, not on the fragment');
  });

  it('upsert_entity: omitting id always INSERTS, and names deduplicate nothing', () => {
    assert.match(UPSERT_ENTITY, /Two entities may share a name/,
      'the obvious wrong assumption is that a name is an identity');
    // The tool it used to point at was removed at 5.0, and this assertion kept passing because the
    // description still named it. Pinned to the LIVE answer now — searching `entities` by name with
    // `filter` — so the case fails if the pointer rots again rather than preserving the rot.
    assert.match(UPSERT_ENTITY, /`filter`/, 'point at the tool that answers it');
    assert.match(UPSERT_ENTITY, /`entities` collection/, 'and at the collection to search');
  });

  it('remember: an insert WITHOUT an id, convergence with one, and duplicates compete', () => {
    // This assertion used to require the bare phrase `Always an INSERT`, and its own failure message said
    // "there is no id to update" — repeating the claim it was pinning. Both were wrong: `saveFact` takes an
    // optional `id`, and a supplied one that already names a record CONVERGES rather than duplicating,
    // which is the retry-safety contract. A gate written from a description does not catch a wrong
    // description; it cements it. `remember-describes-its-idempotent-path.test.js` holds the prose to the
    // code, and this one now asserts the RULE rather than a sentence.
    assert.match(REMEMBER, /insert/i, 'the no-id case still inserts');
    assert.match(REMEMBER, /converge/i, 'and an id that names a record converges instead of duplicating');
    assert.doesNotMatch(REMEMBER, /there is no id to update/i, 'the claim that was false');
    assert.match(REMEMBER, /compete for the same result slots/,
      'the cost of a duplicate is not storage, it is recall quality');
  });
});

describe('upsert_edge: identity is the triplet, and direction is meaning', () => {
  it('says every repeat of the same triplet is an UPDATE', () => {
    // There is no id in the call, so nothing in the arguments hints that a repeat merges. This is the same
    // shape that made a partial upsert fail validation before the merged form was validated.
    assert.match(UPSERT_EDGE, /IDENTITY IS THE TRIPLET/, 'the triplet IS the id');
    assert.match(UPSERT_EDGE, /nothing in the arguments suggests it/,
      'say that the call gives no hint — that is why it surprises people');
  });

  it('says direction is not interchangeable', () => {
    assert.match(UPSERT_EDGE, /not interchangeable/, 'from/to reversed is a different claim');
    assert.match(UPSERT_EDGE, /unreachable from the side that should have found it/,
      'a reversed edge is not untidy, it is missing from a traversal');
  });

  it('warns that an edge is a searchable record', () => {
    assert.match(UPSERT_EDGE, /competes with knowledge/,
      'edges take result slots in recall, which is why recall has a types filter');
  });
});

describe('create_chrono: what belongs here rather than in a memory', () => {
  it('says a custom chrono schema REPLACES the defaults', () => {
    // The trap: a space that declares its own chrono types stops accepting `event`, and the refusal reads
    // like a bug unless you know the list is a replacement rather than an extension.
    assert.match(CREATE_CHRONO, /INSTEAD, not in addition/,
      'a custom schema replaces the default type names, it does not add to them');
  });

  it('says what makes something a chrono entry rather than a memory', () => {
    assert.match(CREATE_CHRONO, /whose truth expires/,
      'a dated fact stored as a memory cannot be closed, only contradicted');
    assert.match(CREATE_CHRONO, /If it has a date, it belongs here/, 'give the caller the rule, not a hint');
  });

  it('says entityIds are what make it reachable from the entity', () => {
    assert.match(CREATE_CHRONO, /NOT edges/,
      'the reference is not an edge, which is why only the traverse TOOL reaches it');
    assert.match(CREATE_CHRONO, /never from the thing it concerns/,
      'an unlinked chrono entry is findable by search and date only — say the cost of forgetting');
  });
});

describe('remember says the embedding is asynchronous', () => {
  it('warns that a recall seconds later can miss the write', () => {
    // Measurable as a broken feature: write, search, find nothing, conclude search is down.
    assert.match(REMEMBER, /ASYNCHRONOUS/, 'the write returns before the vector exists');
    /*
     * Say what covers the delay and what does not — knowing about it without the remedy is half an answer.
     *
     * This asserted the literal `includeFreshWrites: true`, which was the remedy until 5.0. The scan runs
     * on every recall now, so the remedy is "nothing, it is handled" — and the half that ISN'T handled
     * became the thing worth naming: a record whose embedding job has not run has no vector to compare.
     */
    assert.match(REMEMBER, /scans the newest records straight from the collection/,
      'say that recall covers the index-lag half of the delay');
    assert.match(REMEMBER, /list_embed_jobs/,
      'name what does NOT cover it — a record still queued for embedding — and where to see that queue');
  });

  it('tells the caller to write a self-contained sentence', () => {
    // An embedding of "he agreed to the change" is unusable, and the failure only appears months later.
    assert.match(REMEMBER, /carries its own context/,
      'a memory is retrieved without the conversation it was written in');
  });
});
