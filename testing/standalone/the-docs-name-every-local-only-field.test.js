/**
 * The docs that enumerate the local-only fields name every field of every class the module declares (`Q-439`).
 *
 * ## The rule
 *
 * `sync/local-only-fields.ts` is the one list, and four documents re-state it for a reader who will never open the module:
 * `docs/integration-guide/09-sync-api.md` (what the hash leaves out), `docs/integration-guide/12-admin-api.md` (what an
 * export and an import keep), `docs/sync-protocol.md` and `CLAUDE.md`. Each says "the local-only fields are ..." and lists
 * them. A field added to the module is then missing from four sentences nobody re-reads, and the reader of one of them
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
 * - **The floor** is the four documents above; a derivation that finds fewer has broken.
 *
 * A field counts as named when its LITERAL name appears in the doc: prose such as "the retention stamps" is how the older
 * sentences drifted, and is exactly what a reader cannot grep.
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
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const DOC_FLOOR = 4;

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/sync/local-only-fields.js', import.meta.url); });

/** Whole-word, so `embedding` is not found inside `embeddingModel`. */
const names = (text, field) => new RegExp(String.raw`(?<![\w$])${field.replace(/[$]/g, String.raw`\$`)}(?![\w$])`).test(text);

const DOCS = trackedSources(['docs', 'CLAUDE.md'], { ext: ['.md'], floor: 20, untracked: true })
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
  it('the enumerating docs are found, at least the four the plan names', () => {
    const { RESTORED_LOCAL_FIELDS } = needModule(loaded, ['RESTORED_LOCAL_FIELDS'], 'local-only fields');
    const found = enumeratingDocs(RESTORED_LOCAL_FIELDS).map(d => d.file);
    assert.ok(found.length >= DOC_FLOOR, `only ${found.length} found: ${found.join(', ')}`);
    for (const must of ['CLAUDE.md', 'docs/sync-protocol.md', 'docs/integration-guide/09-sync-api.md', 'docs/integration-guide/12-admin-api.md']) {
      assert.ok(found.includes(must), `${must} no longer enumerates the record-tier fields in one paragraph: re-point this gate or restore the sentence`);
    }
  });

  it('every enumerating doc names each RESTORED field (`_expireAt`, `_contentExpireAt`, `syncBase`, `deliveredBy`)', () => {
    const { RESTORED_LOCAL_FIELDS } = needModule(loaded, ['RESTORED_LOCAL_FIELDS'], 'local-only fields');
    assert.deepEqual(lacking(RESTORED_LOCAL_FIELDS, RESTORED_LOCAL_FIELDS), []);
  });

  it('every enumerating doc names each DERIVED field (`embedding`, `embeddingModel`, `matchedText`)', () => {
    const { RESTORED_LOCAL_FIELDS, DERIVED_LOCAL_FIELDS } = needModule(loaded, ['RESTORED_LOCAL_FIELDS', 'DERIVED_LOCAL_FIELDS'], 'local-only fields');
    assert.deepEqual(lacking(RESTORED_LOCAL_FIELDS, DERIVED_LOCAL_FIELDS), []);
  });

  it('every enumerating doc names each WRITE GUARD field (`_functionalGuard`)', () => {
    const { RESTORED_LOCAL_FIELDS, WRITE_GUARD_FIELDS } = needModule(loaded, ['RESTORED_LOCAL_FIELDS', 'WRITE_GUARD_FIELDS'], 'local-only fields');
    assert.ok(WRITE_GUARD_FIELDS.size >= 1, 'WRITE_GUARD_FIELDS is empty: a loop over it checks nothing');
    assert.deepEqual(lacking(RESTORED_LOCAL_FIELDS, WRITE_GUARD_FIELDS), []);
  });
});
