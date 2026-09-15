/**
 * Every key `traverse` accepts is declared by the MCP schema that guards it.
 *
 * ## The defect, which shipped
 *
 * `parseTraverseOption` gained `includeChrono` / `includeMemories` / `includeFiles` in 3.6 and the REST route
 * accepted them the same day. MCP's `recall` and `similar` did not: their `traverse` object schema still
 * declared `{depth, edgeLabels, direction}` with `additionalProperties: false`, and the dispatcher enforces
 * `inputSchema` with Ajv **before** the handler runs (`router.ts`, `skipSchemaValidation` is not set on these
 * tools). So the call was refused with `must match exactly one schema in oneOf` while the byte-identical REST
 * body answered 200 with the expanded graph.
 *
 * The tool's own DESCRIPTION told callers to send exactly the object its schema forbade — which is the worst
 * form of this, because a schema description is what a caller reads *while constructing arguments* and
 * `help()` says so in as many words.
 *
 * ## Why the gate that was supposed to catch it did not
 *
 * `recall-expands-the-same-links-query-does.test.js` asserted each flag appeared in the recall tool's
 * description. It did — that is the half that was written. A gate that greps the prose *about* a schema
 * passes on the wrong rule; only the schema decides what the dispatcher accepts.
 *
 * So this one **exercises** the compiled schema and derives its expectation from `TRAVERSE_OPTION_FIELDS`,
 * which is the parser's own list. A fourth key added to the parser fails here until both tools declare it,
 * with no list in this file to keep in step.
 *
 * Run: node --test testing/standalone/the-traverse-option-schema-is-one-schema.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { TRAVERSE_OPTION_FIELDS, traverseOptionSchema } = await import('../../server/dist/brain/traverse-option.js');
const { recallTool, find_similarTool } = await import('../../server/dist/mcp/tools/search.js');

/** The dispatcher builds these per call; only their shape matters here. */
const STUB = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };

/** The object branch of a tool's `traverse` schema — the one a `{depth, …}` argument is validated against. */
function traverseObjectBranch(tool) {
  const schema = tool.inputSchema(STUB);
  const traverse = schema.properties?.traverse;
  assert.ok(traverse, `${tool.name} no longer declares a traverse parameter — re-point this gate`);
  const branches = traverse.oneOf ?? [traverse];
  const obj = branches.find(b => b.type === 'object');
  assert.ok(obj, `${tool.name}'s traverse has no object branch, so the narrowing form cannot be sent at all`);
  return obj;
}

const TOOLS = [recallTool, find_similarTool];

describe('the traverse object schema accepts what the parser accepts', () => {
  it('both tools declare an object branch', () => {
    // Floors the checks below: a missing branch would make every `for` loop pass over nothing.
    assert.equal(TOOLS.length, 2);
    for (const tool of TOOLS) assert.ok(traverseObjectBranch(tool).properties);
  });

  for (const field of TRAVERSE_OPTION_FIELDS) {
    it(`\`${field}\` is declared by every tool that takes a traverse`, () => {
      /*
       * Derived from `TRAVERSE_OPTION_FIELDS`, never from a list here. That list is what
       * `parseTraverseOption` refuses unknown keys against, so it IS the set of things a caller may send —
       * and a gate holding its own copy would go stale exactly when a key is added, which is the moment it
       * is needed.
       */
      for (const tool of TOOLS) {
        const props = traverseObjectBranch(tool).properties ?? {};
        assert.ok(field in props,
          `${tool.name}'s traverse schema omits \`${field}\`, and the branch sets additionalProperties:false — `
          + 'so the dispatcher refuses a call REST answers 200 for, before the handler ever runs');
      }
    });
  }

  it('the object branch still refuses an unknown key', () => {
    // The other direction. Declaring the flags by opening the schema up would let `limit` through — which is
    // deliberately not accepted, because in a recall the node cap comes from topK and the byte budget.
    for (const tool of TOOLS) {
      assert.equal(traverseObjectBranch(tool).additionalProperties, false,
        `${tool.name} would accept any key inside traverse, including the ones the parser exists to refuse`);
    }
  });

  it('the two tools declare the SAME object branch, from one definition', () => {
    /*
     * It was written out twice, and that is how they came to disagree: the flags were added to neither, and
     * a fix that touched only `recall` would have left `similar` behind for another release. One
     * definition means a key cannot reach one tool and not the other.
     */
    assert.deepEqual(traverseObjectBranch(recallTool), traverseObjectBranch(find_similarTool),
      'the two traverse schemas differ, so a caller must know which tool they are on');
    const src = stripComments(readFileSync('server/src/mcp/tools/search.ts', 'utf8'));
    const inline = (src.match(/edgeLabels:\s*\{\s*type:\s*'array'/g) ?? []).length;
    assert.equal(inline, 0,
      'the traverse object schema is spelled out inline; extract it so both tools share one definition');
  });
});

describe('the builder is not a second list', () => {
  it('it declares exactly the fields the parser accepts — no more, no fewer', async () => {
    /*
     * The trap one level up. Extracting the schema into a builder fixes the two tools disagreeing with each
     * other; it does NOT stop the builder disagreeing with the parser, which is the disagreement that
     * shipped. Both sets come from the same module now, so this asserts they are the same set rather than
     * trusting that whoever edits one remembers the other.
     */
    const { traverseOptionSchema } = await import('../../server/dist/brain/traverse-option.js');
    const obj = traverseOptionSchema(5).oneOf.find(b => b.type === 'object');
    assert.deepEqual(
      Object.keys(obj.properties).sort(), [...TRAVERSE_OPTION_FIELDS].sort(),
      'the advertised keys and the accepted keys have drifted — a key in one and not the other is either a '
      + 'refusal the caller cannot predict, or a capability nobody can discover');
  });

  it('the ceiling in the schema is the ceiling the parser enforces', () => {
    // Two numbers for one cap is how a schema comes to refuse a depth the parser would have taken, or to
    // advertise one it refuses. The builder takes it as a parameter for exactly that reason.
    const obj = traverseOptionSchema(5).oneOf.find(b => b.type === 'object');
    assert.equal(obj.properties.depth.maximum, 5);
    assert.equal(traverseOptionSchema(5).oneOf.find(b => b.type === 'number').maximum, 5);
    assert.equal(traverseOptionSchema(3).oneOf.find(b => b.type === 'object').properties.depth.maximum, 3,
      'the cap is hardcoded rather than taken from the argument');
  });
});

describe('the description matches the schema', () => {
  it('every flag the description tells a caller to send is one the schema accepts', () => {
    /*
     * The pairing is the point. The description was rewritten to instruct callers to send
     * `{depth: 2, includeChrono: true, …}` in the same commit that left the schema declaring three keys, so
     * the authoritative reference documented a call its own guard rejected. Neither half is checkable alone:
     * a description naming a key the schema refuses is a lie, and a schema key no description mentions is a
     * capability nobody discovers.
     */
    for (const tool of TOOLS) {
      const desc = tool.inputSchema(STUB).properties?.traverse?.description ?? '';
      const props = traverseObjectBranch(tool).properties ?? {};
      const promised = [...desc.matchAll(/\b(include[A-Z][a-zA-Z]*)\b/g)].map(m => m[1]);
      const unmet = [...new Set(promised)].filter(k => !(k in props));
      assert.deepEqual(unmet, [],
        `${tool.name}'s description tells a caller to send ${unmet.join(', ')}, which its schema refuses`);
    }
  });

  it('and every flag the schema ACCEPTS is one the description names', () => {
    /*
     * The other direction, and the reason it took until A-7 to exist: the check above derives what is
     * `promised` FROM the description, so a description mentioning no flag at all had nothing to be unmet and
     * passed. One-directional by construction — which is how `similar` accepted all three link flags from
     * #1083 while its own description still described the pre-3.6 shape.
     *
     * The docblock above already claimed both mattered: *"a schema key no description mentions is a capability
     * nobody discovers."* It was true and only half-checked, which is the worst state for a stated rule to be
     * in, because the prose reads as protection.
     */
    for (const tool of TOOLS) {
      const desc = tool.inputSchema(STUB).properties?.traverse?.description ?? '';
      const props = traverseObjectBranch(tool).properties ?? {};
      const accepted = Object.keys(props).filter(k => /^include[A-Z]/.test(k));
      const unmentioned = accepted.filter(k => !desc.includes(k));
      assert.deepEqual(unmentioned, [],
        `${tool.name} accepts ${unmentioned.join(', ')} and its description never names them — a caller `
        + 'reading the reference while constructing arguments cannot discover a capability that is live');
    }
  });
});
