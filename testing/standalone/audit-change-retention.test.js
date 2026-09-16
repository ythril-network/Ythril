/**
 * A brain record edit's `changes` outlive nothing but their own short window; the entry outlives them.
 *
 * Owner decision, 2026-07-28: record edits MAY carry old→new values, **with a TTL**. This is that TTL,
 * and the shape of it is the whole point.
 *
 * ── Why this is not just a shorter `_expireAt` ──────────────────────────────────────────────────
 *
 * The obvious implementation — give these entries a nearer expiry and let Mongo's TTL index handle it
 * — deletes the whole DOCUMENT. That takes who / when / route / status with it, shortening the audit
 * TRAIL for exactly the operations the feature exists to make auditable. The trail is the durable
 * part; the content is the sensitive part. They need different lifetimes, so the payload is unset in
 * place and the entry is left alone.
 *
 * The tests below pin that separation, the operation scoping (admin/config changes must NOT expire
 * early — a label an operator set is not user content and is the log's core value), and the fact that
 * redaction is RECORDED rather than silent.
 *
 * Run: node --test testing/standalone/audit-change-retention.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWLEDGE_TYPES } from '../../server/dist/config/types-knowledge.js';

let mod;
before(async () => { mod = await import('../../server/dist/audit/change-retention.js'); });

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

const entry = (over = {}) => ({
  operation: 'fact.update',
  timestamp: at(30),
  changes: [{ field: 'fact', from: 'old', to: 'new' }],
  ...over,
});

describe('which operations expire early', () => {
  it('covers every brain record edit', () => {
    // If a record type is missing here its content silently keeps the FULL 90-day retention — the
    // exact exposure the TTL was granted to prevent, and nothing would report it.
    // Derived for the record edits, NAMED for the two that are not one-per-type: a file's metadata edit and
    // an entity merge have no knowledge type to be generated from, and hiding them inside a derivation would
    // make the set look complete while resting on a coincidence of spelling.
    for (const op of [...KNOWLEDGE_TYPES.map(t => `${t}.update`), 'file.meta.update', 'entity.merge']) {
      assert.ok(mod.RECORD_CHANGE_OPERATIONS.includes(op), `${op} must expire early`);
    }
  });

  it('leaves admin and config changes alone', () => {
    // A label, a cron schedule or a `requireSignedVotes` boolean is what an operator set, not user
    // content. Expiring those early would degrade the audit log's core value to fix a problem they
    // do not have.
    for (const op of ['space.update', 'space.rename', 'token.update', 'network.update',
      'config.media.update', 'data.backup_config.update', 'data.maintenance.toggle']) {
      assert.equal(mod.RECORD_CHANGE_OPERATIONS.includes(op), false,
        `${op} must keep the full audit retention`);
    }
  });
});

describe('the redaction decision', () => {
  const cutoff = mod0 => mod0.changesCutoff(NOW, 14);

  it('redacts a record edit older than the window', () => {
    assert.equal(mod.shouldRedact(entry({ timestamp: at(30) }), cutoff(mod)), true);
  });

  it('leaves a record edit inside the window', () => {
    assert.equal(mod.shouldRedact(entry({ timestamp: at(3) }), cutoff(mod)), false);
  });

  it('never redacts an admin change, however old', () => {
    assert.equal(
      mod.shouldRedact(entry({ operation: 'space.update', timestamp: at(3650) }), cutoff(mod)),
      false, 'admin changes keep the full retention regardless of age');
  });

  it('is a no-op on an entry that was already redacted', () => {
    // Re-sweeping must not keep reporting work it is not doing.
    //
    // NOTE the fixture keeps `changes` PRESENT. The first version omitted it, so the later
    // "no changes to redact" guard returned false regardless and the test passed with the
    // already-redacted check deleted — it asserted nothing about the flag it was named for.
    assert.equal(
      mod.shouldRedact(entry({ timestamp: at(30), changesRedacted: true }), cutoff(mod)),
      false, 'the changesRedacted flag alone must stop a re-sweep');
  });

  it('is a no-op on an entry that never had changes', () => {
    assert.equal(mod.shouldRedact({ operation: 'fact.update', timestamp: at(30) }, cutoff(mod)), false);
  });

  it('does not redact on a missing timestamp rather than treating it as ancient', () => {
    // Fail-closed the safe way round: an entry with no timestamp is a data problem, and silently
    // stripping its content would destroy the evidence of that problem.
    assert.equal(mod.shouldRedact(entry({ timestamp: undefined }), cutoff(mod)), false);
  });

  it('treats an unknown operation as not-a-record-edit', () => {
    assert.equal(mod.shouldRedact(entry({ operation: 'something.new' }), cutoff(mod)), false);
  });
});

describe('the retention window', () => {
  it('defaults to 14 days', () => {
    assert.equal(mod.DEFAULT_RECORD_CHANGE_RETENTION_DAYS, 14);
    assert.equal(mod.recordChangeRetentionDays(), 14, 'falls back to the default outside a loaded config');
  });

  it('computes the cutoff from the window, not from a fixed constant', () => {
    assert.equal(mod.changesCutoff(NOW, 14).getTime(), NOW - 14 * DAY);
    assert.equal(mod.changesCutoff(NOW, 1).getTime(), NOW - 1 * DAY);
    assert.equal(mod.changesCutoff(NOW, 90).getTime(), NOW - 90 * DAY);
  });

  it('the boundary is strict — exactly at the cutoff is kept', () => {
    const c = mod.changesCutoff(NOW, 14);
    assert.equal(mod.shouldRedact(entry({ timestamp: c.toISOString() }), c), false);
    assert.equal(mod.shouldRedact(entry({ timestamp: new Date(c.getTime() - 1).toISOString() }), c), true);
  });
});

describe('the scheduler', () => {
  it('start and stop are idempotent', () => {
    assert.doesNotThrow(() => { mod.startAuditChangeRetention(); mod.startAuditChangeRetention(); });
    assert.doesNotThrow(() => { mod.stopAuditChangeRetention(); mod.stopAuditChangeRetention(); });
  });

  it('is started by bootstrap — a sweep nobody calls is the failure this repo keeps hitting', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../server/src/bootstrap.ts', import.meta.url), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.match(src, /startAuditChangeRetention\(\)/,
      'bootstrap must start the sweep; an unstarted sweep leaves record content for the full 90 days');
  });
});
