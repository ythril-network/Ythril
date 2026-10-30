/**
 * The docs that enumerate the local-only fields name every field of every class the module declares (`Q-439`).
 *
 * ## The rule
 *
 * `sync/local-only-fields.ts` is the one list, and the docs re-state it for a reader who will never open the module:
 * `docs/integration-guide/09-sync-api.md` (what the hash leaves out), `docs/integration-guide/12-admin-api.md` (what an
 * export and an import keep), `docs/sync-protocol.md`, and a local `CLAUDE.md` where one still lists them. Each says "the
 * local-only fields are ..." and lists them. A field added to the module is then missing from sentences nobody re-reads, and the reader of one of them
 * designs around a list that is one field short — the failure the plan's documentation lens named.
 *
 * The classes are the module's: the RESTORED half (this instance's own state about a record), the DERIVED half (what its
 * model computed) and the WRITE GUARD (`WRITE_GUARD_FIELDS`: `_functionalGuard`, local, never restored, never derived).
 * One test per class, so a failure says which class a doc is behind on, and each names which doc lacks which field.
 *
 * ## What is derived
 *
 * - **The fields** come from the module (`RESTORED_LOCAL_FIELDS`, `DERIVED_LOCAL_FIELDS`, `WRITE_GUARD_FIELDS`), never from
 *   a list here.
 * - **The enumerating docs** are every tracked `.md` under `docs/` and `CLAUDE.md` with a PARAGRAPH that names two or more
 *   restored fields by their literal names. The restored fields are used because the derived trio (`embedding`,
 *   `embeddingModel`, `matchedText`) is also the vocabulary of every API response page, and the record-tier names are
 *   spoken only where local state is being enumerated. The changelog is history and is not read.
 * - **The floor** is the three tracked documents above; a derivation that finds fewer has broken. `CLAUDE.md` is checked
 *   where it enumerates, and not counted on (it is untracked, and may name none).
 *
 * A field counts as named when its LITERAL name appears in the doc: prose such as "the retention stamps" is how the older
 * sentences drifted, and is exactly what a reader cannot grep.
 *
 * ## Bundle-81, decision 28: the classes are DERIVED, not named
 *
 * This file named three classes by hand (restored, derived, write guard) and stayed green with three more added: bundle-81 adds
 * `POSITION_FIELDS` (`pos`, `posAtSeq`) and `TOMBSTONE_LOCAL_FIELDS` (`storedVia`, `issuedHere`, `pos`, `posAtSeq`) to
 * `sync/local-only-fields.ts`, and `ORDER_ONLY_FIELDS` (`pos`) to `brain/recall-shape.ts` (design rev 8 §2, P48). The test now
 * derives EVERY export of the module whose name ends in `_FIELDS` and is a set, asserts a floor on how many it found, holds that
 * the two classes the plan adds are among them, and checks each class against each enumerating doc. A class added next year is
 * owed its sentence the day it is exported. `ORDER_ONLY_FIELDS` lives in the answer-shape module and is read from there.
 *
 * Red on 9a7ab3f7 for the new part: `POSITION_FIELDS` and `TOMBSTONE_LOCAL_FIELDS` are not exported and `ORDER_ONLY_FIELDS` does
 * not exist, so the derivation finds the five classes of today and none of the plan's.
 *
 * ## Seen red
 *
 * Red on 9a4b41c6: `WRITE_GUARD_FIELDS` does not exist and no doc names `_functionalGuard`; and the restored and derived
 * rows already fail for older rot: `CLAUDE.md` lacks `embeddingModel` and `deliveredBy`, `12-admin-api.md` lacks
 * `deliveredBy`, `sync-protocol.md` says "retention stamps" where the names are `_expireAt` and `_contentExpireAt`.
 * Mutation: delete a field name from one doc and the row for its class goes red naming that doc.
 *
 * Run: node --test testing/standalone/the-docs-name-every-local-only-field.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { localRuleSheets } from '../_shared/local-rule-sheets.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

// The three tracked docs below. A local rule sheet is checked when it enumerates the fields and never counted on to: the
// owner's sheet moved its rules to the flow graph and names none of them now (Q-653), so it is neither a doc of the floor
// nor one a clean clone has.
const DOC_FLOOR = 3;
/** The classes the module exports today (restored, derived, write guard, the restored dates, the union): a floor on the derivation. */
const CLASS_FLOOR = 5;

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/sync/local-only-fields.js', import.meta.url); });

/** Whole-word, so `embedding` is not found inside `embeddingModel`. */
const names = (text, field) => new RegExp(String.raw`(?<![\w$])${field.replace(/[$]/g, String.raw`\$`)}(?![\w$])`).test(text);

// The local rule sheet is read beside the listing, not through it: an ignored file is in no git listing (Q-632).
const DOCS = [...trackedSources(['docs'], { ext: ['.md'], floor: 20, untracked: true }), ...localRuleSheets(REPO_ROOT)]
  .map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));

/** The docs with a paragraph naming two or more restored fields. */
function enumeratingDocs(restored) {
  return DOCS.filter(({ text }) => text.split(/\r?\n[ \t]*\r?\n/)
    .some(p => [...restored].filter(f => names(p, f)).length >= 2));
}

/** `doc: field, field` for every enumerating doc that does not name every field of the class. */
function lacking(restored, fields) {
  const docs = enumeratingDocs(restored);
  assert.ok(docs.length >= DOC_FLOOR,
    `only ${docs.length} enumerating doc(s) found (${docs.map(d => d.file).join(', ')}): the derivation is broken, not the docs`);
  return docs
    .map(({ file, text }) => ({ file, missing: [...fields].filter(f => !names(text, f)) }))
    .filter(d => d.missing.length > 0)
    .map(d => `${d.file} does not name ${d.missing.join(', ')}`);
}

describe('the docs that enumerate the local-only fields name every field of the module\'s classes', () => {
  it('the enumerating docs are found, at least the tracked three the plan names', () => {
    const { RESTORED_LOCAL_FIELDS } = needModule(loaded, ['RESTORED_LOCAL_FIELDS'], 'local-only fields');
    const found = enumeratingDocs(RESTORED_LOCAL_FIELDS).map(d => d.file);
    assert.ok(found.length >= DOC_FLOOR, `only ${found.length} found: ${found.join(', ')}`);
    for (const must of ['docs/sync-protocol.md', 'docs/integration-guide/09-sync-api.md', 'docs/integration-guide/12-admin-api.md']) {
      assert.ok(found.includes(must), `${must} no longer enumerates the record-tier fields in one paragraph: re-point this gate or restore the sentence`);
    }
  });

  /** Every export of the module that is a set and is named `*_FIELDS`: the classes, derived, never listed here. */
  const classes = () => {
    const mod = needModule(loaded, ['RESTORED_LOCAL_FIELDS'], 'local-only fields');
    return Object.entries(mod).filter(([name, v]) => /_FIELDS$/.test(name) && v instanceof Set);
  };

  it('the classes are derived from the module: at least the five it has today, and the two the plan adds are among them', () => {
    const names = classes().map(([n]) => n);
    assert.ok(names.length >= CLASS_FLOOR, `only ${names.length} \`*_FIELDS\` class(es) derived (${names.join(', ')}): the derivation is broken`);
    for (const planned of ['POSITION_FIELDS', 'TOMBSTONE_LOCAL_FIELDS']) {
      assert.ok(names.includes(planned),
        `sync/local-only-fields.ts exports no ${planned} (derived: ${names.join(', ')}); the plan adds it (design rev 8 §2), and a field in a class nobody exports is a field no doc is owed`);
    }
  });

  it('every enumerating doc names each field of EVERY derived class', () => {
    const { RESTORED_LOCAL_FIELDS } = needModule(loaded, ['RESTORED_LOCAL_FIELDS'], 'local-only fields');
    const found = classes();
    assert.ok(found.length >= CLASS_FLOOR, 'fixture: fewer classes than the floor, see the case above');
    const behind = found.flatMap(([name, fields]) => {
      assert.ok(fields.size >= 1, `${name} is empty: a loop over it checks nothing`);
      return lacking(RESTORED_LOCAL_FIELDS, fields).map(l => `${name}: ${l}`);
    });
    assert.deepEqual(behind, []);
  });

  it('every enumerating doc names each ORDER_ONLY field (brain/recall-shape.ts: a field a read may order on and never return)', async () => {
    const shape = await loadDistModule('../../server/dist/brain/recall-shape.js', import.meta.url);
    const mod = needModule(shape, ['ORDER_ONLY_FIELDS'], 'the order-only class');
    const fields = [...mod.ORDER_ONLY_FIELDS];
    assert.ok(fields.length >= 1, 'ORDER_ONLY_FIELDS is empty: a loop over it checks nothing');
    const { RESTORED_LOCAL_FIELDS } = needModule(loaded, ['RESTORED_LOCAL_FIELDS'], 'local-only fields');
    assert.deepEqual(lacking(RESTORED_LOCAL_FIELDS, fields), []);
  });
});
