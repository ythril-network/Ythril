/**
 * Every reader of the schema stamp matches `STAMP_READ` (`{ $type: 'string' }`), which implies the stamp index's partial filter
 * `STAMP_PRESENT` (`{ $exists: true }`); `STAMP_PRESENT` is the index's partial filter and nothing else (bundle-267, design r3 final
 * changes 2; probe 2 E1).
 *
 * ## Why
 *
 * Probe 2 measured it: a `$exists: true` match cannot be answered from an index, so every read that holds it FETCHes the record,
 * even hinted (50 711 documents for a group over 60 000 entities), while `$type: 'string'` is answered from the keys alone
 * (PROJECTION_COVERED, no document read) and still lets the planner use the partial index, because it implies the partial filter.
 * Today's `fingerprintsCarriedIn` (gap scan, sweep, fetch) holds `STAMP_PRESENT` and fetches for that reason.
 *
 * ## What is held
 *
 * 1. The implication, evaluated by the tests' one filter matcher over every shape a stamp field can have: whatever `STAMP_READ`
 *    selects, `STAMP_PRESENT` selects; a fingerprint is selected (so the implication is not vacuous).
 * 2. The index's partial filter is `STAMP_PRESENT`, read from the declaration.
 * 3. A gate over `server/src`: `STAMP_PRESENT` is named only where it is defined and where the index declares it; every other
 *    module reading the stamp names `STAMP_READ`.
 *
 * ## Seen red
 *
 * At b299cde3 `STAMP_READ` does not exist (1, new code), and `spaces/schema-snapshot-carried.ts` filters by `STAMP_PRESENT` (3, the
 * existing behaviour: the gap scan, sweep and fetch read the records).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchesFilter } from '../_shared/filter-matcher.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const carried = await import('../../server/dist/spaces/schema-snapshot-carried.js');
const { SPACE_INDEXES } = await import('../../server/dist/spaces/space-indexes.js');
const F = 'schemaFingerprint';

const SHAPES = [
  ['a fingerprint', 'a'.repeat(64)], ['an empty string', ''], ['a number', 7], ['null', null], ['true', true],
  ['an object', { fp: 'x' }], ['an array', ['x']], ['absent', undefined],
];

describe('STAMP_READ implies the stamp index partial filter', () => {
  it('whatever STAMP_READ selects STAMP_PRESENT selects, and a fingerprint is selected', () => {
    assert.ok(carried.STAMP_READ && typeof carried.STAMP_READ === 'object', 'spaces/schema-snapshot-carried.js exports no STAMP_READ');
    let selected = 0;
    for (const [what, value] of SHAPES) {
      const doc = value === undefined ? {} : { [F]: value };
      const read = matchesFilter(doc, { [F]: carried.STAMP_READ });
      if (read) selected++;
      if (read) assert.ok(matchesFilter(doc, { [F]: carried.STAMP_PRESENT }), `STAMP_READ selects ${what}, which the partial index does not hold`);
    }
    assert.ok(matchesFilter({ [F]: 'a'.repeat(64) }, { [F]: carried.STAMP_READ }), 'STAMP_READ does not select a fingerprint');
    assert.ok(selected < SHAPES.length, 'STAMP_READ selects every shape: it is no narrower than the partial filter');
  });

  it('the stamp index of every stamped collection is partial on STAMP_PRESENT', () => {
    const stamp = SPACE_INDEXES.filter(ix => F in ix.keys);
    assert.ok(stamp.length >= 4, `fewer than four stamp indexes are declared: ${stamp.map(ix => ix.part).join(', ')}`);
    for (const ix of stamp) assert.deepEqual(ix.options.partialFilterExpression, { [F]: carried.STAMP_PRESENT }, `${ix.part}'s stamp index`);
  });
});

describe('only the index declaration names STAMP_PRESENT', () => {
  /** The modules allowed to name it: where it is defined and where the index is declared. */
  const ALLOWED = new Set(['server/src/spaces/schema-snapshot-carried.ts', 'server/src/spaces/space-indexes.ts']);

  /** The offending uses in one module's code (comments stripped); the definition line in its own module does not count. */
  function usesOf(rel, src) {
    const code = stripComments(src).split('\n').filter(l => !/export const STAMP_PRESENT\b/.test(l)).join('\n');
    const n = (code.match(/\bSTAMP_PRESENT\b/g) ?? []).length;
    if (rel === 'server/src/spaces/schema-snapshot-carried.ts') return n;          // defined there; read there by no filter
    return ALLOWED.has(rel) ? 0 : n;
  }

  it('a planted reader that filters by STAMP_PRESENT is caught', () => {
    const planted = "import { STAMP_PRESENT } from './x.js';\nconst f = { schemaFingerprint: { ...STAMP_PRESENT } };\n";
    assert.ok(usesOf('server/src/spaces/a-new-reader.ts', planted) > 0);
    assert.equal(usesOf('server/src/spaces/a-new-reader.ts', planted.replaceAll('STAMP_PRESENT', 'STAMP_READ')), 0);
  });

  it('no stamp reader in server/src filters by STAMP_PRESENT', () => {
    const files = trackedSources(['server/src']).filter(p => p.endsWith('.ts'));
    assert.ok(files.length > 200, `the walk found ${files.length} server sources: the gate would pass on nothing`);
    const offenders = [];
    for (const rel of files) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      if (!src.includes('STAMP_PRESENT')) continue;
      const n = usesOf(rel.replaceAll('\\', '/'), src);
      if (n > 0) offenders.push(`${rel} (${n})`);
    }
    assert.deepEqual(offenders, [], 'these modules read the stamp through STAMP_PRESENT, which no index answers without the record: use STAMP_READ');
  });
});
