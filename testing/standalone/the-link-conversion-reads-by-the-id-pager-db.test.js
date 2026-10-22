/**
 * The link conversion reads every record of a space a page at a time by `_id`, and reads only what a record's links are built
 * from (`Q-481`, design rev 4 items 3 and 9).
 *
 * ## What is held
 *
 *  - **More than one page converts every row.** A space holding `2 * PAGE + 1` facts that each carry a legacy `entityIds` array
 *    gets a link record for every one of them, and the report scans every one. `PAGE` is read from `brain/links-conversion.ts`
 *    (the design names it there), so the case crosses a page boundary whatever the figure becomes. GREEN at the base by nature
 *    (its hand loop pages correctly): it is here so the conversion to `idKeysetPage` cannot drop a page.
 *  - **The page reads `{_id, author}` plus the three legacy arrays**, derived from `legacyField` of entity, fact and chrono
 *    (`brain/link-adjacency.ts`), never typed out: `reconcileLinksForDocument` builds the links from those arrays and the author,
 *    and a page that reads whole rows reads a vector per row. Read off the driver's own command events: the conversion's page
 *    reads are the finds on a link-bearing collection sorted first by `_id` and limited to `PAGE`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-link-conversion-reads-by-the-id-pager-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { REPO_ROOT } from './_sources.mjs';

const skip = await mongoSkipReason();
const SUITE = 'linkpager';
const SPACE = 'link-pager';
const CONVERSION = 'server/src/brain/links-conversion.ts';
const AUTHOR = { instanceId: 'link-pager-test', instanceLabel: 'test' };
const E1 = 'aaaaaaaa-0000-4000-8000-0000000000e1';

/** `const PAGE = <n>` of the conversion, read from its syntax tree: the figure the case must cross. */
function pageOfConversion() {
  const sf = ts.createSourceFile(CONVERSION, readFileSync(join(REPO_ROOT, CONVERSION), 'utf8'), ts.ScriptTarget.Latest, true);
  let page;
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'PAGE' && n.initializer && ts.isNumericLiteral(n.initializer)) {
      page = Number(n.initializer.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(Number.isInteger(page) && page > 0, `${CONVERSION} declares no numeric PAGE: re-anchor this test to the figure the conversion pages by`);
  return page;
}
const PAGE = pageOfConversion();

/** The first key a find command sorts by: the driver hands `sort` over as a `Map`, so `Object.keys` of it is empty. */
const firstSortKey = (c) => (c.sort instanceof Map ? [...c.sort.keys()][0] : c.sort ? Object.keys(c.sort)[0] : undefined);

let door, convert, legacyField, bearing;
/** The finds the server's client sent on a link-bearing collection, as the driver handed them over. */
const finds = [];

describe('the link conversion pages by _id over every row and reads only what links are built from', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: [{ id: SPACE, label: SPACE, folders: [] }], monitorCommands: true });
    ({ legacyField } = await import('../../server/dist/brain/link-adjacency.js'));
    const { LINK_BEARING_COLLECTIONS } = await import('../../server/dist/brain/links.js');
    bearing = new Set(Object.entries(LINK_BEARING_COLLECTIONS).filter(([, k]) => k).map(([suffix]) => `${SPACE}_${suffix}`));
    assert.ok(bearing.size >= 3, `only ${bearing.size} link-bearing collection(s): the derivation is broken`);
    door.mongo.getMongo().on('commandStarted', (ev) => {
      if (ev.commandName === 'find' && bearing.has(ev.command?.find)) finds.push(ev.command);
    });
    convert = await import('../../server/dist/brain/links-conversion.js');

    await door.coll(SPACE, 'entities').insertOne({ _id: E1, spaceId: SPACE, name: 'One', type: 'thing', tags: [], properties: {}, author: AUTHOR, seq: 1 });
    const n = 2 * PAGE + 1;
    const id = (i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await door.coll(SPACE, 'facts').insertMany(Array.from({ length: n }, (_, i) => ({
      _id: id(i), spaceId: SPACE, fact: `fact ${i}`, type: '', tags: [], entityIds: [E1], author: AUTHOR, seq: 10 + i,
    })));
  });
  after(async () => { await door?.close(); });

  let report;
  it(`converts every one of 2 * PAGE + 1 (${2 * PAGE + 1}) facts, across the page boundaries (green at base by nature)`, async () => {
    finds.length = 0;
    report = await convert.convertSpaceLinks(SPACE);
    assert.equal(report.failed, 0);
    assert.equal(report.scanned.facts, 2 * PAGE + 1, `the conversion scanned ${report.scanned.facts} facts of ${2 * PAGE + 1}: a page was dropped or read twice`);
    const links = await door.coll(SPACE, 'links').countDocuments({ fromKind: 'fact', to: E1 });
    assert.equal(links, 2 * PAGE + 1, `${links} link record(s) for ${2 * PAGE + 1} facts each linking one entity`);
  });

  it('each page reads {_id, author} and the legacy arrays of entity, fact and chrono, derived from legacyField', () => {
    assert.ok(report, 'the conversion did not run: see the case above');
    const pages = finds.filter(c => firstSortKey(c) === '_id' && Number(c.limit) === PAGE);
    assert.ok(pages.length >= bearing.size,
      `${pages.length} page read(s) on ${bearing.size} link-bearing collections: the command monitor or the page filter sees nothing`);
    const want = ['_id', 'author', ...['entity', 'fact', 'chrono'].map(k => legacyField(k))].sort();
    for (const c of pages) {
      assert.ok(c.projection && typeof c.projection === 'object',
        `a conversion page of ${c.find} was read with no projection: the walk reads whole rows (a vector each) to build links from three arrays and an author`);
      assert.deepEqual(Object.keys(c.projection).sort(), want, `the projection of ${c.find} is not {_id, author} plus legacyField of entity, fact and chrono`);
      assert.ok(Object.values(c.projection).every(v => v === 1), `the projection of ${c.find} excludes rather than names: ${JSON.stringify(c.projection)}`);
    }
  });
});
