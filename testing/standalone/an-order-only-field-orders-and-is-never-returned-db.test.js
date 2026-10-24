/**
 * A field in `ORDER_ONLY_FIELDS` (`pos`) orders rows and is NEVER returned: not by a read, not by a caller's projection, not by the
 * cross-space merge that had to read it to order (bundle-81, design rev 8 §2, decision 11, P26).
 *
 * ## The finding this holds
 *
 * `pos` is the landing position: the default order of every Brain list. It is also local state that no caller may read back. A
 * field in `NEVER_RETURNED_FIELDS` is stripped AT THE STORE READ (`WITHHELD`, `brain/projection.ts`), so it never reaches the
 * cross-space merge, which then sees `pos` undefined on every row and silently orders by `updatedAt` (P26): a wrong order with a
 * 200. The plan's answer is a second class, `ORDER_ONLY_FIELDS` in `brain/recall-shape.ts`, which the merge may read through
 * `projectionForOrderedMerge` and which `withoutOrderOnly(row)` (in `brain/read-projection.ts`) strips INSIDE the merge, so no
 * caller can hand `pos` to an answer by forgetting a line. `posAtSeq` and `writtenHere` are `NEVER_RETURNED_FIELDS`.
 *
 * ## What is derived
 *
 * - **The classes**, from the dist modules: `ORDER_ONLY_FIELDS` and `NEVER_RETURNED_FIELDS`. Floor: `pos` is in the first;
 *   `posAtSeq` and `writtenHere` are in the second; the two classes are disjoint (a field in both is withheld at the store and
 *   the merge cannot order by it, which is P26).
 * - **The answer paths driven against a real database:** a single-space read, a read with a caller's projection that names the
 *   field, and the cross-space merge built from the same pieces the MCP `filter` tool uses (`projectionForOrderedMerge`,
 *   `pageAcrossMembers`, `compareBySort`) over two spaces whose `pos` order is the opposite of their `updatedAt` order.
 * - **The one admitting path** (`projectionForOrderedMerge`) is called only by a merge that strips inside itself: no caller of it
 *   deletes keys by hand (`merge.strip`), because that line is the forgettable one.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: `ORDER_ONLY_FIELDS` and `withoutOrderOnly` do not exist; a single-space read returns `pos`, `posAtSeq` and
 * `writtenHere` (nothing withholds them); `mcp/tools/filter.ts` strips by hand. The merge-order case is green on the base by
 * construction (nothing withholds `pos` yet): it holds the order once the class exists, which is the defect P26 describes.
 * Mutation for the newly covered part: delete the strip inside the merge and the "never returned" case names the row. Restore by
 * hand.
 *
 * Database prefix: `b81tE_`. Run: node --test testing/standalone/an-order-only-field-orders-and-is-never-returned-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openB81Mongo, closeB81Mongo, mongoSkipReason } from './_b81e-mongo.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b81e-order-only-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const [A, B] = ['b81e-a', 'b81e-b'];
// A landed here more recently than B (the higher position), while B was UPDATED more recently than A: the two orders disagree.
const POS_A = 1_790_000_000_000_200;
const POS_B = 1_790_000_000_000_100;

let mongo, query, shape, readProjection;
before(async () => {
  if (skip) return;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: A, label: 'A' }, { id: B, label: 'B' }], networks: [], tokens: [] }, null, 2));
  mongo = await openB81Mongo('order_only');
  (await import('../../server/dist/config/loader.js')).loadConfig();
  query = await import('../../server/dist/brain/query.js');
  shape = await loadDistModule('../../server/dist/brain/recall-shape.js', import.meta.url);
  readProjection = await loadDistModule('../../server/dist/brain/read-projection.js', import.meta.url);
  const row = (space, id, pos, updatedAt) => ({
    _id: id, spaceId: space, name: id, type: 'thing', seq: 5, pos, posAtSeq: 5, writtenHere: true,
    createdAt: updatedAt, updatedAt, description: id,
  });
  await mongo.getDb().collection(`${A}_entities`).insertOne(row(A, 'in-a', POS_A, '2026-01-01T00:00:00.000Z'));
  await mongo.getDb().collection(`${B}_entities`).insertOne(row(B, 'in-b', POS_B, '2026-06-01T00:00:00.000Z'));
});
after(async () => {
  await closeB81Mongo(mongo);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const read = (space, projection) => query.queryBrain(space, 'entities', {}, projection, 10, 5000, 0, undefined);

describe('the classes are derived from the shape module', () => {
  it('ORDER_ONLY_FIELDS holds `pos`; NEVER_RETURNED_FIELDS holds `posAtSeq` and `writtenHere`; the two are disjoint', async () => {
    const loaded = await loadDistModule('../../server/dist/brain/recall-shape.js', import.meta.url);
    const mod = needModule(loaded, ['ORDER_ONLY_FIELDS', 'NEVER_RETURNED_FIELDS'], 'the order-only class');
    const orderOnly = [...mod.ORDER_ONLY_FIELDS];
    assert.ok(orderOnly.length >= 1 && orderOnly.includes('pos'), `ORDER_ONLY_FIELDS is ${JSON.stringify(orderOnly)}, not holding \`pos\``);
    for (const f of ['posAtSeq', 'writtenHere']) assert.ok(mod.NEVER_RETURNED_FIELDS.includes(f), `NEVER_RETURNED_FIELDS does not withhold \`${f}\``);
    assert.deepEqual(orderOnly.filter(f => mod.NEVER_RETURNED_FIELDS.includes(f)), [],
      'a field in both classes is withheld at the store read, so the merge cannot order by it (P26)');
  });

  it('read-projection exports withoutOrderOnly, which strips every order-only field from a row and nothing else', () => {
    const rp = needModule(readProjection ?? { mod: null, path: 'dist/brain/read-projection.js' }, ['withoutOrderOnly'], 'the order-only strip');
    const out = rp.withoutOrderOnly({ _id: 'x', name: 'n', pos: 1 });
    assert.deepEqual(out, { _id: 'x', name: 'n' });
  });
});

describe('an order-only field is never returned', { skip }, () => {
  it('a plain single-space read returns none of `pos`, `posAtSeq`, `writtenHere`', async () => {
    const [row] = await read(A);
    assert.ok(row, 'fixture: the row was not found');
    const { ORDER_ONLY_FIELDS, NEVER_RETURNED_FIELDS } = needModule(shape, ['ORDER_ONLY_FIELDS', 'NEVER_RETURNED_FIELDS'], 'the classes');
    const leaked = [...ORDER_ONLY_FIELDS, ...NEVER_RETURNED_FIELDS].filter(f => f in row);
    assert.deepEqual(leaked, [], 'an answer path returned a local field');
  });

  it('the same behaviour on today\'s names: a plain read leaks neither `pos` nor `writtenHere`', async () => {
    const [row] = await read(A);
    assert.deepEqual(['pos', 'posAtSeq', 'writtenHere'].filter(f => f in row), [],
      'the row came back with its landing position and provenance: a caller can read what the instance keeps to itself');
  });

  it('a caller\'s projection that NAMES the field cannot have it, as `{ embedding: 1 }` cannot', async () => {
    const [row] = await read(A, { name: 1, pos: 1, posAtSeq: 1, writtenHere: 1 });
    assert.ok(row && row.name === 'in-a', 'fixture: the projection read nothing');
    assert.deepEqual(['pos', 'posAtSeq', 'writtenHere'].filter(f => f in row), []);
  });
});

describe('the cross-space merge orders by an order-only field and answers none', { skip }, () => {
  it('two spaces whose position order is the opposite of their updatedAt order merge by position, with no `pos` in the answer', async () => {
    const { pageAcrossMembers } = await import('../../server/dist/spaces/page-across-members.js');
    const { projectionForOrderedMerge } = await import('../../server/dist/brain/projection.js');
    const order = query.LANDING_ORDER ?? { pos: -1, _id: -1 };
    const merge = projectionForOrderedMerge({ name: 1 }, Object.keys(order));
    const page = await pageAcrossMembers({
      members: [A, B], limit: 10, skip: 0, ceiling: 1000, compare: query.compareBySort(order),
      readMember: (mid, lim, sk) => query.queryBrain(mid, 'entities', {}, merge.read, lim, 5000, sk, order),
    });
    assert.ok(page.ok, JSON.stringify(page));
    for (const r of page.rows) for (const k of merge.strip) delete r[k];
    assert.deepEqual(page.rows.map(r => r._id), ['in-a', 'in-b'],
      'the merge did not order by `pos` (A landed most recently; B was updated most recently): it fell back to updatedAt');
    assert.deepEqual(page.rows.flatMap(r => ['pos', 'posAtSeq', 'writtenHere'].filter(f => f in r)), [], 'the merge answered an order-only field');
  });
});

describe('the one admitting path is not a hand-stripped one', () => {
  it('no caller of projectionForOrderedMerge deletes the merge\'s keys itself (the strip is inside the merge)', () => {
    const callers = trackedSources('server/src', { floor: 200 })
      .filter(f => /\bprojectionForOrderedMerge\s*\(/.test(blankComments(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))) && f !== 'server/src/brain/projection.ts');
    assert.ok(callers.length >= 1, 'no caller of projectionForOrderedMerge found: the derivation is broken');
    const byHand = callers.filter(f => /\bdelete\s+row\[k\]|\bmerge\.strip\b/.test(blankComments(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))));
    assert.deepEqual(byHand, [],
      'a caller strips the merge\'s added keys by hand: that line is the forgettable one, so it belongs inside the merge (`withoutOrderOnly`)');
  });
});
