/**
 * Each meta key has ONE merge kind, and the three merges that write a meta all honour it (`Q-217`; R5-5, R6-5).
 *
 * ## What was found
 *
 * Three functions merge a meta into a meta, and each kept its own list of what it knew:
 *
 * - `mergeSpaceMeta` (a PATCH and `schema_update`) copied SIX named fields and the type schemas. `meta.whenDuePasses` — accepted by
 *   `SpaceMetaBody`, priced in the rights table, declared on the MCP tool — was parsed and then NOT STORED: a 200 for a write that did not
 *   happen. `stampSkew` fell out of the same list.
 * - `mergeReplicatedMeta` (a network's layer) replaces every top-level key it is handed, and merges types additively;
 * - `applyMetaRound` (a passed `meta_change` round) replaces every field the round names, and merges types per type name.
 *
 * They agreed on what they listed and were free to disagree about the rest, which is the defect this repo produces most. R6-5 fixes the
 * answer once, as a kind per key, in `spaces/meta-fields.ts`, and every merge reads it:
 *
 * | kind | keys | what a merge does |
 * |---|---|---|
 * | scalar | purpose, usageNotes, validationMode, strictLinkage, suppressEmbeddings, whenDuePasses | the incoming value replaces; a `false` is a value |
 * | object, replaced whole | stampSkew | the incoming object replaces; a property the old one had and the new one lacks is gone |
 * | per type | typeSchemas | a type not named is untouched; a type named is merged by the rule of the door (below) |
 * | replaced whole (F-46) | rules | the incoming map replaces; a rule absent from it is deleted |
 *
 * ## What is derived and what is literal
 *
 * The KEYS are derived (the `SpaceMeta` interface, less the server's own), so a key added to the type fails this file until it has a kind.
 * The expected BEHAVIOUR is literal: it is the contract the owner agreed (R6-5), and deriving it from the code under test would assert only
 * that the code equals itself.
 *
 * Rows that cannot run yet (`rules`, F-46) are listed with the reason and run the day the type declares the key.
 *
 * Run: node --test testing/standalone/a-meta-field-keeps-its-merge-kind-through-every-merge.test.js
 * (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';

/** One row per settable key: what each merge must do with an incoming value. `old` is what the meta holds, `next` what arrives. */
const TABLE = [
  { key: 'purpose', kind: 'scalar', old: 'the old purpose', next: 'the new purpose' },
  { key: 'usageNotes', kind: 'scalar', old: 'old notes', next: 'new notes' },
  { key: 'validationMode', kind: 'scalar', old: 'off', next: 'strict' },
  // `false` is how a flag is turned OFF; a truthiness guard would keep the old `true` and answer 200.
  { key: 'strictLinkage', kind: 'scalar', old: true, next: false },
  { key: 'suppressEmbeddings', kind: 'scalar', old: true, next: false },
  { key: 'whenDuePasses', kind: 'scalar', old: 'overdue', next: 'nothing' },
  // Replaced whole: `properties` was on the old object and is not on the new, so it must be gone.
  { key: 'stampSkew', kind: 'object-replaced-whole', old: { warnMinutes: 5, properties: ['stampedAt'] }, next: { warnMinutes: 10 } },
  { key: 'typeSchemas', kind: 'per-type', old: { entity: { Kept: { namingPattern: '^k' } } }, next: { entity: { Added: { namingPattern: '^a' } } } },
  { key: 'rules', kind: 'replaced-whole', until: 'F-46', old: { a: { rule: 'true', message: 'a' } }, next: { b: { rule: 'true', message: 'b' } } },
];

/** The members of an interface declared in `file`. */
function interfaceKeys(file, name) {
  const sf = parseSource(file, stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')));
  let keys = null;
  sf.forEachChild(function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      keys = node.members.filter(m => m.name).map(m => m.name.getText(sf).replace(/^['"]|['"]$/g, ''));
      return;
    }
    ts.forEachChild(node, visit);
  });
  assert.ok(keys, `${file} no longer declares interface ${name}`);
  return keys;
}

const { mergeSpaceMeta } = await import('../../server/dist/spaces/meta-update.js');
const { mergeReplicatedMeta } = await import('../../server/dist/sync/replicated-meta.js');
const { applyMetaRound } = await import('../../server/dist/sync/meta-round-merge.js');
const { SERVER_OWNED_META_FIELDS: SERVER_OWNED } = await import('../../server/dist/spaces/body-schemas.js');
const settable = interfaceKeys('server/src/config/types-knowledge.ts', 'SpaceMeta').filter(k => !SERVER_OWNED.includes(k));

describe('a meta key keeps its merge kind through every merge', () => {

  it('every settable key has a row (a key added to SpaceMeta is decided here or this fails)', () => {
    assert.ok(settable.length >= 7, `only ${settable.length} settable keys read from interface SpaceMeta`);
    assert.deepEqual(settable.filter(k => !TABLE.some(r => r.key === k)), [], 'SpaceMeta gained a key with no merge kind in this table: say what a merge does with it');
    assert.deepEqual(TABLE.filter(r => !r.until && !settable.includes(r.key)).map(r => r.key), [], 'a row names a key SpaceMeta no longer has');
    assert.ok(TABLE.filter(r => r.until).every(r => r.until === 'F-46'), 'a row waits on something other than F-46');
  });

  it('one table holds the kinds: spaces/meta-fields.ts exists and names every settable key', () => {
    const file = 'server/src/spaces/meta-fields.ts';
    assert.ok(existsSync(join(REPO_ROOT, file)), `${file} does not exist: R6-5 keeps each key's merge kind in one module that every merge reads`);
    const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    assert.deepEqual(settable.filter(k => !new RegExp(`\\b${k}\\b`).test(src)), [], `${file} does not name these keys, so a merge reading it cannot know their kind`);
  });

  describe('mergeSpaceMeta (PATCH and schema_update)', () => {
    for (const row of TABLE) {
      it(`${row.key} (${row.kind}): the incoming value is stored, the other keys and the version bookkeeping are not touched`, { skip: row.until && !settable.includes(row.key) ? `${row.until}: SpaceMeta does not declare ${row.key} yet` : false }, () => {
        const existing = { version: 4, updatedAt: 't', purpose: 'kept purpose', validationMode: 'warn', [row.key]: row.old };
        const merged = mergeSpaceMeta(existing, { [row.key]: row.next });
        const want = row.kind === 'per-type'
          ? { entity: { Kept: { namingPattern: '^k' }, Added: { namingPattern: '^a' } } }
          : row.next;
        assert.deepEqual(merged[row.key], want,
          `${row.key} sent as ${JSON.stringify(row.next)} came out as ${JSON.stringify(merged[row.key])}: a write answered success for a value that was not stored`);
        if (row.key !== 'purpose') assert.equal(merged.purpose, 'kept purpose', `merging ${row.key} changed purpose`);
        if (row.key !== 'validationMode') assert.equal(merged.validationMode, 'warn', `merging ${row.key} changed validationMode`);
        assert.equal(merged.version, undefined, 'the housekeeping version leaked into the merge result');
      });
      it(`${row.key}: a key the request does not name is left as it was`, { skip: row.until && !settable.includes(row.key) ? `${row.until}: not declared yet` : false }, () => {
        const other = row.key === 'usageNotes' ? 'purpose' : 'usageNotes';
        const merged = mergeSpaceMeta({ [row.key]: row.old }, { [other]: 'unrelated' });
        assert.deepEqual(merged[row.key], row.old);
      });
    }
  });

  describe('mergeReplicatedMeta (a network layer arriving)', () => {
    for (const row of TABLE) {
      it(`${row.key} (${row.kind}): the incoming value is kept, nothing is refused`, { skip: row.until && !settable.includes(row.key) ? `${row.until}: SpaceMeta does not declare ${row.key} yet` : false }, () => {
        const local = { purpose: 'kept purpose', [row.key]: row.old };
        const result = mergeReplicatedMeta(local, { [row.key]: row.next });
        assert.equal(result.invalid, undefined, `a layer carrying ${row.key} was refused whole: ${String(result.invalid).slice(0, 200)}`);
        assert.equal(result.changed, true);
        const want = row.kind === 'per-type'
          ? { entity: { Kept: { namingPattern: '^k' }, Added: { namingPattern: '^a' } } }
          : row.next;
        assert.deepEqual(result.meta[row.key], want);
        if (row.key !== 'purpose') assert.equal(result.meta.purpose, 'kept purpose');
      });
    }
  });

  describe('applyMetaRound (a passed round)', () => {
    for (const row of TABLE) {
      it(`${row.key} (${row.kind}): the incoming value is applied, the others are not touched, nothing is reported as a conflict`, { skip: row.until && !settable.includes(row.key) ? `${row.until}: SpaceMeta does not declare ${row.key} yet` : false }, () => {
        const current = { version: 3, purpose: 'kept purpose', [row.key]: row.old };
        const applied = applyMetaRound(current, { pendingMeta: { ...current, [row.key]: row.next }, metaChangedFields: [row.key], baseMetaVersion: 3 });
        const want = row.kind === 'per-type'
          ? { entity: { Kept: { namingPattern: '^k' }, Added: { namingPattern: '^a' } } }
          : row.next;
        assert.deepEqual(applied.meta[row.key], want);
        if (row.key !== 'purpose') assert.equal(applied.meta.purpose, 'kept purpose');
        assert.deepEqual(applied.conflicts, []);
      });
    }
  });

  describe('a type named by a write: the three merges differ only where R6-5 says they do', () => {
    const existingType = { namingPattern: '^a', description: 'd', propertySchemas: { x: { type: 'string' } } };
    const incomingType = { namingPattern: '^b', propertySchemas: { y: { type: 'number' } } };
    it('PATCH and a round replace the type by name: what the new definition lacks is gone', () => {
      const patched = mergeSpaceMeta({ typeSchemas: { entity: { T: existingType } } }, { typeSchemas: { entity: { T: incomingType } } });
      assert.deepEqual(patched.typeSchemas.entity.T, incomingType);
      const current = { version: 1, typeSchemas: { entity: { T: existingType } } };
      const round = applyMetaRound(current, { pendingMeta: { typeSchemas: { entity: { T: incomingType } } }, metaChangedFields: ['typeSchemas'], baseMetaVersion: 1 });
      assert.deepEqual(round.meta.typeSchemas.entity.T, incomingType);
    });
    it('a network layer is additive: its fields win, and the property maps are unioned (the owner\'s ruling)', () => {
      const merged = mergeReplicatedMeta({ typeSchemas: { entity: { T: existingType } } }, { typeSchemas: { entity: { T: incomingType } } });
      assert.deepEqual(merged.meta.typeSchemas.entity.T, {
        namingPattern: '^b', description: 'd', propertySchemas: { x: { type: 'string' }, y: { type: 'number' } },
      });
    });
  });
});
