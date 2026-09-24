/**
 * The Schema Library entries the product ships reach a running instance, and seeding them never overwrites an
 * operator's.
 *
 * `ingest` refuses a space that does not declare every type of the `conversation` group, and the way a space gets
 * them is the library's group apply (`POST /api/schema-library/groups/:group/apply`). The 25 entries lived in
 * `server/src/extractor/conversation/schemas/` and nothing loaded them — and the image ships `server/dist` only, so
 * a JSON file under `src` did not exist at runtime at all. The refusal would have pointed at an apply that
 * answered 404.
 *
 * Seeding adds an entry whose NAME the library lacks, and nothing else: an operator who edited one keeps the edit.
 *
 * Run: node --test testing/standalone/the-conversation-group-ships-in-the-library.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

let shippedLibraryEntries, entriesMissingFrom;
before(async () => {
  ({ shippedLibraryEntries, entriesMissingFrom } = await import('../../server/dist/config/shipped-library-entries.js'));
});

const SOURCE = 'server/src/extractor/conversation/schemas';

describe('what the product ships', () => {
  it('every schema file under src reaches dist, and is read from there', () => {
    const files = readdirSync(SOURCE).filter(f => f.endsWith('.json'));
    assert.ok(files.length > 0, 'no source schema files — this test is measuring nothing');
    const shipped = shippedLibraryEntries();
    assert.equal(shipped.length, files.length, 'a schema file under src is missing from the build output');
    for (const e of shipped) {
      assert.equal(e.schemaGroup, 'conversation');
      assert.ok(e.name && e.knowledgeType && e.typeName && e.schema, `${e.name} is not a complete library entry`);
    }
  });
});

describe('seeding', () => {
  it('adds what is missing by name, and nothing else', () => {
    const shipped = shippedLibraryEntries();
    const edited = { ...shipped[0], description: 'the operator changed this' };
    const missing = entriesMissingFrom([edited, { name: 'someone-else', knowledgeType: 'entity', typeName: 'x', schema: {} }]);
    assert.equal(missing.length, shipped.length - 1);
    assert.ok(!missing.some(e => e.name === edited.name), 'an entry the library holds is never replaced');
  });

  it('a library already holding them all gets nothing', () => {
    assert.deepEqual(entriesMissingFrom(shippedLibraryEntries()), []);
  });
});
