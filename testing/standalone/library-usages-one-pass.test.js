/**
 * The schema library's usage counts are answered once, for every entry, by the rule the per-entry route uses (`Q-112`).
 *
 * The library page asked `GET /api/schema-library/:name/usages` once PER ENTRY to show "3 links" beside each row —
 * N requests for one page, each scanning every space. The list answer now carries `usageCounts`, computed in ONE
 * pass by `libraryUsages`, and the per-entry route reads the same function, so the two cannot disagree about what
 * counts as a use: a type whose stored schema is exactly `{ $ref: "library:<name>" }`.
 *
 * Both routes are asserted to call it — a count computed a second way on the list would be the defect this repo
 * produces most, arriving as a performance fix.
 *
 * Run: npm run build -w server && node --test testing/standalone/library-usages-one-pass.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { libraryUsages } = await import('../../server/dist/spaces/library-usages.js');

const spaces = [
  { id: 'a', label: 'Alpha', meta: { typeSchemas: {
    entity: { person: { $ref: 'library:person' }, org: { $ref: 'library:org' }, pet: { propertySchemas: {} } },
    edge: { knows: { $ref: 'library:person' } },
  } } },
  { id: 'b', label: 'Beta', meta: { typeSchemas: { fact: { claim: { $ref: 'library:claim' } }, entity: { human: { $ref: 'library:person' } } } } },
  { id: 'c', label: 'Gamma' },
];

describe('libraryUsages', () => {
  it('finds every use of every entry in one pass, keyed by entry name', () => {
    const u = libraryUsages(spaces);
    assert.deepEqual(u.get('person'), [
      { spaceId: 'a', spaceLabel: 'Alpha', knowledgeType: 'entity', typeName: 'person' },
      { spaceId: 'a', spaceLabel: 'Alpha', knowledgeType: 'edge', typeName: 'knows' },
      { spaceId: 'b', spaceLabel: 'Beta', knowledgeType: 'entity', typeName: 'human' },
    ]);
    assert.equal(u.get('org')?.length, 1);
    assert.equal(u.get('claim')?.length, 1);
    assert.equal(u.get('nothing'), undefined, 'an unused entry has no row');
  });

  it('an inline type and a space with no schema are not uses', () => {
    const all = [...libraryUsages(spaces).values()].flat();
    assert.ok(!all.some(x => x.typeName === 'pet'));
    assert.ok(!all.some(x => x.spaceId === 'c'));
  });
});

describe('both routes read it', () => {
  const route = stripComments(readFileSync(`${REPO_ROOT}/server/src/api/schema-library.ts`, 'utf8'));

  it('the list answer carries usageCounts from libraryUsages', () => {
    const list = route.slice(route.indexOf("schemaLibraryRouter.get('/',"), route.indexOf("schemaLibraryRouter.get('/public'"));
    assert.ok(list.length > 0, 'the list route was not found — re-point this test');
    assert.match(list, /libraryUsages\(/);
    assert.match(list, /usageCounts/);
  });

  it('the per-entry route reads libraryUsages rather than its own loop', () => {
    const start = route.indexOf("schemaLibraryRouter.get('/:name/usages'");
    assert.ok(start >= 0, 'the usages route was not found — re-point this test');
    const body = route.slice(start, route.indexOf('schemaLibraryRouter.', start + 10));
    assert.match(body, /libraryUsages\(/);
    assert.doesNotMatch(body, /for \(const space of/, 'the route still scans the spaces itself');
  });
});
