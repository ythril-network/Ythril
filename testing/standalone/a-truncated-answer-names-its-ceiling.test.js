/**
 * A shortened answer names the size parameter that shortened it (`Q-116`).
 *
 * An answer is held to two ceilings at once — characters (from `maxChars`, from `maxTokens`, or the door's default)
 * and bytes (`maxBytes`, only when asked) — and it stops at whichever the next row would pass. The answer said
 * `truncated: true` and `truncatedBy: 'budget'`, and nothing said WHICH. The Query tab's advice therefore read
 * "raise Max response size in the form" over a form with three fields of that name, and an agent had the same
 * guess to make. Only the meter knows: it compares the row against both ceilings (`budgetMeter.admit`). A client
 * inferring it from `budgetChars` / `budgetBytes` would be a second copy of the admission rule, and cannot tell in
 * the band where both ceilings are set and the bytes one is larger.
 *
 * So the answer carries `budgetBoundBy`: the PARAMETERS to raise, `maxChars` | `maxTokens` | `maxBytes`. The
 * character ceiling is named by whichever parameter set it — `maxTokens` when the token conversion was the lower,
 * `maxChars` otherwise, including when neither was sent (the default is raised by stating `maxChars`). Both are
 * named when both would have been passed, because raising one alone would not bring the next row in.
 *
 * Every budgeted answer is built by one of three functions — `budgetFields` (from `applyBudget`), the row-by-row
 * `budgetedRowsEnvelope`, and a spill window through `readSpillPage` into `budgetFields` — so all three are driven.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-truncated-answer-names-its-ceiling.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { applyBudget, budgetFields, budgetedRowsEnvelope, resolveBudget, budgetMeter } =
  await import('../../server/dist/brain/result-budget.js');

const resolved = (req) => {
  const r = resolveBudget(req);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};

/** A row of `n` serialised characters of ASCII (chars = bytes). */
const ascii = (n) => ({ t: 'a'.repeat(n - 8) });
/** A row of German text: ~1.9 bytes per character, so the byte ceiling bites first. */
const german = (n) => ({ t: 'ü'.repeat(n - 8) });

function fieldsFor(rows, req) {
  const budget = resolved(req);
  return budgetFields(applyBudget(rows, budget), rows.length, budget, 0);
}

describe('a budget-truncated answer names the ceiling that cut it', () => {
  it('the default character ceiling is named maxChars', () => {
    const f = fieldsFor(Array.from({ length: 100 }, () => ascii(1000)), {});
    assert.equal(f.truncated, true);
    assert.deepEqual(f.budgetBoundBy, ['maxChars']);
  });

  it('a stated maxChars is named maxChars', () => {
    const f = fieldsFor(Array.from({ length: 10 }, () => ascii(1000)), { maxChars: 3000 });
    assert.deepEqual(f.budgetBoundBy, ['maxChars']);
  });

  it('maxTokens, when its conversion is the lower character ceiling, is named maxTokens', () => {
    const f = fieldsFor(Array.from({ length: 10 }, () => ascii(1000)), { maxChars: 9000, maxTokens: 1000 });
    assert.deepEqual(f.budgetBoundBy, ['maxTokens']);
  });

  it('maxBytes is named when German text passes the byte ceiling first', () => {
    const f = fieldsFor(Array.from({ length: 10 }, () => german(1000)), { maxChars: 9000, maxBytes: 4000 });
    assert.deepEqual(f.budgetBoundBy, ['maxBytes']);
  });

  it('both are named when the next row would pass both', () => {
    // ASCII, so chars = bytes, and both ceilings equal: the next row passes both at once.
    const f = fieldsFor(Array.from({ length: 10 }, () => ascii(1000)), { maxChars: 2500, maxBytes: 2500 });
    assert.deepEqual([...f.budgetBoundBy].sort(), ['maxBytes', 'maxChars']);
  });

  it('an answer that was not cut by the budget carries no budgetBoundBy', () => {
    const f = fieldsFor([ascii(100), ascii(100)], {});
    assert.equal(f.truncated, false);
    assert.equal('budgetBoundBy' in f, false);
  });

  it('the row-by-row envelope names it too, and only for a budget cut', async () => {
    const budget = resolved({ maxBytes: 4000, maxChars: 9000 });
    const rows = Array.from({ length: 10 }, () => german(1000));
    const cut = await budgetedRowsEnvelope({
      total: rows.length, budget, build: async (i) => ({ row: rows[i] }), spillRemainder: async () => null,
    });
    assert.equal(cut.fields.truncatedBy, 'budget');
    assert.deepEqual(cut.fields.budgetBoundBy, ['maxBytes']);

    const walked = await budgetedRowsEnvelope({
      total: rows.length, budget, build: async (i) => (i < 1 ? { row: rows[i] } : { stop: 'walk_budget' }),
      spillRemainder: async () => null,
    });
    assert.equal(walked.fields.truncatedBy, 'walk_budget');
    assert.equal('budgetBoundBy' in walked.fields, false, 'a walk that ran out is not a size ceiling');
  });

  it('the meter reports which ceiling refused, which is what every door reads', () => {
    const m = budgetMeter({ chars: 5000, bytes: 3000 });
    assert.equal(m.admit(german(1000)), true);
    assert.equal(m.admit(german(1000)), false);
    assert.deepEqual(m.refusedBy(), { chars: false, bytes: true });
  });
});
