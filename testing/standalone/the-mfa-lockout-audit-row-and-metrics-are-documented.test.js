/**
 * A lock start leaves an audit row and two counters, and each is named where an operator looks for it (Q-694, bundle-233).
 *
 * ## The defect it prevents
 *
 * A lock that starts is the one signal that somebody holding an admin token (or an address) is guessing second-factor codes. The
 * route's own 429 is written to the log by the audit middleware with no token (the refusal runs before the token is attached), and
 * `POST /api/mfa/verify` is deliberately not a rule, so without its own row an operator reading the audit log sees no lockout at all; and a
 * metric that is exposed but not in the setup guide is one nobody alerts on. Both existing sweeps would cover the names once they exist
 * (`every-audited-operation-is-documented` derives the operations from the module's `*_OPERATION` exports; `metric-docs-coverage` derives
 * the metrics from the registry): this file pins that they DO exist, and the three things the sweeps cannot know.
 *
 * ## What it holds
 *
 * - `audit/middleware.ts` exports `MFA_LOCKED_OPERATION = 'mfa.locked'` (so the sweep above sees it), and the operations table of
 *   `13-audit-log-api.md` has a row for `mfa.locked` that says it carries the token id and the address; the page no longer says an
 *   MFA code check "changes nothing" without the lockout beside it.
 * - The client's audit-log operation filter lists `mfa.locked`, beside `auth.failed`.
 * - The registry declares `ythril_mfa_lockouts_total` (labelled `key`) and `ythril_mfa_lockout_evictions_total`, and
 *   `11-setup-api.md` has a table row for each; the lockouts row carries the alert sentence (alert on a rise, revoke the token) and the
 *   evictions row says what a count means (a failure that was not recorded because the table was full of running locks).
 *
 * ## Seen red
 *
 * On the base none of the names exists.
 *
 * Run: node --test testing/standalone/the-mfa-lockout-audit-row-and-metrics-are-documented.test.js
 * (requires a prior `npm run build -w server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const AUDIT_GUIDE = readFileSync('docs/integration-guide/13-audit-log-api.md', 'utf8');
const SETUP_GUIDE = readFileSync('docs/integration-guide/11-setup-api.md', 'utf8');
const rowOf = (text, name) => text.split('\n').find(l => l.startsWith('|') && l.includes(`\`${name}\``));

describe('the lockout is auditable and observable', () => {
  it('the audit module exports MFA_LOCKED_OPERATION = mfa.locked', async () => {
    const mod = await import('../../server/dist/audit/middleware.js');
    assert.equal(mod.MFA_LOCKED_OPERATION, 'mfa.locked', 'audit/middleware.ts does not export MFA_LOCKED_OPERATION');
  });

  it('13-audit-log-api.md has a table row for mfa.locked that names its token id and address', () => {
    const row = rowOf(AUDIT_GUIDE, 'mfa.locked');
    assert.ok(row, 'the operations table has no row for `mfa.locked`');
    assert.match(row, /token/i, 'the row does not say it names the token');
    assert.match(row, /address|\bip\b/i, 'the row does not say it names the address');
  });

  it('13-audit-log-api.md no longer says a code check changes nothing and is not logged without the lockout', () => {
    const paragraph = AUDIT_GUIDE.split(/\n\s*\n/).find(p => /POST \/api\/mfa\/verify/.test(p));
    assert.ok(paragraph, 'the audit guide no longer mentions POST /api/mfa/verify');
    assert.match(paragraph, /mfa\.locked|lock/i, 'the paragraph on /api/mfa/verify says nothing of the lockout row');
  });

  it('the client audit-log operation filter lists mfa.locked', () => {
    const src = stripComments(readFileSync('client/src/app/pages/settings/audit-log.component.ts', 'utf8'));
    assert.match(src, /'mfa\.locked'/, "the client's operation filter has no 'mfa.locked'");
  });

  it('the registry declares both counters, the first by key', () => {
    const registry = stripComments(readFileSync('server/src/metrics/registry.ts', 'utf8'));
    const lockouts = /name:\s*'ythril_mfa_lockouts_total'[\s\S]{0,400}?labelNames:\s*\[\s*'key'\s*\]/.exec(registry);
    assert.ok(lockouts, "ythril_mfa_lockouts_total is not declared with labelNames: ['key']");
    assert.match(registry, /name:\s*'ythril_mfa_lockout_evictions_total'/, 'ythril_mfa_lockout_evictions_total is not declared');
  });

  it('11-setup-api.md has a row for each counter, with the alert sentence and the meaning of an eviction', () => {
    const lockouts = rowOf(SETUP_GUIDE, 'ythril_mfa_lockouts_total');
    const evictions = rowOf(SETUP_GUIDE, 'ythril_mfa_lockout_evictions_total');
    assert.ok(lockouts, 'no row for ythril_mfa_lockouts_total in the metrics table');
    assert.ok(evictions, 'no row for ythril_mfa_lockout_evictions_total in the metrics table');
    assert.match(lockouts, /alert/i, 'the lockouts row has no alert sentence');
    assert.match(lockouts, /revoke/i, 'the lockouts row does not say to revoke the token');
    assert.match(lockouts, /`key`|\bkey\b/, 'the lockouts row does not name its key label');
    assert.match(evictions, /not recorded|dropped|full/i, 'the evictions row does not say what a count means');
  });
});
