/**
 * The file stamp report reads its candidates through the one `_id` pager, and its cursor stays the last row it ANSWERED for
 * (`Q-481`, design rev 4 items 5 and 9).
 *
 * ## What is held
 *
 * `readCandidates` (`files/file-stamp-report.ts`) reads `limit + 1` rows by `_id` after `after`, so a full page that ends the space
 * is not called truncated. Converted to `idKeysetPage`, the pager's own `last` is the `(limit + 1)`th row: the one read only to
 * learn that there is more, and not listed. A `nextAfter` taken from the pager would skip that row on the next call, silently.
 *
 *  - **On a truncated answer `nextAfter` is the last LISTED row**, never the extra one, and `after` continues with the extra row
 *    first. GREEN at the base by nature (`nextAfter` is `page.at(-1)` of the slice there): it is here so the conversion cannot
 *    take the pager's `last`.
 *  - **The read goes through `idKeysetPage`**, with the run's time left as its `maxTimeMS` (a request's deadline is an option of
 *    its read, outside any housekeeping scope, `readCandidates`' docblock), and no hand-written `find` of its own. Read off the
 *    function's syntax tree, so a comment naming the pager does not pass it.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-file-stamp-report-reads-candidates-by-the-id-pager-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openStampDoor } from './_file-stamp-door.mjs';
import { REPO_ROOT } from './_sources.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'stamppager';
const REPORT = 'server/src/files/file-stamp-report.ts';

describe('a truncated answer\'s cursor is the last row it lists', { skip }, () => {
  let stamp;
  const PATHS = ['p/a.txt', 'p/b.txt', 'p/c.txt', 'p/d.txt', 'p/e.txt'];
  before(async () => { stamp = await openStampDoor({ suite: S, space: S }); });
  after(async () => { await stamp?.close(); });
  beforeEach(async () => { await stamp.reset(); });

  it('limit 2 of 5: nextAfter is the second row, not the third the limit + 1 read found, and after resumes at the third', async () => {
    for (const p of PATHS) await stamp.s1(p);
    const first = await stamp.report({ limit: 2 });
    assert.equal(first.truncated, true);
    assert.deepEqual(first.rows.map(r => r.path), PATHS.slice(0, 2));
    assert.equal(first.nextAfter, PATHS[1],
      `nextAfter is ${first.nextAfter}: the cursor must be the last row LISTED (${PATHS[1]}); the row the limit + 1 read found `
      + `(${PATHS[2]}) was not answered for, and a cursor past it skips it on the next call`);
    const second = await stamp.report({ limit: 2, after: first.nextAfter });
    assert.equal(second.rows[0]?.path, PATHS[2], 'the next call does not start at the row the first one read but did not list');
    const third = await stamp.report({ limit: 2, after: second.nextAfter });
    assert.equal(third.truncated, false);
    assert.deepEqual([...first.rows, ...second.rows, ...third.rows].map(r => r.path), PATHS, 'the pages do not add up to every row once');
  });
});

/** The function declaration `name` in `file`, parsed (syntax only: comments are trivia and never match). */
function functionNamed(file, name) {
  const sf = ts.createSourceFile(file, readFileSync(join(REPO_ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
  let found;
  const visit = (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n; else ts.forEachChild(n, visit); };
  visit(sf);
  assert.ok(found, `${file} has no function ${name}: re-anchor this test`);
  return found;
}

/** Every call inside `node`, with the name it calls (`f(…)` gives `f`, `x.f(…)` gives `.f`). */
function callsIn(node) {
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      out.push({ node: n, name: ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? `.${e.name.text}` : '?' });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

describe('readCandidates reads through the one _id pager', () => {
  it('calls idKeysetPage with the run\'s time left as maxTimeMS, and sends no find of its own', () => {
    const fn = functionNamed(REPORT, 'readCandidates');
    const calls = callsIn(fn);
    const pager = calls.filter(c => c.name === 'idKeysetPage');
    assert.equal(pager.length, 1,
      `readCandidates calls idKeysetPage ${pager.length} time(s): its _id page is still written by hand (sort, limit, $gt cursor), `
      + 'the four lines db/id-keyset-page.ts exists to hold once');
    const own = calls.filter(c => c.name === '.find');
    assert.deepEqual(own.map(c => c.node.getText()), [], 'readCandidates still sends a find of its own beside the pager');
    const spec = pager[0].node.arguments[0];
    assert.ok(spec && ts.isObjectLiteralExpression(spec), 'the pager\'s spec is not written at the call, so its maxTimeMS cannot be read');
    const maxTime = spec.properties.find(p => p.name && p.name.getText() === 'maxTimeMS');
    assert.ok(maxTime, 'the pager is not handed a maxTimeMS: the candidates read would carry no deadline of the run');
    assert.match(maxTime.getText(), /readBudgetMs\s*\(/, 'the maxTimeMS is not the time LEFT in the run (readBudgetMs)');
  });
});
