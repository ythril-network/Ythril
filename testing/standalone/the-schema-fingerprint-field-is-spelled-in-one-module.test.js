/**
 * The name of the field a record carries its schema stamp in is spelled by ONE module, and the server's code reads it from there (bundle-265, the diff pass's F10).
 *
 * ## The defect this prevents
 *
 * `SCHEMA_FINGERPRINT_FIELD` (`schema/src/schema-fingerprint.ts`, re-exported by `spaces/schema-stamp.ts`) is "the field, spelled once". The note was true of the
 * stamp helpers and false of the server: the Merkle hash's unhashed-field set, the authored-content version metadata, the four `Incoming*` schemas' declarations
 * and the stamp's partial index each spelled `'schemaFingerprint'` themselves. A rename of the field (or a typo in one of them) then changes the stamp the writers
 * set and not the field the arrival keeps, the hash leaves out or the index covers, and nothing fails: the record is stamped, never kept, and hashed as body.
 *
 * ## What is held
 *
 * No line of `server/src` outside the allowlist spells the word (comments are not read: a comment is prose, not a second spelling). Each allowed file is asserted to
 * still hold the word, so an exemption cannot outlive its reason, and the matcher is shown to flag a planted copy.
 *
 * ## The allowlist, with the reason of each
 *
 * - `config/types-knowledge.ts`: the property NAME of the `SchemaStamped` interface, which a type declaration cannot take from a value without importing the
 *   schema package into the config types;
 * - `mcp/tools/spaces.ts`: the sentence of the `space_meta` tool description, prose an agent reads, which names the field it will see in the answer.
 *
 * Run: node --test testing/standalone/the-schema-fingerprint-field-is-spelled-in-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const WORD = /\bschemaFingerprint\b/g;

const ALLOWED = Object.freeze({
  'server/src/config/types-knowledge.ts': 'the property name of the SchemaStamped interface',
  'server/src/mcp/tools/spaces.ts': 'the sentence of the space_meta tool description',
});

/** The lines of `source` (comments blanked, line numbers kept) that spell the field. */
const spellings = (source) => blankComments(source).split('\n').flatMap((line, i) => (line.match(WORD) ? [i + 1] : []));

describe('the schema fingerprint field is spelled in one module', () => {
  const files = trackedSources('server/src');

  it('no server source outside the allowlist spells the field', () => {
    const found = [];
    for (const file of files) {
      if (file in ALLOWED) continue;
      for (const line of spellings(readFileSync(join(REPO_ROOT, file), 'utf8'))) found.push(`${file}:${line}`);
    }
    assert.deepEqual(found, [], `these lines spell the stamp field themselves; import SCHEMA_FINGERPRINT_FIELD (spaces/schema-stamp.ts, or @ythril-network/schema/internal for a module that must not import the config loader):\n  ${found.join('\n  ')}`);
  });

  it('every allowed file still spells it, so an exemption cannot outlive its reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      assert.ok(files.includes(file), `${file} is not a tracked server source`);
      assert.ok(spellings(readFileSync(join(REPO_ROOT, file), 'utf8')).length > 0, `${file} no longer spells the field (${reason}): remove its exemption`);
    }
  });

  it('the matcher flags a planted spelling and passes a comment and the longer names', () => {
    assert.deepEqual(spellings("const KEYS = new Set(['schemaFingerprint']);"), [1]);
    assert.deepEqual(spellings('const doc = { schemaFingerprint: fp };'), [1]);
    assert.deepEqual(spellings('const fp = row.schemaFingerprint;'), [1]);
    assert.deepEqual(spellings("// the 'schemaFingerprint' field\n/* schemaFingerprint */ const x = 1;"), []);
    assert.deepEqual(spellings('const a = schemaFingerprintOf(space) + schemaFingerprintTextOf(meta);'), []);
  });
});
