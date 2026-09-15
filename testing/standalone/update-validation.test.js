/**
 * Updates validate the record AS IT WILL BE, and say whose fault a violation is.
 *
 * ## The hole
 *
 * Creates were validated. Updates were validated **only when the patch used `deleteFields`** — the branch
 * that exists because removing a required property is an obvious way to break a record. Every other patch
 * skipped validation, so `PATCH { properties: { status: "nonsense" } }` wrote a value the same space
 * rejects at create time, in a space explicitly set to `strict`. The stricter the schema, the wider the
 * gap: the one write path an operator relies on to keep records conformant was the one that did not check.
 *
 * ## Why the merged record, and not the patch
 *
 * A patch is a fragment. "Does this fragment satisfy the schema" has no useful answer, because a required
 * property the patch does not mention is present in the record and absent from the patch — so validating
 * the fragment would fail every partial update that happens not to restate every required field.
 *
 * ## Why the split
 *
 * Validating the merged record surfaces a second problem immediately: a record that was **already**
 * non-compliant — written before the schema tightened, imported, or synced from a peer with different
 * meta — now fails on any edit, including one that has nothing to do with the offending field. Reporting
 * that as "your change is invalid" is false in the way that costs an afternoon: the operator stares at a
 * field they did not touch. So violations are classified against the record's prior state, and the message
 * names which situation applies.
 *
 * Run: node --test testing/standalone/update-validation.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockAfter } from './_structural-window.mjs';

let classifyUpdateViolations;
let describeUpdateViolations;
let assertUpdateAllowed;

const STRICT = { validationMode: 'strict' };
const WARN = { validationMode: 'warn' };
const OFF = { validationMode: 'off' };

const v = (field, reason) => ({ field, value: 'whatever', reason });

describe('update validation', () => {
  before(async () => {
    ({ classifyUpdateViolations, describeUpdateViolations, assertUpdateAllowed } =
      await import('../../server/dist/brain/write-validation.js'));
  });

  describe('classification', () => {
    it('calls a violation the patch caused "introduced"', () => {
      const out = classifyUpdateViolations(STRICT, [], [v('status', 'not in enum')]);
      assert.deepEqual(out.introduced.map(x => x.field), ['status']);
      assert.deepEqual(out.preExisting, []);
      assert.equal(out.blocked, true);
    });

    it('calls a violation the record already had "pre-existing"', () => {
      const already = [v('owner', 'required property missing')];
      const out = classifyUpdateViolations(STRICT, already, already);
      assert.deepEqual(out.preExisting.map(x => x.field), ['owner']);
      assert.deepEqual(out.introduced, []);
    });

    it('separates the two when both are present', () => {
      const out = classifyUpdateViolations(
        STRICT,
        [v('owner', 'required property missing')],
        [v('owner', 'required property missing'), v('status', 'not in enum')],
      );
      assert.deepEqual(out.introduced.map(x => x.field), ['status']);
      assert.deepEqual(out.preExisting.map(x => x.field), ['owner']);
    });

    it('does not credit a patch for fixing one violation while adding another on the same field', () => {
      // Keyed on field AND reason. One field can fail two ways at once, and keying on the field alone
      // would let a NEW failure on an already-failing field be waved through as pre-existing.
      const out = classifyUpdateViolations(
        STRICT,
        [v('count', 'not a number')],
        [v('count', 'below minimum')],
      );
      assert.deepEqual(out.introduced.map(x => x.reason), ['below minimum']);
      assert.deepEqual(out.preExisting, []);
    });

    it('still calls it pre-existing when the patch changed the value but not the failure', () => {
      // The value is deliberately excluded from the identity: "a" -> "b", both outside the enum, is the
      // same defect the record already had. Blaming the patch for a constraint it did not break sends the
      // operator after the wrong field.
      const before = [{ field: 'status', value: 'a', reason: 'not in enum' }];
      const after = [{ field: 'status', value: 'b', reason: 'not in enum' }];
      const out = classifyUpdateViolations(STRICT, before, after);
      assert.deepEqual(out.preExisting.map(x => x.field), ['status']);
      assert.deepEqual(out.introduced, []);
    });

    it('reports nothing when the merged record is clean', () => {
      const out = classifyUpdateViolations(STRICT, [v('owner', 'required property missing')], []);
      assert.equal(out.blocked, false);
      assert.deepEqual(out.all, []);
      assert.deepEqual(out.introduced, []);
      assert.deepEqual(out.preExisting, []);
    });

    it('a patch that REPAIRS a pre-existing violation passes', () => {
      // The record is not trapped: validation is of the merged result, so including the broken field in
      // the same request fixes it. That is what makes blocking on a pre-existing violation defensible
      // rather than a dead end.
      const out = classifyUpdateViolations(STRICT, [v('owner', 'required property missing')], []);
      assert.equal(out.blocked, false);
    });
  });

  describe('validation mode', () => {
    it('blocks only in strict', () => {
      const after = [v('status', 'not in enum')];
      assert.equal(classifyUpdateViolations(STRICT, [], after).blocked, true);
      assert.equal(classifyUpdateViolations(WARN, [], after).blocked, false);
      assert.equal(classifyUpdateViolations(OFF, [], after).blocked, false);
      assert.equal(classifyUpdateViolations(undefined, [], after).blocked, false);
    });

    it('blocks on what the patch INTRODUCED, never on what the record already had', () => {
      // Owner ruling P-6 = B, 2026-08-15, on the report the canary operator called "freezes records":
      //
      //   write an entity with properties.status = "retired"   (the enum allows it)  -> 201
      //   remove "retired" from the enum                                             -> 200
      //   PATCH that record's DESCRIPTION only                                       -> 422
      //
      // The violation is already stored. Refusing the patch does not improve the data, it only stops the
      // record being maintained — and any schema tightening did this retroactively to every record that no
      // longer fit. Strictness is about what a write INTRODUCES.
      const already = [v('status', 'not in enum')];
      const out = classifyUpdateViolations(STRICT, already, already);
      assert.equal(out.blocked, false, 'an unrelated edit must go through');
      assert.deepEqual(out.introduced, []);
      assert.deepEqual(out.preExisting.map(x => x.field), ['status']);
    });

    it('still blocks a patch that introduces one, alongside a pre-existing one', () => {
      // The half that must NOT weaken. Both lists non-empty is the case where a lenient reading would let a
      // genuinely bad patch through by pointing at the record's older problem.
      const out = classifyUpdateViolations(STRICT, [v('owner', 'missing')],
        [v('owner', 'missing'), v('status', 'not in enum')]);
      assert.equal(out.blocked, true);
      assert.deepEqual(out.introduced.map(x => x.field), ['status']);
    });

    it('reports the pre-existing violation even though it does not block', () => {
      // Not-blocking must not become not-telling: `preExisting` and the full `all`/`warnings` list are how a
      // client that wants to insist on compliance still can.
      const already = [v('status', 'not in enum')];
      const out = classifyUpdateViolations(STRICT, already, already);
      assert.deepEqual(out.all.map(x => x.field), ['status']);
      assert.deepEqual(out.warnings.map(x => x.field), ['status']);
      assert.match(out.message, /already non-compliant/i);
    });

    it('still classifies in warn mode, so the report says whose fault it is', () => {
      // Warn mode writes the record and reports; a report that cannot tell the operator which field is
      // theirs is the same failure as a blocking error that cannot.
      const out = classifyUpdateViolations(WARN, [v('owner', 'missing')], [v('owner', 'missing'), v('status', 'bad')]);
      assert.equal(out.blocked, false);
      assert.deepEqual(out.introduced.map(x => x.field), ['status']);
      assert.deepEqual(out.preExisting.map(x => x.field), ['owner']);
    });
  });

  describe('the message', () => {
    it('blames the change when only the change is at fault', () => {
      const m = describeUpdateViolations([v('status', 'x')], []);
      assert.match(m, /change violates/i);
      assert.match(m, /status/);
      assert.ok(!/already non-compliant/i.test(m), 'must not imply a pre-existing problem there is none of');
    });

    it('exonerates the change when the record was already broken', () => {
      const m = describeUpdateViolations([], [v('owner', 'x')]);
      assert.match(m, /already non-compliant/i);
      assert.match(m, /did not cause it/i);
      // This asserted /same request/ — "must say how to get unstuck" — which was the right demand while a
      // pre-existing violation BLOCKED the write, because repairing it in the same request was the only way
      // through. Under P-6 = B nobody is stuck, so the sentence must say the opposite: not refused, and the
      // repair can happen in any later write.
      assert.match(m, /not refused/i, 'must say the write is going through');
      assert.match(m, /repair/i, 'must still say the record needs fixing');
    });

    it('says both, and which is which', () => {
      const m = describeUpdateViolations([v('status', 'x')], [v('owner', 'y')]);
      assert.match(m, /change violates[^.]*status/i);
      assert.match(m, /already non-compliant[^.]*owner/i);
    });

    it('lists each field once even when it fails several ways', () => {
      const m = describeUpdateViolations([v('status', 'not in enum'), v('status', 'wrong type')], []);
      assert.equal(m.match(/status/g).length, 1);
    });
  });

  describe('the MCP gate', () => {
    it('throws on a blocked verdict and is silent otherwise', () => {
      assert.throws(
        () => assertUpdateAllowed(classifyUpdateViolations(STRICT, [], [v('status', 'x')])),
        /schema_violation.*status/s,
      );
      assert.doesNotThrow(() => assertUpdateAllowed(classifyUpdateViolations(WARN, [], [v('status', 'x')])));
    });
  });
});

// ── The wiring, so no write surface can quietly skip the gate again ──────────

const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('every update path runs the gate', () => {
  // Eight surfaces for four record types. The asymmetry this prevents is not hypothetical: `update_chrono`
  // shipped without the type allowlist `save_chrono` enforced, and REST/MCP disagreeing about the same
  // record is the same bug one layer up. A constraint looks enforced right up until someone uses the
  // other door.
  const PATHS = [
    'server/src/api/brain/memories.ts',
    'server/src/api/brain/entities.ts',
    'server/src/api/brain/edges.ts',
    'server/src/api/brain/chrono.ts',
    'server/src/mcp/tools/memory.ts',
    'server/src/mcp/tools/entity.ts',
    'server/src/mcp/tools/edge.ts',
    'server/src/mcp/tools/chrono.ts',
  ];

  /*
   * "Reaches validation", not "calls the classifier itself".
   *
   * The owner ruled on 2026-08-29 that every upsert/update/insert validates, and the way to make that true for
   * callers nobody has enumerated is to put the check inside the WRITER — `every-writer-validates-internally.
   * test.js` asserts all eight. A surface that delegates is therefore satisfying this rule more strongly than
   * one that calls a classifier itself, and the entity and chrono routes now do exactly that: they translate
   * the writer's `SchemaViolationError` into their own status code instead of re-deriving the verdict.
   *
   * Demanding the direct call would have made this gate refuse the fix — a check pinned on HOW a rule is
   * enforced blocks the change that enforces it better.
   */
  it('no update surface holds its own copy of the rule', () => {
    /*
     * This asserted the OPPOSITE until 2026-08-30: that each surface calls `classifyUpdateViolations` itself.
     * That was right while the rule lived at the doors, and the owner's ruling moved it into the writers — so
     * the presence of a classifier call at a door is now the defect, not the evidence.
     *
     * The property "an update is validated" is asserted where it belongs and more strongly, over all eight
     * writers, in `every-writer-validates-internally.test.js`. What is left for a door is to hold nothing,
     * which is what this checks.
     *
     * Two of these need no error handling at all, and that is the cleanest outcome rather than a gap: the
     * writer throws exactly the `SchemaViolationError` that `assertUpdateAllowed` used to throw here, so an
     * MCP tool's existing failure path already carries it unchanged. An earlier draft of this check demanded
     * that a door MENTION the error, and reported those two as failures for being tidy.
     */
    const offenders = [];
    for (const p of PATHS) {
      for (const m of strip(readFileSync(p, 'utf8')).matchAll(/classifyUpdateViolations\(/g)) {
        offenders.push(`${p}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these rebuild the merged record and validate it themselves, twenty lines from the writer that does the '
      + 'real merge — and the simulation is the copy that drifts:\n  ' + offenders.join('\n  '));
  });

  it('no update path still gates validation behind deleteFields alone', () => {
    // The exact shape of the original hole: `if (dfPaths) { ...validate... }`. Validation must run
    // unconditionally and merely *apply* the deletions when they are present.
    /*
     * The `if (dfPaths)` BLOCK, bounded by its closing brace. At 600 characters this reported no offenders for any
     * branch longer than that — and the branch is where the validation call would sit, so the longer the hole, the
     * more certainly this passed over it.
     */
    const offenders = PATHS.filter(p => {
      const src = strip(readFileSync(p, 'utf8'));
      const at = src.indexOf('if (dfPaths) {');
      if (at === -1) return false;
      return /validate(Memory|Entity|Edge|Chrono)\(/.test(blockAfter(src, at, `the dfPaths branch in ${p}`));
    });
    assert.deepEqual(offenders, [],
      'validation must not be conditional on deleteFields — that was the original gap');
  });

  it('and none of them reimplements one either', () => {
    /*
     * This used to require every MCP tool to IMPORT `write-validation.js` — the shared gate — as proof it was
     * not rolling its own. With the rule inside the writers, a tool that imports nothing from it is the
     * strongest possible version of that, so the check is now for the reimplementation itself: a tool
     * assembling a merged record and running a validator over it.
     */
    const offenders = [];
    for (const p of PATHS.filter(x => x.includes('/mcp/'))) {
      const src = strip(readFileSync(p, 'utf8'));
      if (/validate(Entity|Memory|Edge|Chrono)\(/.test(src)) offenders.push(p);
    }
    assert.deepEqual(offenders, [],
      'these run a validator directly, which is a second implementation of the rule the writer holds:\n  '
      + offenders.join('\n  '));
  });
});
