/**
 * The linkage check's adoption read of `link_violations` is served by a declared index (the review of bundle-45, #10).
 *
 * ## What it prevents
 *
 * `oldRecordsOf` (`sync/linkage-check.ts`) reads the violations of a page's documents by `docId`, once per check run that finds a dangling end. With no index on
 * `docId` that read is a scan of the whole collection, which grows with every unresolved end a space ever recorded, inside the check's write bound: a slow check
 * that records nothing when the bound ends. The index is declared in `spaces/space-indexes.ts`, the one list every builder reads, so a restored or new space has it too.
 * The field the read names is taken out of the source, so a read moved to another field is a failure here and not a silent scan.
 *
 * Run: node --test testing/standalone/the-linkage-check-reads-link-violations-by-an-indexed-field.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requireSpaceIndexDeclaration } from './_space-index-declaration.mjs';

describe('the adoption read of link_violations is index-served', () => {
  it('every field the linkage check filters link_violations by leads a declared index of that collection', async () => {
    const source = fs.readFileSync('server/src/sync/linkage-check.ts', 'utf8');
    const reads = [...source.matchAll(/spaceCollection\(spaceId, 'linkViolations'\)\)\s*\n?\s*\.find\(\{\s*(\w+):/g)].map(m => m[1]);
    assert.ok(reads.length >= 1, 'no `.find({ <field>: ... })` of link_violations was found in sync/linkage-check.ts: re-anchor this gate');
    const entries = await requireSpaceIndexDeclaration(assert);
    const declared = entries.filter(e => e.part === 'linkViolations');
    assert.ok(declared.length >= 1, 'no index is declared for link_violations');
    for (const field of new Set(reads)) {
      assert.ok(declared.some(e => Object.keys(e.raw.keys)[0] === field), `link_violations is read by '${field}' and no declared index leads with it: the read is a collection scan`);
    }
  });
});
