/**
 * Every local-only field is classified on purpose — record tier or derived — and `deliveredBy` is record tier.
 *
 * ## The rule
 *
 * `sync/local-only-fields.ts` holds one list (`LOCAL_ONLY_FIELDS`) with two halves: the RECORD tier (`RESTORED_LOCAL_FIELDS`
 * — this instance's own state about a record, kept by a restore of its own backup) and the DERIVED half (everything this
 * instance computed with its own model). The module derives the second half as "whatever the first does not name", so
 * a field added to the list and named nowhere else is DERIVED BY DEFAULT: dropped by a restore, `$unset` with the vectors
 * whenever a record's content changes (`UNSET_DERIVED`). For an embedding that is right. For a stamp recording who
 * delivered a record it is a silent loss of the one fact the upstream deletion ground stands on — the stamp would vanish
 * the first time a record's text changed, and the upstream could never again delete it.
 *
 * So the default is not allowed to decide. Each name in `LOCAL_ONLY_FIELDS` is EITHER in `RESTORED_LOCAL_FIELDS` OR in
 * the explicit list below, with the reason it is derived. Adding a field means writing which — here, where a reviewer
 * reads it.
 *
 * `deliveredBy` (bundle-51, D-14) is the record-tier field that this gate was written for: in both sets, never in the
 * derived one, never `$unset` by a content change, dropped from every arrival and from what is served to a peer,
 * carried by every write that replaces a record, and kept by a restore.
 *
 * ## Mutation that turns it red
 *
 * Add a seventh name to `LOCAL_ONLY_FIELDS` and to neither half: the first test names it. Remove `deliveredBy` from
 * `RESTORED_LOCAL_FIELDS`: it falls into `DERIVED_LOCAL_FIELDS`, and the second test and the `UNSET_DERIVED` row go red.
 * Leave a name in the reasoned list below after removing it from the module: the stale-reason test names it.
 *
 * Run: node --test testing/standalone/every-local-only-field-is-classified-on-purpose.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

/**
 * The fields this instance DERIVES, each with why a restore must not take them and a content change must clear them.
 * The only hand-written list in the rule: a field is derived because somebody said so here, never because it was left out.
 */
const DERIVED_ON_PURPOSE = new Map([
  ['embedding', 'computed by this instance\'s own model; ranking one model\'s vectors against another\'s returns plausible results in the wrong order'],
  ['embeddingModel', 'names the model that made `embedding`; meaningless without it, wrong the moment the vector is recomputed'],
  ['matchedText', 'the snippet a query matched — an artefact of a search, not content, and the lexical channel\'s copy of text the record may no longer have'],
]);

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/sync/local-only-fields.js', import.meta.url); });
const fields = () => needModule(loaded, [
  'LOCAL_ONLY_FIELDS', 'RESTORED_LOCAL_FIELDS', 'DERIVED_LOCAL_FIELDS', 'UNSET_DERIVED', 'LOCAL_ONLY_EXCLUSION', 'carriedFields', 'stripLocalOnly',
], 'local-only fields');

/**
 * The write-guard class (`Q-439`), tolerated as absent here so the older rows keep their own reasons to fail; the class
 * is REQUIRED by the describe at the foot of this file.
 */
const writeGuard = () => loaded.mod?.WRITE_GUARD_FIELDS ?? new Set();

describe('every local-only field is classified on purpose', () => {
  it('names each as record tier (restored) or as derived with a reason — nothing is derived by being left out', () => {
    const { LOCAL_ONLY_FIELDS, RESTORED_LOCAL_FIELDS } = fields();
    assert.ok(LOCAL_ONLY_FIELDS.size >= 6, `only ${LOCAL_ONLY_FIELDS.size} local-only fields were read`);
    const guard = writeGuard();
    const unclassified = [...LOCAL_ONLY_FIELDS].filter(f => !RESTORED_LOCAL_FIELDS.has(f) && !DERIVED_ON_PURPOSE.has(f) && !guard.has(f));
    assert.deepEqual(unclassified, [],
      `local-only field(s) ${unclassified.join(', ')} are in none of RESTORED_LOCAL_FIELDS, WRITE_GUARD_FIELDS and DERIVED_ON_PURPOSE in this test — `
      + 'the module would call them derived by default, drop them on a restore and `$unset` them on every content change. '
      + 'Decide which half each belongs to, and write the reason here if it is derived.');
  });

  it('no field is claimed by both halves', () => {
    const { RESTORED_LOCAL_FIELDS } = fields();
    assert.deepEqual([...RESTORED_LOCAL_FIELDS].filter(f => DERIVED_ON_PURPOSE.has(f)), []);
  });

  it('a reason names a field that is still local-only (a removed field leaves no stale reason behind)', () => {
    const { LOCAL_ONLY_FIELDS } = fields();
    assert.deepEqual([...DERIVED_ON_PURPOSE.keys()].filter(f => !LOCAL_ONLY_FIELDS.has(f)), []);
  });

  it('the module\'s derived half is exactly the reasoned list here', () => {
    const { DERIVED_LOCAL_FIELDS } = fields();
    assert.deepEqual([...DERIVED_LOCAL_FIELDS].sort(), [...DERIVED_ON_PURPOSE.keys()].sort());
  });
});

describe('deliveredBy is a record-tier local field', () => {
  it('is local-only and restored, and is not derived', () => {
    const { LOCAL_ONLY_FIELDS, RESTORED_LOCAL_FIELDS, DERIVED_LOCAL_FIELDS } = fields();
    assert.ok(LOCAL_ONLY_FIELDS.has('deliveredBy'), 'deliveredBy is not in LOCAL_ONLY_FIELDS: it would be hashed and served to peers');
    assert.ok(RESTORED_LOCAL_FIELDS.has('deliveredBy'), 'deliveredBy is not in RESTORED_LOCAL_FIELDS: a restore of this instance\'s own backup would lose who delivered every record');
    assert.ok(!DERIVED_LOCAL_FIELDS.has('deliveredBy'), 'deliveredBy is in DERIVED_LOCAL_FIELDS');
  });

  it('a content change does not clear it (`UNSET_DERIVED` never names it)', () => {
    const { UNSET_DERIVED } = fields();
    assert.equal('deliveredBy' in UNSET_DERIVED, false);
    assert.ok(Object.keys(UNSET_DERIVED).length >= 3, 'UNSET_DERIVED lost the vector fields it exists for');
  });

  it('is left out of what is served to a peer (the sending projection) and stripped from a document', () => {
    const { LOCAL_ONLY_EXCLUSION, stripLocalOnly } = fields();
    assert.equal(LOCAL_ONLY_EXCLUSION.deliveredBy, 0);
    assert.deepEqual(stripLocalOnly({ _id: 'x', deliveredBy: 'inst-up', fact: 'f' }), { _id: 'x', fact: 'f' });
  });

  it('is carried across an ordinary arrival and a suppressed one, and across no restore', () => {
    const { carriedFields } = fields();
    assert.ok(carriedFields({ restore: false, suppressed: false }).has('deliveredBy'), 'an ordinary arrival replaces the record and must keep the stamp the writer sets after it');
    assert.ok(carriedFields({ restore: false, suppressed: true }).has('deliveredBy'));
    assert.equal(carriedFields({ restore: true, suppressed: false }).has('deliveredBy'), false,
      'a restore carries nothing from the copy it replaces; the backup\'s own record-tier half is kept through RESTORED_LOCAL_FIELDS');
  });
});

/**
 * The third class (`Q-439`): `WRITE_GUARD_FIELDS`. `_functionalGuard` is the marker the unique partial index on a space's
 * edges collection collides on. It is local to this instance, so it is hashed nowhere, sent to no peer and taken from no
 * arrival — and it is NEITHER half of the older split. Not restored: an export or restore that carried it could bring a second
 * marker for one subject, or a marker for an edge since relabelled, and a phantom holds the subject's slot for ever. Not
 * derived: `UNSET_DERIVED` clears every derived field when content changes, and an embed must never touch the guard.
 * Left to the "default is derived" rule it would be dropped by exactly the writers that must keep it, so it is named.
 *
 * Mutation: add `_functionalGuard` to `RESTORED_LOCAL_FIELDS` (red: disjointness, restore row); leave it out of
 * `WRITE_GUARD_FIELDS` but in `LOCAL_ONLY_FIELDS` (red: the partition row, and it is derived by default).
 */
describe('the write-guard class: local, never restored, never derived', () => {
  const guardFields = () => needModule(loaded, ['WRITE_GUARD_FIELDS'], 'the write-guard class').WRITE_GUARD_FIELDS;

  it('WRITE_GUARD_FIELDS is exported and names `_functionalGuard`', () => {
    const guard = guardFields();
    assert.ok(guard.size >= 1, 'WRITE_GUARD_FIELDS is empty');
    assert.ok(guard.has('_functionalGuard'), 'the functional guard marker is not in WRITE_GUARD_FIELDS');
  });

  it('every write-guard field is local-only', () => {
    const { LOCAL_ONLY_FIELDS } = fields();
    assert.deepEqual([...guardFields()].filter(f => !LOCAL_ONLY_FIELDS.has(f)), [],
      'a write-guard field outside LOCAL_ONLY_FIELDS is hashed and replicated: two instances would hold different markers');
  });

  it('is disjoint from the restored half, the derived half and the reasoned derived list', () => {
    const { RESTORED_LOCAL_FIELDS, DERIVED_LOCAL_FIELDS } = fields();
    const guard = guardFields();
    assert.deepEqual([...guard].filter(f => RESTORED_LOCAL_FIELDS.has(f)), [], 'a restore would bring the marker back from a backup');
    assert.deepEqual([...guard].filter(f => DERIVED_LOCAL_FIELDS.has(f)), [], 'the marker would be unset with the vectors');
    assert.deepEqual([...guard].filter(f => DERIVED_ON_PURPOSE.has(f)), []);
  });

  it('restored, derived and write-guard together are exactly the local-only fields, each in one class', () => {
    const { LOCAL_ONLY_FIELDS, RESTORED_LOCAL_FIELDS, DERIVED_LOCAL_FIELDS } = fields();
    const guard = guardFields();
    const all = [...RESTORED_LOCAL_FIELDS, ...DERIVED_LOCAL_FIELDS, ...guard];
    assert.equal(new Set(all).size, all.length, 'a field is in two classes');
    assert.deepEqual([...new Set(all)].sort(), [...LOCAL_ONLY_FIELDS].sort());
  });

  it('is left out of what is served to a peer, stripped from a document, and never cleared by a content change', () => {
    const { LOCAL_ONLY_EXCLUSION, stripLocalOnly, UNSET_DERIVED } = fields();
    assert.equal(LOCAL_ONLY_EXCLUSION._functionalGuard, 0);
    assert.deepEqual(stripLocalOnly({ _id: 'e', _functionalGuard: 'k', label: 'reports_to' }), { _id: 'e', label: 'reports_to' });
    assert.equal('_functionalGuard' in UNSET_DERIVED, false);
  });

  it('is kept by no restore: a restore carries nothing from the replaced copy, and the backup\'s record tier excludes it', () => {
    const { carriedFields, RESTORED_LOCAL_FIELDS } = fields();
    assert.equal(RESTORED_LOCAL_FIELDS.has('_functionalGuard'), false);
    assert.equal(carriedFields({ restore: true, suppressed: false }).has('_functionalGuard'), false);
  });
});
