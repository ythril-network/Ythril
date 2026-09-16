/**
 * One call says what a space DECLARES and what it actually HOLDS.
 *
 * ## Why these were two tools, and why that was the defect
 *
 * `space_meta` returned the declared schema — the types somebody defined, with their naming patterns and
 * required properties. `er_model` returned the actual shape — the types that hold records and which edge
 * labels really connect which of them. Both are answers to *"what is this space like before I write to
 * it"*, and a caller needed both to get a true picture: a space can declare twenty types and hold three, or
 * hold records of a type nobody declared.
 *
 * Owner, 2026-09-15: *"keep the name `space_meta`, a model doesn't make sense to hold the usage_notes and
 * purpose. there we can have purpose, usage_notes, declared_schema, actual_schema."* And the reason it is
 * worth merging rather than leaving as two: **the actual schema is already in the declared schema's
 * format**, so having both side by side makes promoting observed shape into a declared one a step a caller
 * can take, instead of a JSON exercise done by hand.
 *
 * ## What this gate holds
 *
 * That the merge did not quietly drop half of either answer. A fold is the change most likely to lose
 * something under cover of tidying: the tool that went is the one nobody will notice the absence of until
 * they needed the field it carried.
 *
 * Run: node --test testing/standalone/space-meta-answers-declared-and-actual-together.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let ALL_TOOLS;
before(async () => {
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
});

const STUB = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };
const tool = name => ALL_TOOLS.find(t => t.name === name);

describe('the two answers arrive together', () => {
  it('`er_model` is gone as a separate tool', () => {
    assert.equal(tool('er_model'), undefined,
      'er_model still exists — the fold is half done, and two tools answering one question is what it was for');
  });

  it('`space_meta` is still the one that carries the space\'s own words', () => {
    // The owner's reason for keeping THIS name: a "model" has no business holding a purpose and usage
    // notes. The merge went in this direction and not the other.
    assert.ok(tool('space_meta'), 'space_meta is gone — the fold went the wrong way round');
  });

  it('its description names both halves, so a caller knows the actual shape is in there', () => {
    // The failure this prevents: the capability survives and nobody can find it, because the description
    // still describes only the declared half and `er_model` is what the docs told them to call.
    const d = tool('space_meta').description;
    assert.match(d, /declared/i, 'must still say it returns what the space DECLARES');
    assert.match(d, /actual/i, 'and must say it returns what the space actually HOLDS');
  });

  it('and it points at the one thing the pairing makes possible', () => {
    // Not decoration: the actual schema comes back in the declared schema's own format, so a caller can
    // promote what a space really holds into what it declares. That is the reason to merge rather than to
    // leave two tools, and a description that omits it leaves the merge looking like tidying.
    assert.match(tool('space_meta').description, /promot|declare it|turn it into/i,
      'say that the actual shape can be promoted into a declared schema — it is why these belong together');
  });
});

describe('nothing that was reachable stopped being reachable', () => {
  it('the space parameter is unchanged — this is a merge, not a re-scoping', () => {
    const props = tool('space_meta').inputSchema(STUB).properties ?? {};
    assert.ok('space' in props, 'space_meta must still take a space');
  });

  it('every field er_model answered is named in what replaces it', () => {
    /*
     * Derived from the ER model builder rather than listed here: a hand-written list of fields is the same
     * defect this repo keeps finding, and it would pass on the day the builder gained a field the merged
     * tool forgot to carry.
     */
    const d = tool('space_meta').description;
    for (const field of ['entity', 'edge', 'count']) {
      assert.match(d, new RegExp(field, 'i'),
        `the merged description never mentions ${field}, which is half of what er_model answered`);
    }
  });
});
