/**
 * `takeSlot(family, callerKey)` holds each family to its own budget, per instance and per caller, and a release is idempotent (bundle-271,
 * Q-756; r2 R4.6). The export took the first family (`export/export-slots.ts`); SPARQL and the Linked Data reads take `sparql`.
 *
 * ## What it prevents
 *
 * - **One door starving another.** Two exports running must not refuse a SPARQL query, nor two queries an export: the counts are per family.
 * - **A double release freeing another caller's slot.** A door releases on every ending (finish, close, error); the second release of one
 *   slot must change nothing.
 * - **A family nobody declared.** A misspelt family would be a budget of its own with no bound; it throws.
 *
 * ## Seen red
 *
 * On 2bfffd806: `server/src/util/slots.ts` does not exist. Mutation (seen red once it does): one counter shared by every family.
 *
 * Run: node --test testing/standalone/a-slot-family-holds-its-own-budget.test.js (a prior `npm run build:server`).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let slots, exportSlots;

describe('each slot family holds its own budget', () => {
  before(async () => {
    slots = await loadDistModule('../../server/dist/util/slots.js', import.meta.url);
    exportSlots = await loadDistModule('../../server/dist/export/export-slots.js', import.meta.url);
  });

  it('sparql: two at once on the instance and one per caller; a freed slot is taken again', () => {
    const { takeSlot, SLOT_FAMILIES } = needModule(slots, ['takeSlot', 'SLOT_FAMILIES'], 'the slot families');
    assert.equal(SLOT_FAMILIES.sparql.instance, 2);
    assert.equal(SLOT_FAMILIES.sparql.perCaller, 1);
    const a = takeSlot('sparql', 'caller-a');
    assert.ok(a, 'the first slot was refused');
    assert.equal(takeSlot('sparql', 'caller-a'), null, 'a second slot for one caller was given');
    const b = takeSlot('sparql', 'caller-b');
    assert.ok(b, 'a second caller was refused while the instance had room');
    assert.equal(takeSlot('sparql', 'caller-c'), null, 'a third slot was given on the instance');
    a.release();
    const c = takeSlot('sparql', 'caller-c');
    assert.ok(c, 'a freed slot was not taken again');
    b.release(); c.release();
  });

  it('a release is idempotent: a second release frees no other caller\'s slot', () => {
    const { takeSlot } = needModule(slots, ['takeSlot'], 'the slot families');
    const a = takeSlot('sparql', 'caller-a');
    const b = takeSlot('sparql', 'caller-b');
    a.release(); a.release();
    const c = takeSlot('sparql', 'caller-c');
    assert.ok(c, 'the freed slot was not given');
    assert.equal(takeSlot('sparql', 'caller-d'), null, 'the double release freed a second slot');
    b.release(); c.release();
  });

  it('the families count apart: a full sparql family refuses no export, and a full export family no query', () => {
    const { takeSlot } = needModule(slots, ['takeSlot'], 'the slot families');
    const { takeExportSlot } = needModule(exportSlots, ['takeExportSlot'], 'the export slots');
    const q = [takeSlot('sparql', 'q1'), takeSlot('sparql', 'q2')];
    assert.ok(q.every(Boolean));
    const e = [takeExportSlot('e1'), takeSlot('export', 'e2')];
    assert.ok(e.every(Boolean), 'a full sparql family refused an export');
    assert.equal(takeExportSlot('e3'), null, 'the export family took a third slot');
    for (const s of [...q, ...e]) s.release();
    const again = takeSlot('sparql', 'q3');
    assert.ok(again, 'releasing exports left the sparql family full');
    again.release();
  });

  it('a family nobody declared throws, never a budget of its own', () => {
    const { takeSlot } = needModule(slots, ['takeSlot'], 'the slot families');
    assert.throws(() => takeSlot('spqrql', 'x'), /spqrql/);
  });
});
