/**
 * The Conflicts page's table for a METADATA conflict compares exactly the fields the server records as visible and re-applies on `keep-local` (Q-426, the
 * review of bundle-45, #1 and #2).
 *
 * ## What it prevents
 *
 * Two lists of one thing: the server decides whether a displaced row is worth a conflict (`differsInWhatIsShown`) and what `keep-local` puts back
 * (`SHOWN_METADATA_KEYS`), and the page decides which rows its table draws (`METADATA_FIELDS`). A field on the page and not on the server is a difference the
 * user is shown and `keep-local` never applies; a field on the server and not on the page is a conflict recorded for a difference nobody can see, which is
 * the empty table #2 was. The page's list is read out of its source, because the client is not importable here, and the server's from the built module.
 *
 * Run: node --test testing/standalone/a-metadata-conflicts-table-compares-what-the-server-applies.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('the metadata conflict table and the server list the same fields', () => {
  it('METADATA_FIELDS on the page is SHOWN_METADATA_KEYS on the server, in the same order', async () => {
    const source = fs.readFileSync('client/src/app/pages/files/conflicts.component.ts', 'utf8');
    const match = /METADATA_FIELDS\s*=\s*\[([^\]]*)\]\s*as const/.exec(source);
    assert.ok(match, 'conflicts.component.ts no longer declares METADATA_FIELDS as a literal list: re-anchor this gate');
    const page = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    const { SHOWN_METADATA_KEYS } = await import('../../server/dist/sync/metadata-conflict.js');
    assert.ok(SHOWN_METADATA_KEYS.length >= 5, `the server lists only ${SHOWN_METADATA_KEYS.length} shown field(s): the list did not load`);
    assert.deepEqual(page, [...SHOWN_METADATA_KEYS], 'the page compares other fields than the server records and re-applies');
  });

  it('a displaced row differs in what is shown exactly when a shown field differs: never for a stamp or the author alone', async () => {
    const { SHOWN_METADATA_KEYS, differsInWhatIsShown } = await import('../../server/dist/sync/metadata-conflict.js');
    const row = { description: 'd', descriptionSource: 'generated', tags: ['t'], properties: { k: 1 }, suppressEmbeddings: true, author: { instanceId: 'a' }, createdAt: '1', updatedAt: '1' };
    assert.equal(differsInWhatIsShown(row, { ...row }), false);
    for (const key of ['author', 'createdAt', 'updatedAt']) {
      assert.equal(differsInWhatIsShown(row, { ...row, [key]: key === 'author' ? { instanceId: 'b' } : '2' }), false, `a different ${key} alone is a conflict with an empty table`);
    }
    const other = { description: 'e', descriptionSource: 'extracted', tags: ['u'], properties: { k: 2 }, suppressEmbeddings: false };
    for (const key of SHOWN_METADATA_KEYS) {
      assert.equal(differsInWhatIsShown(row, { ...row, [key]: other[key] }), true, `a different ${key} is not seen as a difference`);
      const without = { ...row }; delete without[key];
      assert.equal(differsInWhatIsShown(row, without), true, `a missing ${key} is not seen as a difference`);
    }
  });
});
