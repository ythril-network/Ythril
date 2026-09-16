/**
 * Changing a record's `type` must validate against the type it will HAVE, not the one it had.
 *
 * ## The defect
 *
 * A memory's `type` selects which schema applies — `typeSchemas.memory[type]` — so re-typing a record changes
 * which rules it must satisfy. Both doors validated the after-state against `record.type`, the stored one, so
 * the destination schema's allowlist, required properties and enums were **never consulted** and the write
 * succeeded regardless.
 *
 * The entity route had it right the whole time, twenty files away:
 * `const resultType = updates.type ?? existing.type` (`api/brain/entities.ts:305`). One rule, two
 * implementations, and the weaker one silent — this repo's most-produced defect, on a field whose entire job is
 * to select the rules.
 *
 * ## The parity half
 *
 * `update_fact` did not declare `type` at all, under `additionalProperties: false` — so the MCP door
 * **hard-refused** a parameter the REST door accepted and applied. Fixing only the validation would have left
 * one door unable to reach the bug.
 *
 * ## Why the BEFORE side keeps the stored type
 *
 * Deliberate, and asserted below so it is not "corrected" later: the before-state describes the record as
 * stored, which is what lets `classifyUpdateViolations` tell a violation this patch INTRODUCED from one it
 * merely inherited. Validating both sides against the destination would report pre-existing violations as new.
 *
 * Run: node --test testing/standalone/retyping-validates-the-destination-type.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf, bodyOf } from './_structural-window.mjs';

/*
 * THE SUBJECT MOVED. It used to be the two doors, each running its own comparison; the owner's ruling of
 * 2026-08-29 put the check inside the writers, so there is exactly one place per record kind to check and the
 * doors hold nothing.
 *
 * The PROPERTY is unchanged and is the reason this file exists: the after-side must be validated against the
 * type the record will HAVE, or re-typing never consults the destination schema — its allowlist, its required
 * properties and its enums are simply not applied and the write succeeds. The before-side must stay on the
 * STORED type, which is what lets the classification tell an introduced violation from an inherited one.
 */
const WRITERS = [
  { name: 'fact', file: 'server/src/brain/fact.ts', fn: 'updateFact' },
  { name: 'entity', file: 'server/src/brain/entities.ts', fn: 'updateEntityById' },
];

/** The two arguments of the writer's own classify call: `(meta, existing, incoming)`. */
function comparisonArgs(src, fn) {
  const body = bodyOf(src, fn);
  const m = /classify(?:Fact|Entity)UpsertAgainst\(/.exec(body);
  assert.notEqual(m, null, `no classifier call in ${fn} — re-point this gate`);
  const args = argumentsOf(body, m.index + m[0].length - 1, 'the comparison');
  assert.equal(args.length, 3, `expected (meta, existing, incoming), got ${args.length} arguments`);
  return { before: args[1], after: args[2] };
}

describe('re-typing validates the destination type', () => {
  for (const door of WRITERS) {
    const src = stripComments(readFileSync(door.file, 'utf8'));

    it(`${door.name}: the AFTER side uses the type the record will have`, () => {
      const { after, before } = comparisonArgs(src, door.fn);
      /*
       * Asserted as "not the stored type", rather than as one spelling of the fix. REST names an intermediate
       * (`const resultType = updates.type ?? mem.type`) and MCP inlines the same expression; a first version
       * requiring `updates.type ??` inside the argument passed on one door and failed on the other while both
       * were correct.
       */
      /*
       * The before-side is now the stored record ITSELF — the classifier takes `(meta, existing, incoming)`
       * and derives the prior violations from it, rather than each door hand-building a `validate*` call for
       * each side. So "the before side reads the stored record" is `existing`, and the after-side must not be.
       */
      assert.match(before, /\bexisting\b/, `the before side should be the stored record — got:\n${before}`);
      assert.doesNotMatch(
        after, /:\s*existing\.type\b/,
        `${door.name} validates the after-state against the STORED type, so re-typing never consults the `
        + 'destination schema — its allowlist, required properties and enums are not applied and the write '
        + `succeeds anyway.\n\nafter-side argument:\n${after}`,
      );
      // The after-side must name a type that can differ from the stored one. Both writers compute it before
      // the call (`newType`, or the `$set`/`existing` pick), so the argument names that value.
      assert.match(
        after, /type:\s*(?!existing\.type\b)\w/,
        `${door.name}'s after-side names no type at all, so the destination schema is never selected`,
      );
    });

    it(`${door.name}: the BEFORE side still uses the stored type`, () => {
      const { before } = comparisonArgs(src, door.fn);
      assert.doesNotMatch(
        before, /updates\.type|\$set/,
        'the before-state must describe the record AS STORED. Validating it against the destination type would '
        + 'report pre-existing violations as ones this patch introduced, which is the distinction the '
        + `classification exists to draw.\n\nbefore-side argument:\n${before}`,
      );
    });
  }

  it('both doors accept `type` on update — the capability exists on each', () => {
    // The MCP tool declared no `type` under additionalProperties:false, so it refused what REST applied.
    const mcp = stripComments(readFileSync('server/src/mcp/tools/fact.ts', 'utf8'));
    const at = mcp.indexOf("name: 'update_fact'");
    assert.notEqual(at, -1, 'update_memory is gone — re-point this gate');
    const tool = mcp.slice(at, mcp.indexOf("name: '", at + 10) === -1 ? undefined : mcp.indexOf("name: '", at + 10));
    assert.match(
      tool, /\btype:\s*\{/,
      'update_memory must declare `type`. Under additionalProperties:false an undeclared parameter is a hard '
      + 'refusal at the dispatcher, so the MCP door offered strictly less than REST for the same capability.',
    );
  });
});
