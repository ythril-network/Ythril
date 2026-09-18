/**
 * Every collection `filter` will open either declares its sortable fields or REFUSES a sort. Never throws.
 *
 * ## The defect
 *
 * The canary operator, 2026-09-15: `filter` with `collection: "links"` and `sort: "createdAt"` answers
 * `Cannot read properties of undefined (reading 'has')`. Without `sort` the same call is fine.
 *
 * `SORTABLE_FIELDS` had entries for five collections; `filter`'s `collection` enum has six. So the lookup
 * was `undefined`, `allowed.has()` threw, and the caller got a 500 where the tool's own text promises the
 * field "is refused and names the allowed ones". Two doors index that map and hand the result straight to
 * `parseSortParam` — one rule, two call sites, and neither of them the place to notice.
 *
 * ## Why the gate is derived rather than a sixth entry
 *
 * Adding `links` fixes today. What recurs is the PAIRING: a collection reaches the enum (so a caller can
 * name it) without reaching the map (so sorting it crashes). The two lists are written in different files
 * by different changes, and nothing has ever compared them.
 *
 * So the subject is read from the tool's published schema — the same enum a caller reads — and the rule is
 * that every member is sortable-or-explicitly-refused. A seventh collection is covered by the commit that
 * declares it.
 *
 * ## And the crash cannot come back, whatever the lists say
 *
 * The second case is the floor under the first. `parseSortParam` takes `ReadonlySet | undefined` and
 * answers a refusal for the absent case, so a collection somebody forgets is a 400 rather than a 500 —
 * which is what the two doors needed all along, since neither of them checks.
 *
 * Run: node --test testing/standalone/every-queryable-collection-can-be-sorted-or-refuses.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { SORTABLE_FIELDS, parseSortParam } = await import('../../server/dist/brain/list-sort.js');

/** The collections a caller may name, read from the schema they read. */
function queryableCollections() {
  // `filter`, not `query`: the tool was renamed at 5.0 and its one route is `POST /api/filter`. The
  // first draft of this gate said `query` and its own floor caught it, which is what the floor is for.
  const tool = ALL_TOOLS.find(t => t.name === 'filter');
  assert.ok(tool, 'the `filter` tool is gone — re-anchor this gate');
  const schema = tool.inputSchema({ requiredSpace: {}, optionalSpace: {} });
  return schema.properties?.collection?.enum ?? [];
}

describe('the enum and the sortable map describe the same set', () => {
  it('found the collections (an empty enum would pass every loop below)', () => {
    const collections = queryableCollections();
    assert.ok(collections.length >= 5,
      `only ${collections.length} queryable collection(s) — the schema read is broken, not the code`);
  });

  it('every collection a caller can name declares its sortable fields', () => {
    const missing = queryableCollections().filter(c => !SORTABLE_FIELDS[c]);
    assert.deepEqual(missing, [],
      `these are queryable and have no sortable-field set, so sorting them reaches an undefined map: `
      + `${missing.join(', ')} — add an entry, or the refusal below is all a caller gets`);
  });

  it('and nothing is declared sortable that a caller cannot reach', () => {
    // The other direction, which is cheap and catches a rename: a map entry for a collection the enum
    // does not offer is dead, and dead config is the thing people read and believe.
    const reachable = new Set(queryableCollections());
    const orphans = Object.keys(SORTABLE_FIELDS).filter(c => !reachable.has(c));
    assert.deepEqual(orphans, [],
      `these declare sortable fields and are not queryable: ${orphans.join(', ')}`);
  });
});

describe('a missing set refuses rather than throwing', () => {
  it('an absent collection is a refusal, not a TypeError', () => {
    // The floor. Both doors index the map and pass the result straight through, so the function that
    // RECEIVES it is the only place that can hold this — a check at one call site leaves the other.
    const parsed = parseSortParam('createdAt', 'asc', undefined);
    assert.ok(parsed.error, 'an absent sortable set must produce an error, not throw and not sort');
    assert.match(parsed.error, /not supported/i, 'and the refusal must say what is not supported');
  });

  it('but no sort at all is still no sort, even for a collection with no set', () => {
    // A collection that cannot be sorted must still be QUERYABLE. Refusing an absent `sort` would turn
    // the fix into a worse bug than the crash.
    assert.deepEqual(parseSortParam(undefined, undefined, undefined), { sort: undefined });
  });

  it('and `links` specifically sorts, since that is the collection it was reported on', () => {
    const parsed = parseSortParam('createdAt', 'desc', SORTABLE_FIELDS['links']);
    assert.ok(!parsed.error, `links must accept createdAt: ${parsed.error}`);
    // A link has no name, no title and no type of its own — it IS a pair of endpoints. What is sortable
    // is when it was written and which records it joins.
    const refused = parseSortParam('label', 'desc', SORTABLE_FIELDS['links']);
    assert.ok(refused.error, 'a link has no `label`; sorting by one must be refused rather than ignored');
    assert.match(refused.error, /Sortable fields/, 'and the refusal must name what IS sortable');
  });
});
