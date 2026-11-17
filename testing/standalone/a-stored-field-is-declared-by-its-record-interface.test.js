/**
 * Every field the store keeps on a record family is declared by that family's interface in `server/src/config`.
 *
 * ## The defect it prevents (Q-797)
 *
 * The export/import round trip (`an-import-restores-what-the-export-wrote-db.test.js`) seeds and compares the fields each family's INTERFACE
 * declares, and nothing else. A field the store keeps and the interface does not declare is therefore a field no backup test covers: the
 * export can drop it and the restore can lose it with that test green. At main 327b105e that was `forkOf` on entities, edges and chrono
 * entries, `forkAt` on all four forking families (it was declared on none), and, on a file row, `_expireAt` and `syncBase`, both of which
 * the import keeps (`RESTORED_LOCAL_FIELDS`).
 *
 * ## What "the store keeps" is, derived and never listed here
 *
 *  - **The wire keys**: every key of the family's `Incoming*` schema (`INCOMING_SCHEMA_OF`, read from the built module). What a peer may
 *    send is what the store keeps, so a field the schema carries and the interface lacks fails.
 *  - **The record-tier local state a restore keeps**: every name of `RESTORED_LOCAL_FIELDS`. Each is classified for the families it applies
 *    to: `_expireAt` for every family that has a record type (a link carries no retention), taken from `RECORD_COLLECTION`; the others in
 *    `STATE_OF_FAMILY` below, where an unclassified name fails, so a new restored field is placed on purpose.
 *
 * The interface's fields are read the way the compiler assembles them (`_record-doc-fields.mjs`: own members, `extends`, augmentation).
 * What is declared on no interface by choice is in `a-stored-field-is-declared-by-its-record-interface.allow.json`, each entry with its
 * reason and review date; the count of exceptions is in this file's output.
 *
 * Run: node --test testing/standalone/a-stored-field-is-declared-by-its-record-interface.test.js (needs a built server/dist)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordDocFields } from './_record-doc-fields.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./a-stored-field-is-declared-by-its-record-interface.allow.json', import.meta.url), 'utf8')).entries;

/** The interface that declares each replicated family's stored document, keyed by collection. The key set is checked against the registry. */
const DOC_OF = { facts: 'FactDoc', entities: 'EntityDoc', edges: 'EdgeDoc', chrono: 'ChronoEntry', links: 'LinkDoc', files: 'FileMetaDoc' };

/**
 * Where each record-tier local field is kept, by family, stated by hand as the rule's expected outcome (the registry cannot say which family a
 * stamp belongs to). `'record-typed'` is every family with a record type, read from `RECORD_COLLECTION`. A name of `RESTORED_LOCAL_FIELDS` in
 * neither this table nor the allow file fails.
 */
const STATE_OF_FAMILY = {
  _expireAt: 'record-typed',
  _contentExpireAt: ['chrono'],
  syncBase: ['files'],
};

/** The fields the family's interface must declare and does not: `[{ field, why }]`. The one reading of the rule; the planted cases below run it too. */
function undeclared(declared, expected) {
  return expected.filter(e => !declared.has(e.field)).map(e => `${e.field} (${e.why})`);
}

let families, recordTypeOf, incomingOf, restored, wireControl;

before(async () => {
  ({ REPLICATED_FAMILIES: families } = await import('../../server/dist/sync/replicated-families.js'));
  const kinds = await import('../../server/dist/config/types-knowledge.js');
  ({ INCOMING_SCHEMA_OF: incomingOf } = await import('../../server/dist/sync/incoming-schemas.js'));
  ({ RESTORED_LOCAL_FIELDS: restored } = await import('../../server/dist/sync/local-only-fields.js'));
  ({ FILE_META_WIRE_CONTROL_KEYS: wireControl } = await import('../../server/dist/api/sync/_shared.js'));
  assert.ok(wireControl.includes('authoredKeys'), 'the wire control keys no longer name authoredKeys: re-anchor this read');
  recordTypeOf = Object.fromEntries(families.map(f => [f.collection,
    Object.entries(kinds.RECORD_COLLECTION).find(([, c]) => c === f.collection)?.[0] ?? null]));
});

/** What the store keeps on one family, derived: `[{ field, why }]`. */
function expectedOf(family) {
  const out = [];
  const wire = incomingOf[family.payloadKey];
  assert.ok(wire, `family '${family.payloadKey}' has no Incoming schema in INCOMING_SCHEMA_OF`);
  // A wire CONTROL key is consumed at admission and never stored (`authoredKeys`), so no interface declares it: the module that consumes it says which.
  const control = family.payloadKey === 'filemeta' ? wireControl : [];
  for (const k of Object.keys(wire.schema.shape)) if (!control.includes(k)) out.push({ field: k, why: `a key of ${wire.name}` });
  for (const f of restored) {
    if (ALLOW.some(a => a.field === f)) continue;
    const where = STATE_OF_FAMILY[f];
    assert.ok(where, `RESTORED_LOCAL_FIELDS names '${f}', which STATE_OF_FAMILY does not place and the allow file does not except: say which families keep it`);
    const keeps = where === 'record-typed' ? recordTypeOf[family.collection] !== null : where.includes(family.collection);
    if (keeps) out.push({ field: f, why: 'kept by a restore, RESTORED_LOCAL_FIELDS' });
  }
  return out;
}

describe('a field the store keeps on a record family is declared by its interface', () => {
  it('the table of interfaces names every replicated family, and no other', () => {
    assert.deepEqual(Object.keys(DOC_OF).sort(), families.map(f => f.collection).sort(), 'DOC_OF and the replicated families differ: place the new family');
    assert.ok(families.length >= 6, `only ${families.length} replicated families: the registry moved`);
  });

  it('every wire key and every kept local field of every family is declared by its interface', () => {
    const wrong = [];
    for (const family of families) {
      const declared = new Set(recordDocFields(DOC_OF[family.collection]).map(f => f.name));
      assert.ok(declared.size >= 11, `${DOC_OF[family.collection]}: only ${declared.size} fields read, the reader or the type moved`);
      for (const miss of undeclared(declared, expectedOf(family))) wrong.push(`${DOC_OF[family.collection]} does not declare ${miss}`);
    }
    assert.deepEqual(wrong, [], 'the round trip covers only the fields an interface declares, so each of these is a field a backup may drop with every test green');
  });

  it('an exception names a field of the restored set, with a reason and a review date, and still holds', () => {
    const bad = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const e of ALLOW) {
      if (!restored.has(e.field)) bad.push(`${e.field}: not a name of RESTORED_LOCAL_FIELDS, so nothing needs the exception`);
      if (typeof e.reason !== 'string' || e.reason.trim().split(/\s+/).length < 3) bad.push(`${e.field}: needs a reason of three words or more`);
      if (typeof e.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy) || Number.isNaN(Date.parse(e.reviewBy))) bad.push(`${e.field}: needs a reviewBy date (YYYY-MM-DD)`);
      else if (e.reviewBy < today) bad.push(`${e.field}: past its reviewBy ${e.reviewBy}`);
      const declaredAnywhere = families.some(f => recordDocFields(DOC_OF[f.collection]).some(d => d.name === e.field));
      if (declaredAnywhere) bad.push(`${e.field}: now declared by an interface, so the exception is stale: remove it`);
    }
    assert.deepEqual(bad, []);
    console.log(`# a-stored-field-is-declared-by-its-record-interface: ${ALLOW.length} exception(s)`);
  });

  it('PLANT: the rule reports a field taken off a real family\'s declared set, for every expected field', () => {
    // The plant is a copy of the real declaration with one expected field removed, for each family and each field; the rule must name exactly it.
    for (const family of families) {
      const real = new Set(recordDocFields(DOC_OF[family.collection]).map(f => f.name));
      const already = undeclared(real, expectedOf(family));
      for (const e of expectedOf(family)) {
        if (!real.has(e.field)) continue; // already reported by the case above
        const planted = new Set(real);
        planted.delete(e.field);
        const added = undeclared(planted, expectedOf(family)).filter(r => !already.includes(r));
        assert.deepEqual(added, [`${e.field} (${e.why})`], `${DOC_OF[family.collection]} without ${e.field}: the rule newly reported ${JSON.stringify(added)}`);
      }
    }
  });
});
