/**
 * A write carrying a 4.x link array is REFUSED, on both doors, with the new spelling in the message.
 *
 * ## The failure this pins, and it is a 200
 *
 * 5.0 removed `entityIds`, `memoryIds` and `chronoIds` from every write door. Removing an input name is not
 * the same as refusing it: a REST body carrying one would be folded into `warnings` and the record written
 * WITHOUT the connections it asked for, and an MCP call would be told *"unexpected property 'entityIds'"*.
 * The first is a success the caller has no reason to re-read; the second is true and useless. Either way an
 * upgrading integrator finds out weeks later, as a traversal that comes back empty.
 *
 * So the rule is not "the field is gone". It is: **a retired name is answered by the name that replaced
 * it**, and both doors answer with the same sentence.
 *
 * ## Why the doors are checked separately, and neither is trusted to speak for the other
 *
 * They refuse through different mechanisms and that is legitimate: REST asks `connectionInputError`, which
 * every write door already calls, while MCP never reaches a handler at all — the dispatcher enforces
 * `additionalProperties: false` from the published schema first. Two mechanisms, one text, which is the
 * only arrangement that survives a caller moving between clients.
 *
 * ## What is derived
 *
 * The retired names come from the module that declares them, and the replacement each one names is read out
 * of the message rather than written here a second time. A fourth retirement is covered on the day it is
 * added; a message that stops naming its replacement fails here even though the refusal still happens.
 *
 * Run: node --test testing/standalone/a-retired-write-field-is-refused-by-name.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let RETIRED, retiredWriteFieldError, retiredWriteFieldHint, connectionInputError, LINK_INPUT_NAMES, validateArgsSrc;

before(async () => {
  ({ RETIRED_WRITE_FIELDS: RETIRED, retiredWriteFieldError, retiredWriteFieldHint } =
    await import('../../server/dist/brain/retired-write-fields.js'));
  ({ connectionInputError, LINK_INPUT_NAMES } =
    await import('../../server/dist/brain/write-connections.js'));
  const { readFileSync } = await import('node:fs');
  validateArgsSrc = readFileSync('server/src/mcp/validate-args.ts', 'utf8');
});

describe('a retired write field is refused by name', () => {
  it('the derivation finds the retired names before anything is concluded about them', () => {
    // A gate over an empty set passes every loop written under it. The six arrays retired as three input
    // names — a chrono entry and a file both said `entityIds` — so three is the floor.
    assert.ok(Object.keys(RETIRED).length >= 3,
      `only ${Object.keys(RETIRED).length} retired field(s) — the import is stale and this checks nothing`);
    for (const name of ['entityIds', 'memoryIds', 'chronoIds']) {
      assert.ok(name in RETIRED, `${name} is not declared retired, so a write carrying it is not refused`);
    }
  });

  it('every retired name is refused, and names a field a caller can actually send', () => {
    for (const name of Object.keys(RETIRED)) {
      const err = retiredWriteFieldError({ [name]: ['aaaaaaaa-0000-4000-8000-000000000001'] });
      assert.ok(err, `${name} was accepted — the links a caller asked for would be silently dropped`);
      assert.ok(err.includes(name), `the refusal for ${name} does not name the field the caller sent`);
      /*
       * The half that makes the refusal worth having. "This field is gone" sends the reader back to the
       * guide they were reading when they wrote it; the replacement has to be IN the sentence, and it has
       * to be a name the doors actually accept rather than a plausible one.
       */
      const named = LINK_INPUT_NAMES.filter(f => err.includes(f));
      assert.equal(named.length, 1,
        `the refusal for ${name} names ${named.length} replacement fields; it must name exactly the one to send`);
    }
  });

  it('an empty value is refused too, because a present key is a write', () => {
    // `entityIds: []` means "detach everything" to the caller who sent it. Accepting it as "said nothing"
    // is the silent version of the same loss, on the call that was trying to REMOVE links.
    for (const value of [[], null, undefined]) {
      assert.ok(retiredWriteFieldError({ entityIds: value }),
        `entityIds: ${JSON.stringify(value) ?? 'undefined'} was accepted — a present key is a write`);
    }
  });

  it('a body that names none of them is untouched', () => {
    assert.equal(retiredWriteFieldError({ fact: 'hello', linkEntities: [] }), null);
    assert.equal(retiredWriteFieldError(undefined), null);
    assert.equal(retiredWriteFieldError('not an object'), null);
  });

  it('the REST doors ask through the check they already call', () => {
    /*
     * `connectionInputError` is the one call every write door makes about relationships, so folding the
     * retired names into it is what makes this un-skippable rather than remembered per door. A separate
     * exported check would be a fourth thing each door has to call, and a door that forgets it is exactly
     * the shape the module exists to prevent.
     */
    const err = connectionInputError({ entityIds: ['aaaaaaaa-0000-4000-8000-000000000001'] });
    assert.ok(err, 'the shared connection check lets a retired field through');
    assert.equal(err, RETIRED['entityIds'], 'the doors must say what the module says, not a second wording');
  });

  it('and the retired name is answered BEFORE the shape rules, so the advice fits the mistake', () => {
    // A caller sending `entityIds: "not-an-array"` must be told the field is retired, not that its value is
    // the wrong shape for a field they cannot use at all.
    assert.equal(connectionInputError({ entityIds: 'nope' }), RETIRED['entityIds']);
  });

  it('the MCP dispatcher answers with the same sentence, not "unexpected property"', () => {
    /*
     * MCP refuses a step earlier, from the schema, so the text cannot come from the handler. Asserted on
     * the source because reaching the dispatcher needs a connection with a token-scoped schema, and what
     * has to hold is structural: the rejected property name is looked up in the shared map, and the
     * generic sentence is the FALLBACK rather than the answer.
     */
    assert.match(validateArgsSrc, /retiredWriteFieldHint\(/,
      'the dispatcher does not consult the retired-field map, so MCP answers "unexpected property" for a '
      + 'name REST explains');
    assert.match(validateArgsSrc, /retired \?\? `\$\{at\}: unexpected property/,
      'the generic message must be the fallback, not the answer that wins');
    assert.equal(retiredWriteFieldHint('entityIds'), RETIRED['entityIds']);
    assert.equal(retiredWriteFieldHint('somethingElse'), null,
      'an ordinary unknown property must still get the ordinary message');
  });
});
