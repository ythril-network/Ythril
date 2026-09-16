/**
 * A field the server can sort by must be offered as a column.
 *
 * ## The bug underneath the bug
 *
 * `chrono-tab.component.spec.ts` already pinned this for ONE tab, and its comment named the failure exactly:
 * *"a field could be sortable server-side and simply never offered"*. `createdAt` had been in that state on
 * chrono — allowed by the API, with no column at all — while entities, edges and memories all showed one.
 *
 * That spec fixed chrono and stopped there, so the same check never reached the other three. Two of them were
 * in the same state: `SORTABLE_FIELDS.facts` and `.edges` both contain `type`, and **neither tab had a type
 * column**. Both tabs also read `recordFilter().type` and send it to the list endpoint
 * (`memories-tab.component.ts`, `edges-tab.component.ts`), and the store exposed `memoryTypeOptions()` and
 * `edgeTypeOptions()` — both unit-tested — with no template consumer. Request side, option list and tests all
 * present; the `<select>` and the column missing. A filter nobody can reach.
 *
 * A per-tab spec cannot catch that, because the tab that lacks the column is the tab that lacks the test. So
 * the check is derived from the SERVER's list and applied to every tab at once.
 *
 * ## Why it reads both directions
 *
 * A column offering a field the server will not sort by is the same defect mirrored: the header looks
 * clickable and the click returns 400. So the sets must match, not merely overlap.
 *
 * Run: node --test testing/standalone/sortable-fields-have-columns.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SORT_SOURCE = 'server/src/brain/list-sort.ts';

/** The tab component that renders each collection's table. */
const TABS = {
  entities: 'client/src/app/pages/brain/entities-tab.component.ts',
  edges: 'client/src/app/pages/brain/edges-tab.component.ts',
  facts: 'client/src/app/pages/brain/facts-tab.component.ts',
  chrono: 'client/src/app/pages/brain/chrono-tab.component.ts',
};

/**
 * `files` is sortable by createdAt/updatedAt/path but is not a brain record tab — its table lives in the file
 * manager, which has its own column model and its own sort control. Named rather than silently skipped, and
 * asserted below to still be a real entry in SORTABLE_FIELDS so this note cannot outlive its subject.
 */
const NOT_A_BRAIN_TAB = ['files'];

/** Parse `SORTABLE_FIELDS` out of the server source: { collection: Set<field> }. */
function serverSortableFields() {
  const src = readFileSync(SORT_SOURCE, 'utf8');
  const block = /export const SORTABLE_FIELDS = \{([\s\S]*?)\n\} as const;/.exec(src);
  assert.ok(block, `SORTABLE_FIELDS not found in ${SORT_SOURCE}`);
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*new Set<string>\(\[([^\]]*)\]\)/g)) {
    out[m[1]] = new Set([...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]));
  }
  assert.ok(Object.keys(out).length >= 4, `parsed only ${Object.keys(out).length} collections — the parser is stale`);
  return out;
}

/** The `field="…"` of every sortable header in a tab template. */
function offeredColumns(file) {
  const src = readFileSync(file, 'utf8');
  return new Set([...src.matchAll(/app-sort-th\s+field="(\w+)"/g)].map(m => m[1]));
}

describe('every server-sortable field is offered as a column', () => {
  const server = serverSortableFields();

  it('the exemption list still names real collections', () => {
    for (const c of NOT_A_BRAIN_TAB) {
      assert.ok(server[c], `\`${c}\` is exempted here but is no longer in SORTABLE_FIELDS — delete the entry`);
      assert.ok(!TABS[c], `\`${c}\` now has a brain tab — remove it from NOT_A_BRAIN_TAB and check its columns`);
    }
  });

  it('every collection in SORTABLE_FIELDS is either a tab here or a named exemption', () => {
    const unaccounted = Object.keys(server).filter(c => !TABS[c] && !NOT_A_BRAIN_TAB.includes(c));
    assert.deepEqual(unaccounted, [],
      `SORTABLE_FIELDS gained ${unaccounted.join(', ')} — add the tab path or exempt it with a reason`);
  });

  for (const [collection, file] of Object.entries(TABS)) {
    it(`${collection}: the offered columns and the sortable fields are the same set`, () => {
      const sortable = server[collection];
      assert.ok(sortable, `SORTABLE_FIELDS has no \`${collection}\` — the tab map is stale`);
      const offered = offeredColumns(file);

      const missing = [...sortable].filter(f => !offered.has(f)).sort();
      assert.deepEqual(missing, [],
        `${collection} can be sorted by ${missing.join(', ')} server-side, but no column offers it — the API ` +
        'allows an order the reader has no way to ask for');

      const unsortable = [...offered].filter(f => !sortable.has(f)).sort();
      assert.deepEqual(unsortable, [],
        `${collection} offers a sortable header for ${unsortable.join(', ')}, which is not in SORTABLE_FIELDS — ` +
        'clicking it returns 400');
    });
  }
});
