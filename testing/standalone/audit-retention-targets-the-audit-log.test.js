/**
 * The audit change-retention sweep must target the collection the audit log is actually written to.
 *
 * ## What happened
 *
 * `change-retention.ts` was written in #491 with its own `const COLLECTION = '_audit_log'`. The audit log has
 * been `audit_log` since #61. So the sweep ran every six hours against a collection **nothing has ever
 * written to**, across fourteen releases, and redacted nothing — while `13-audit-log-api.md` documented a
 * 14-day window on a brain record edit's `changes` payload, and `doc-cited-constants` kept that number
 * faithful to the constant. Every check was green. The behaviour never happened.
 *
 * The `changes` payload is allowlisted user record content. So the actual consequence is a documented
 * privacy window that was never enforced, and entries that should have been redacted at 14 days keeping
 * their content for the full 90.
 *
 * ## Why nothing caught it
 *
 * `updateMany` against a collection that does not exist **succeeds** with `modifiedCount: 0`, and the sweep
 * logged only when the count was above zero. Zero redacted is also exactly what a healthy instance with
 * nothing aged out reports. There was no failure to see — the same shape as counting through an endpoint
 * that was never real and reading the zero as an answer.
 *
 * ## What this pins
 *
 * The fix is not "spell it correctly" — that leaves two copies. The name is exported from `audit.ts` and
 * imported here, so the pruner cannot name a collection the writer does not use. This asserts that SHAPE
 * rather than comparing two string literals, because two literals that agree today drift tomorrow.
 *
 * Both files now discuss `_audit_log` in prose, so **comments are stripped before anything is matched**. A
 * gate that fires on the comment explaining its own fix, or passes because of it, has happened three times
 * in this repo.
 *
 * Run: node --test testing/standalone/audit-retention-targets-the-audit-log.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WRITER = 'server/src/audit/audit.ts';
const PRUNER = 'server/src/audit/change-retention.ts';
const BOOTSTRAP = 'server/src/bootstrap.ts';

/** Source with comments removed — block, line, and JSDoc alike. */
function code(path) {
  return readFileSync(path, 'utf8')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the check itself works before it is trusted', () => {
  it('strips comments, including the ones naming the old collection', () => {
    const pruner = code(PRUNER);
    assert.ok(readFileSync(PRUNER, 'utf8').includes('_audit_log'),
      'the file should still EXPLAIN the bug in prose — if this fails the comment was deleted and the '
      + 'stripping below is no longer being exercised');
    assert.ok(!pruner.includes('_audit_log'),
      'comment stripping failed: the explanation of the old name is still visible to the matcher');
  });

  it('is reading real source', () => {
    assert.ok(code(WRITER).includes('AUDIT_COLLECTION'), `${WRITER} did not parse as expected`);
    assert.ok(code(PRUNER).includes('redactExpiredChanges'), `${PRUNER} did not parse as expected`);
  });
});

describe('the pruner and the writer cannot disagree about the collection', () => {
  it('the writer EXPORTS the collection name', () => {
    assert.match(code(WRITER), /export const AUDIT_COLLECTION\s*=\s*'audit_log'/,
      'the audit collection name must be exported so there is exactly one copy of it');
  });

  it('the pruner IMPORTS it rather than naming a collection itself', () => {
    const pruner = code(PRUNER);
    assert.match(pruner, /import\s*\{[^}]*AUDIT_COLLECTION[^}]*\}\s*from\s*'\.\/audit\.js'/,
      'change-retention.ts must import the name from audit.ts');
    // The actual rule: no string literal that looks like a collection may be declared here. This is what
    // catches a reintroduction, including a correctly-spelled one — a second copy is the defect, not the
    // typo. `audit_log` spelled right in two files is one rename away from being wrong again.
    const literals = [...pruner.matchAll(/=\s*'([a-z_][a-z0-9_]*)'/g)].map(m => m[1])
      .filter(v => /log|audit|collection/.test(v));
    assert.deepEqual(literals, [],
      `change-retention.ts declares its own collection-ish literal(s): ${literals.join(', ')} — import `
      + 'AUDIT_COLLECTION instead. Two copies that agree today are what produced this bug.');
  });
});

describe('the sweep is wired up and cannot go silent', () => {
  it('bootstrap starts it', () => {
    // I briefly believed this function was never called, because a grep that excluded its own file could
    // not see the caller one scroll below the definition. It is called; this pins that.
    assert.match(code(BOOTSTRAP), /startAuditChangeRetention\s*\(\s*\)/,
      'bootstrap must start the change-retention sweep');
    // Scheduled through the interval job (`Q-317`): a bare `setInterval` here is refused by `every-repeating-timer-is-an-interval-job`.
    assert.match(code(PRUNER), /intervalJob\(\s*'Audit change retention'/, 'the sweep must be scheduled, not one-shot');
  });

  it('reports its first pass even when it redacts nothing', () => {
    // The whole reason this bug survived fourteen releases: a housekeeping sweep that speaks only on
    // success is indistinguishable from one pointed at an empty collection.
    const pruner = code(PRUNER);
    assert.match(pruner, /announced\s*=\s*warnOnce</, 'a once-per-process announcement (a warnOnce, not a boolean) must exist');
    assert.match(pruner, /log\.info\([^)]*COLLECTION/,
      'the announcement must NAME the collection it is sweeping — that is the line that would have shown '
      + "'_audit_log' on day one");
  });

  it('the announcement latch is cleared when the sweep is stopped', () => {
    // Otherwise a second start in the same process is silent, and a test of the second run would be
    // asserting on a latch rather than on behaviour.
    const stop = code(PRUNER).slice(code(PRUNER).indexOf('export function stopAuditChangeRetention'));
    assert.match(stop.slice(0, 300), /announced\.forget\(/,
      'stopAuditChangeRetention must forget the announcement');
  });
});
