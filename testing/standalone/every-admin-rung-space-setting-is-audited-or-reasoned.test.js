/**
 * A space setting that can start refusing writes, or delete records, leaves an audit change when it is edited (Q-320,
 * bundle-128, design-v3 section 1.4 and 8.2 G12).
 *
 * ## The rule
 *
 * `SPACE_FIELD_RIGHTS` puts a field at the `admin` rung when changing it alters what succeeds for every caller in the space, and
 * `AUDIT_CHANGE_FIELDS['space.update']` is what an operator reads afterwards to learn that happened. The new
 * `unknownWriteFields` is exactly such a field (Warn -> Refuse turns writes that succeeded into 400s), and an audit entry that says
 * only "an admin patched the space" would not say so. So every `admin`-rung key, with `meta.` stripped, is in the allowlist or has
 * a reasoned exemption here. Floor on the derived set, and an exemption that has since been closed must leave the list.
 *
 * ## Existing gaps this derivation finds
 *
 * Four admin-rung fields are not in the allowlist on the unchanged base. They are listed as exemptions with `ticket: 'unfiled'`
 * (design-v3 1.4: "or has a reasoned exemption"); `meta.rules` has a real reason (its value is a list of objects, and the
 * allowlist records scalars and member lists), the other three are scalar settings the allowlist simply does not name yet. The
 * caller decides whether to fix or file them.
 *
 * Seen red on the unchanged base: the new `unknownWriteFields` row and its allowlist entry do not exist.
 *
 * Run: node --test testing/standalone/every-admin-rung-space-setting-is-audited-or-reasoned.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { SPACE_FIELD_RIGHTS } = await import('../../server/dist/auth/space-field-rights.js');
const { AUDIT_CHANGE_FIELDS } = await import('../../server/dist/audit/audit-changes.js');

/** Admin-rung settings the audit allowlist does not name, each with why (or the ticket still to be filed). */
const EXEMPT = new Map([
  ['rules', { ticket: null, why: 'its value is a list of rule objects, and the allowlist records scalars and member lists only' }],
  ['suppressEmbeddings', { ticket: 'unfiled', why: 'a scalar the allowlist does not name yet; it stops embedding space-wide' }],
  ['recordTtlDays', { ticket: 'unfiled', why: 'a scalar the allowlist does not name yet; it deletes records on a clock' }],
  ['faceDescriptorDims', { ticket: 'unfiled', why: 'a scalar the allowlist does not name yet; changing it invalidates stored descriptors' }],
]);

const adminRung = Object.entries(SPACE_FIELD_RIGHTS)
  .filter(([, v]) => typeof v === 'object' && v.needs === 'admin')
  .map(([k]) => k.replace(/^meta\./, ''));

describe('every admin-rung space setting is in the space.update audit allowlist or reasoned', () => {
  const allow = new Set((AUDIT_CHANGE_FIELDS['space.update'] ?? []).map(f => f.split('.')[0]));

  it('derives its subjects, with a floor', () => {
    assert.ok(adminRung.length >= 6, `only ${adminRung.length} admin-rung keys were derived — the table was not read`);
    assert.ok(allow.size >= 4, 'the space.update allowlist was not read');
  });

  it('the new setting is an admin-rung key (a table without the row would pass about it)', () => {
    assert.ok(adminRung.includes('unknownWriteFields'), 'SPACE_FIELD_RIGHTS has no admin-rung `unknownWriteFields` row');
  });

  it('each one is audited, or exempt with a reason', () => {
    const missing = adminRung.filter(k => !allow.has(k) && !EXEMPT.has(k));
    assert.deepEqual(missing, [], 'a space setting that changes what succeeds is edited with no audit change recorded');
  });

  it('the new setting is audited, not exempt', () => {
    assert.ok(allow.has('unknownWriteFields'), 'AUDIT_CHANGE_FIELDS[\'space.update\'] does not list unknownWriteFields');
    assert.equal(EXEMPT.has('unknownWriteFields'), false);
  });

  it('every exemption is still a gap (a closed one leaves the list)', () => {
    const stale = [...EXEMPT.keys()].filter(k => !adminRung.includes(k) || allow.has(k));
    assert.deepEqual(stale, [], 'these exemptions no longer describe a gap');
  });
});