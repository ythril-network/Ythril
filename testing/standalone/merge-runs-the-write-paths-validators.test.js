/**
 * The merge path must run the validators the write path runs, and a strict space must REFUSE.
 *
 * Updated 2026-08-29 after the owner ruled B on P-19: the fix shipped as report-and-proceed while the trade was
 * open, and now a `strict` space refuses the merge exactly as it refuses the equivalent direct write. The
 * assertions below gained the refusal rather than being weakened, which is the direction this file predicted.
 *
 *
 * ## Why a merge can produce something no write would accept
 *
 * `mergeProperties` applies each property's `mergeFn`, so the survivor's properties are a value **neither input
 * necessarily had**: a `sum` can exceed a `maximum`, a `concat` can break a `pattern`, a pick can land outside
 * an `enum`. `brain/merge.ts` imported nothing from `spaces/schema-validation.ts`, so a background `automerge`
 * that nobody invoked could write a survivor into a `strict` space that the same space would have refused
 * through `save_entity`.
 *
 * The precedent is exact and one invariant over, from the CHANGELOG: *"An entity merge left every FILE linked to
 * the absorbed entity pointing at a record it had just deleted… The merge path broke the invariant the write
 * path enforces."* Same file, same shape.
 *
 * ## What this pins, and what it deliberately does not
 *
 * It pins that the survivor is **validated and any violation reported**. It does **not** pin that the merge
 * refuses — that is a genuine trade (an automerge that stops leaves the duplicates it exists to resolve) and it
 * is parked as P-19. This codebase has twice concluded that *the fix is visibility, not severity*, for the sync
 * drop and the media-worker swallow, and this follows both.
 *
 * If P-19 is later ruled "refuse", this gate keeps passing and gains an assertion. That is the right direction:
 * it should never have to be weakened.
 *
 * Run: node --test testing/standalone/merge-runs-the-write-paths-validators.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf } from './_structural-window.mjs';

const MERGE = 'server/src/brain/merge.ts';
const merge = stripComments(readFileSync(MERGE, 'utf8'));

describe('the merge path runs the write path validators', () => {
  it('imports the validator at all', () => {
    // The whole defect in one assertion: the file used to reference schema validation nowhere.
    assert.match(
      merge, /from '\.\.\/spaces\/schema-validation\.js'/,
      `${MERGE} does not import the schema validators, so a merged survivor is never checked against the `
      + 'schema its own space enforces on every direct write.',
    );
    assert.match(merge, /validateEntity/, 'validateEntity must be the thing imported — the survivor is an entity');
  });

  it('validates the MERGED values, not the survivor as it was', () => {
    const at = merge.indexOf('validateEntity(');
    assert.notEqual(at, -1, 'no validateEntity call');
    /*
     * The call's OWN ARGUMENTS, not the statement around it.
     *
     * `statementAround` was used first and the mutant walked straight through it: the window reached back over
     * the `embed(entityEmbedText(… mergedTags … mergedProperties))` call above, so swapping the validated
     * values for `survivor.properties` still matched. The words were in the window; they just belonged to a
     * different call.
     */
    const stmt = argumentsOf(merge, at + 'validateEntity'.length, 'the validateEntity arguments').join(' ');
    assert.match(
      stmt, /mergedProperties/,
      'validating `survivor.properties` would check the value that was already accepted on write and miss the '
      + 'entire defect: it is the mergeFn OUTPUT that can violate the schema.',
    );
    /*
     * `mergedTags` is NOT asserted, and its removal is the point rather than an oversight.
     *
     * This used to require it, with the reason "tags are merged too, and a type schema can constrain them".
     * **A type schema cannot.** `TypeSchema` carries `namingPattern`, `propertySchemas`, `retention` and
     * `suppressEmbeddings` — nothing about tags — and the space-wide suggestion list was retired in #365. So
     * the four validators took a `tags` parameter that none of them read, seven callers did work to fill it,
     * and this gate held it in place on a rationale that had never been true.
     *
     * That is the sharper half of the lesson: a gate can preserve a dead parameter as effectively as it
     * preserves a live rule, and its message is the only place the reason is written down. When the reason is
     * wrong, the gate is what stops anyone noticing.
     */
    assert.doesNotMatch(
      stmt, /mergedTags/,
      'the validators no longer take `tags` — nothing in a type schema constrains them, so passing them was '
      + 'work done for a parameter that was read by nothing',
    );
  });

  it('a violation is reported, with enough to find the record', () => {
    const at = merge.indexOf('validateEntity(');
    const after = merge.slice(at);
    assert.match(after, /log\.(warn|error)/, 'a violation that is computed and discarded is the defect with extra steps');
    assert.match(
      after, /violations/,
      'the report must carry the violations themselves — "this merge was invalid" without saying which rule '
      + 'broke sends the operator to read the schema and guess',
    );
  });

  it('a strict space REFUSES, and the refusal is typed', () => {
    // Typed, not a bare Error: `dupe-scanner.ts` runs automerge unattended and has to tell "not allowed" from
    // "broke" without parsing prose. A refusal it cannot distinguish is silent inaction.
    assert.match(
      merge, /applyValidation\(/,
      "the space's own validationMode must decide whether this refuses — a hardcoded 'strict' would refuse in "
      + "spaces that asked only to be warned",
    );
    assert.match(merge, /throw new MergeSchemaViolation/, 'a blocked merge must refuse, not warn and proceed');
    assert.match(
      merge, /class MergeSchemaViolation extends Error/,
      'the refusal must be its own type so a caller can count it',
    );
  });

  it('warn mode still proceeds, and still says so', () => {
    // The middle setting has to keep working: `warn` reports without refusing, which is what it means.
    assert.match(merge, /verdict\.warnings/, 'warn mode must still surface the violations it tolerated');
    assert.match(merge, /log\.(warn|error)/, 'and must still report them');
  });

  it('the automerge caller tells a refusal from a failure', () => {
    const scanner = stripComments(readFileSync('server/src/brain/dupe-scanner.ts', 'utf8'));
    assert.match(
      scanner, /instanceof MergeSchemaViolation/,
      'automerge runs unattended. Reporting a deliberate refusal as "Auto-merge failed" turns the strict '
      + 'ruling into an error nobody investigates.',
    );
  });

  it('the check runs BEFORE the survivor is written', () => {
    const checkAt = merge.indexOf('validateEntity(');
    const writeAt = merge.indexOf('entityColl.updateOne(');
    assert.notEqual(writeAt, -1, 'no survivor write found — re-point this gate');
    assert.ok(
      checkAt < writeAt,
      'validating after the write would report a violation the store already contains. The merge is multi-phase '
      + 'and a late refusal would leave partial state, so the check belongs ahead of the write whether or not '
      + 'P-19 later makes it refuse.',
    );
  });
});
