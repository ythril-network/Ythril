/**
 * A schema pattern the instance will not RUN must be refused when the schema is saved — never stored and then
 * reported as though the data were wrong.
 *
 * ## The bug this locks down (`Q-7`, owner: *"this is a bug… a 4.0.1 thing"*)
 *
 * `safeRegexTest` refuses to evaluate a pattern that trips `hasReDoSRisk` — a quantified group containing a
 * quantifier — and **returns `false`**, which is the same answer it gives for a value that genuinely does not
 * match. So a perfectly ordinary pattern:
 *
 * ```text
 * ^D[0-9]+:[0-9]+(,D[0-9]+:[0-9]+)*$
 * ```
 *
 * is accepted when the schema is saved, and then rejects **every** record of that type, for ever, with
 * `properties.turn … does not match pattern`. The operator inspects their data. Nothing anywhere says the
 * pattern was never applied.
 *
 * Three things make it worse than a bad error message: it is total rather than intermittent, the message
 * points away from the cause, and `(…)*` is simply how anyone writes "a list of these" — this is not an
 * exotic regex being caught by a safety net.
 *
 * ## What is NOT the fix
 *
 * Loosening `hasReDoSRisk`. It exists so a stored schema cannot hang the server on a hostile value, and it is
 * doing that job. The defect is that a refusal to evaluate is indistinguishable from an evaluation that
 * failed — so the refusal moves to save time, where the author is standing, and what remains at write time
 * says which of the two happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PropertySchemaZ, TypeSchemaZ } from '../../server/dist/spaces/body-schemas.js';
import { validateFact, validateEntity } from '../../server/dist/spaces/schema-validation.js';

/** The pattern that started this: one or more `D<session>:<turn>` ids, comma-joined. */
const REPEATED_GROUP = '^D[0-9]+:[0-9]+(,D[0-9]+:[0-9]+)*$';

/** An alternation under a quantifier — the heuristic's other arm. */
const ALTERNATION = '^(cat|dog)+$';

/** Group-free, and therefore evaluable. Kept as the control: the refusal must not swallow ordinary patterns. */
const SAFE = '^D[0-9]+:[0-9,:D]*$';

test('a property pattern too risky to evaluate is refused when the schema is saved', () => {
  for (const pattern of [REPEATED_GROUP, ALTERNATION]) {
    const result = PropertySchemaZ.safeParse({ type: 'string', pattern });
    assert.equal(result.success, false,
      `the pattern ${pattern} was ACCEPTED. It will never be evaluated, so every record of this type is `
      + 'rejected with an error naming the value — the operator is told their data is wrong when their '
      + 'schema was silently never applied.');
    const message = JSON.stringify(result.error?.issues ?? []);
    assert.match(message, /redos|too complex|cannot be evaluated|unsafe/i,
      `the refusal must say WHY, and name the real reason. Got: ${message}`);
  }
});

test('an entity naming pattern is refused on the same rule', () => {
  // The same hazard on a different field. A gate that checked only `propertySchemas.pattern` would conclude
  // about "patterns" while covering one of the two places a pattern can be written.
  const result = TypeSchemaZ.safeParse({ namingPattern: REPEATED_GROUP });
  assert.equal(result.success, false,
    'a namingPattern that cannot be evaluated was accepted; every entity of that type would then be refused');
});

test('an ordinary pattern is still accepted', () => {
  /*
   * The control, and it is the assertion that stops the fix being "reject everything". A refusal that also
   * refuses valid patterns is a worse bug than the one being fixed, and it would pass every test above.
   */
  const ok = PropertySchemaZ.safeParse({ type: 'string', pattern: SAFE });
  assert.equal(ok.success, true, `the safe pattern ${SAFE} must still be accepted: ${JSON.stringify(ok.error?.issues)}`);

  const naming = TypeSchemaZ.safeParse({ namingPattern: '^[a-z]{4,}$' });
  assert.equal(naming.success, true, 'an ordinary naming pattern must still be accepted');
});

test('a stored risky pattern says it was not evaluated, rather than blaming the value', () => {
  /*
   * Schemas saved before the refusal existed are still on disk, so the write path has to stay honest about
   * them. The record here is CORRECT — it matches the pattern — and the only reason it is rejected is that
   * the pattern cannot be run. The violation has to say so.
   */
  const meta = {
    validationMode: 'strict',
    typeSchemas: { fact: { utterance: { propertySchemas: { turn: { type: 'string', pattern: REPEATED_GROUP } } } } },
  };
  // `(meta, record)`, in that order — the arguments the other way round returns an empty list, which reads
  // exactly like "the schema is satisfied".
  const violations = validateFact(meta, { type: 'utterance', properties: { turn: 'D1:1,D1:2' } });

  assert.equal(violations.length, 1, `expected exactly one violation, got ${JSON.stringify(violations)}`);
  assert.match(violations[0].reason, /not evaluated|not applied|refused|unsafe|redos/i,
    `the reason must say the PATTERN was not run. It currently reads "${violations[0].reason}", which sends `
    + 'the operator to inspect a value that is in fact correct.');
});

test('a stored risky NAMING pattern says the same thing, on the other code path', () => {
  /*
   * The second place a pattern is run, and the reason this test exists at all.
   *
   * The fix went into `validateValue` first and this site would have kept reporting a declined pattern as
   * "does not match naming pattern" — one rule, two implementations, and the weaker one wins silently for
   * whichever collection happens to use it. The entity name here MATCHES the pattern, so a violation can
   * only come from the pattern being declined.
   */
  const meta = {
    validationMode: 'strict',
    typeSchemas: { entity: { thing: { namingPattern: ALTERNATION } } },
  };
  const violations = validateEntity(meta, { name: 'cat', type: 'thing' });

  assert.equal(violations.length, 1, `expected exactly one violation, got ${JSON.stringify(violations)}`);
  assert.match(violations[0].reason, /not evaluated/i,
    `the naming-pattern path must say the pattern was not run. It reads "${violations[0].reason}".`);
});
