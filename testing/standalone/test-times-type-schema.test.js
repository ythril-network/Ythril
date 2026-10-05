/**
 * `scripts/test-times.mjs --type-schema` prints the declaration of the `Test-Run` chrono type, generated from
 * `TEST_RUN_SCHEMA` (bundle-56 pre-ship, privacy finding 2).
 *
 * ## What it prevents
 *
 * The guide says entries "expire under the retention the chrono type declares on the instance", and the recorder's own
 * docblock says that type "is generated from" `TEST_RUN_SCHEMA`. Nothing in the repo did the generating: the script that
 * did lived in a session's scratch folder, so the retention bound existed only if a maintainer had once declared the type
 * by hand, and a reader of the guide could not reproduce it. A second copy of the field list written for the declaration
 * is also how the writer and the declaration come to disagree about a field.
 *
 * ## What is held
 *
 * - the command prints ONE JSON document, the arguments of the `schema_update` call, and nothing else on stdout;
 * - its `Test-Run` properties are `TEST_RUN_SCHEMA`'s, key for key, with type, enum (`values`), required and description
 *   carried over (derived by iterating the schema, so a field added there is in the declaration with no edit here);
 * - the type suppresses embeddings, never acts when a date passes, and keeps a record the number of days
 *   `TEST_RUN_RETENTION_DAYS` says (one year);
 * - the five default chrono types are in the payload (a space with no chrono types of its own would otherwise be closed to
 *   them by declaring one), in MERGE mode;
 * - the server's own validator for `typeSchemas` accepts it, so a payload the instance would refuse is a red here;
 * - the testing guide names the command where it describes the retention, and `--help` lists it.
 *
 * Run: node --test testing/standalone/test-times-type-schema.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { runScript } from './_run-script.mjs';
import { TEST_RUN_SCHEMA, CHRONO_TYPE, SPACE, TEST_RUN_RETENTION_DAYS, testRunTypeDeclaration, HELP } from '../../scripts/test-times.mjs';
import { TypeSchemasZ } from '../../server/dist/spaces/body-schemas.js';

const SCRIPT = join(REPO_ROOT, 'scripts', 'test-times.mjs');
const printed = () => {
  const r = runScript(SCRIPT, ['--type-schema']);
  assert.equal(r.status, 0, r.out);
  return JSON.parse(r.out);
};

describe('--type-schema', () => {
  it('prints exactly the arguments of the schema_update call, as one JSON document', () => {
    const doc = printed();
    assert.deepEqual(doc, testRunTypeDeclaration());
    assert.equal(doc.space, SPACE);
    assert.equal(doc.typeSchemasMode, 'merge');
  });

  it('declares every TEST_RUN_SCHEMA property of the type, and no other, carrying type, enum, required and description', () => {
    const declared = testRunTypeDeclaration().typeSchemas.chrono[CHRONO_TYPE].propertySchemas;
    assert.deepEqual(Object.keys(declared).sort(), Object.keys(TEST_RUN_SCHEMA).sort());
    for (const [key, field] of Object.entries(TEST_RUN_SCHEMA)) {
      assert.equal(declared[key].type, field.type, `${key}: type`);
      assert.deepEqual(declared[key].enum, field.values, `${key}: enum`);
      assert.equal(declared[key].required === true, field.required === true, `${key}: required`);
      assert.equal(declared[key].description, field.doc, `${key}: description`);
    }
  });

  it('the type is found by date and filter, never by meaning, and is kept the days the constant says', () => {
    const type = testRunTypeDeclaration().typeSchemas.chrono[CHRONO_TYPE];
    assert.equal(type.suppressEmbeddings, true);
    assert.equal(type.whenDuePasses, 'nothing');
    assert.deepEqual(type.retention, { days: TEST_RUN_RETENTION_DAYS });
    assert.ok(Number.isInteger(TEST_RUN_RETENTION_DAYS) && TEST_RUN_RETENTION_DAYS > 0, 'a retention of nothing is no bound');
  });

  it('keeps the five default chrono types beside it, so declaring one does not close the space to the others', () => {
    const chrono = testRunTypeDeclaration().typeSchemas.chrono;
    for (const t of ['event', 'deadline', 'plan', 'prediction', 'milestone']) assert.ok(t in chrono, `${t} is missing`);
    assert.ok(CHRONO_TYPE in chrono);
  });

  it('the server\'s validator for typeSchemas accepts it', () => {
    const parsed = TypeSchemasZ.safeParse(testRunTypeDeclaration().typeSchemas);
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 600));
  });

  it('is named in --help and in the testing guide where the retention is described', () => {
    assert.match(HELP, /--type-schema/);
    const guide = readFileSync(join(REPO_ROOT, 'docs', 'testing-guide.md'), 'utf8');
    // The paragraph is the lines from the one naming the retention to the next line with nothing on it (split on either
    // newline, so a CRLF checkout reads it as an LF one does).
    const lines = guide.split(/\r?\n/);
    const from = lines.findIndex(l => l.includes('Entries expire'));
    assert.ok(from >= 0, 'the guide no longer describes the retention here — re-anchor this row');
    const length = lines.slice(from).findIndex(l => l.trim() === '');
    const paragraph = lines.slice(from, length < 0 ? undefined : from + length).join('\n');
    assert.match(paragraph, /--type-schema/, 'the guide states the retention without saying how to declare it');
  });
});
