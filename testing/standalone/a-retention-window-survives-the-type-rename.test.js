/**
 * An operator's retention window keeps applying after `memory` became `fact`.
 *
 * ## The failure this prevents, and why it is silent
 *
 * `recordTtlDays: { fact: 30 }` on a space says "delete these after thirty days". 5.0 renamed the
 * knowledge type, so the key is read under a name nothing writes any more: the window stops applying and
 * the records it governed are kept FOR EVER.
 *
 * No error, no warning, no metric — the same shape as the collection rename this rides beside, and the
 * reason both are boot migrations rather than a line in the release notes. A note is read by the operators
 * who read notes; a disk filling up over months is noticed by everyone, much later, when the cause is gone.
 *
 * Run: node --test testing/standalone/a-retention-window-survives-the-type-rename.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let migrateMemoryToFact;
before(async () => {
  ({ migrateMemoryToFact } = await import('../../server/dist/config/migrate-memory-to-fact.js'));
});

const space = (id, recordTtlDays) => ({ id, label: id, recordTtlDays });

describe('the per-kind window moves with the type', () => {
  it('renames memory to fact and keeps the number', () => {
    const s = space('a', { memory: 30, chrono: 90 });
    const out = migrateMemoryToFact([s]);
    assert.deepEqual(s.recordTtlDays, { fact: 30, chrono: 90 });
    assert.deepEqual(out.ttlWindows, ['a']);
  });

  it('leaves the legacy SCALAR form alone — it has no per-type keys to rename', () => {
    const s = space('b', 90);
    migrateMemoryToFact([s]);
    assert.equal(s.recordTtlDays, 90, 'a number is the space-wide default, not a bucket map');
  });

  it('is idempotent', () => {
    const s = space('c', { memory: 30 });
    migrateMemoryToFact([s]);
    const second = migrateMemoryToFact([s]);
    assert.deepEqual(second.ttlWindows, [], 'a second boot has nothing left to find');
    assert.deepEqual(s.recordTtlDays, { fact: 30 });
  });

  it('a `fact` somebody already set WINS over the old value', () => {
    // Overwriting it would undo a decision taken on this build rather than complete a migration.
    const s = space('d', { fact: 30, fact: 7 });
    migrateMemoryToFact([s]);
    assert.deepEqual(s.recordTtlDays, { fact: 7 }, 'the deliberate value survives and the stale key goes');
  });

  it('a space with no windows at all is untouched', () => {
    const s = space('e', undefined);
    const out = migrateMemoryToFact([s]);
    assert.equal(s.recordTtlDays, undefined);
    assert.deepEqual(out.ttlWindows, []);
  });
});
