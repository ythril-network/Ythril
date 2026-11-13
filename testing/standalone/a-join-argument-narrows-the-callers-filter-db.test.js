/**
 * Every join argument of the filter (entityName, fromName, toName, and any added later) NARROWS the caller's filter, never replaces a
 * part of it (bundle-267, design r2 "Merge (4)", r3 §3 and §7 "-db, join merge"; vet T7, I4).
 *
 * ## The defect
 *
 * `filterFor(mid)` in `mcp/tools/filter.ts` merged each join's resolution into the caller's predicate by ASSIGNMENT: `entityName` wrote
 * `_id`, `fromName` wrote `from`, `toName` wrote `to`. A caller who sent `filter: { _id: X }` with `entityName` got every record attached
 * to the entity, X or not; one who sent `filter: { from: B }` with `fromName: 'Alice'` got Alice's edges. The answer widened to exactly
 * what the caller had excluded. The fix joins every resolution under `$and`, which the schema-version predicate does too.
 *
 * ## How the set of joins is found
 *
 * From the code: every `nameArg('<name>')` in `server/src/mcp/tools/filter.ts`, with a floor of the three there are today, so a join added
 * later is in this test the day it lands (and fails it until it has a case below).
 *
 * ## Seen red at b299cde3
 *
 * entityName with a caller `_id`, fromName with a caller `from`, toName with a caller `to`: each answers the join's records, not the
 * intersection (behaviour). The `$or` cases hold today (an assignment leaves `$or` alone); they keep the fix from breaking them.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { REPO_ROOT } from './_sources.mjs';

const skip = await mongoSkipReason();
const SPACE = 'svjoin';

const JOINS = [...readFileSync(join(REPO_ROOT, 'server/src/mcp/tools/filter.ts'), 'utf8').matchAll(/\bnameArg\('(\w+)'\)/g)].map(m => m[1]);

let door;
const id = {};

const rowsOf = (r) => (r.structured?.results ?? []).map(x => x._id).sort();

describe('a join argument narrows the caller\'s filter (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'svjoin', spaces: [{ id: SPACE, label: SPACE, folders: [], meta: { suppressEmbeddings: true } }] });
    for (const name of ['Alice', 'Bob', 'Carol']) {
      const r = await door.call('save_entity', { space: SPACE, name, type: 'person' });
      assert.ok(!r.result.isError, r.text);
      id[name] = (await door.coll(SPACE, 'entities').findOne({ name }))?._id;
    }
    for (const [key, about] of [['f1', 'Alice'], ['f2', 'Alice'], ['f3', 'Alice'], ['f4', 'Bob']]) {
      const r = await door.call('save_fact', { space: SPACE, fact: `${about} said something, number ${key}.`, linkEntities: [id[about]] });
      assert.ok(!r.result.isError, r.text);
      id[key] = (await door.coll(SPACE, 'facts').findOne({ fact: `${about} said something, number ${key}.` }))?._id;
    }
    for (const [key, from, to] of [['e1', 'Alice', 'Bob'], ['e2', 'Alice', 'Carol'], ['e3', 'Bob', 'Carol']]) {
      const r = await door.call('save_edge', { space: SPACE, from: id[from], to: id[to], label: 'knows' });
      assert.ok(!r.result.isError, r.text);
      id[key] = (await door.coll(SPACE, 'edges').findOne({ from: id[from], to: id[to], label: 'knows' }))?._id;
    }
    for (const [k, v] of Object.entries(id)) assert.ok(typeof v === 'string' && v.length > 0, `no id for ${k}`);
  });
  after(async () => { await door?.close(); });

  it('the join arguments are read from filter.ts (a floor of three)', () => {
    assert.ok(JOINS.length >= 3, `found ${JSON.stringify(JOINS)}: the source moved, re-anchor the derivation`);
    for (const j of ['entityName', 'fromName', 'toName']) assert.ok(JOINS.includes(j), `${j} is no longer a join in filter.ts`);
  });

  /** Per join: the collection, its value, and caller filters with the answer that is their intersection with the join. */
  const CASES = {
    entityName: () => ({ collection: 'facts', value: 'Alice', narrow: [
      [{ _id: id.f2 }, [id.f2]],
      [{ _id: { $in: [id.f1, id.f4] } }, [id.f1]],
      [{ $or: [{ _id: id.f1 }, { _id: id.f4 }] }, [id.f1]],
    ] }),
    fromName: () => ({ collection: 'edges', value: 'Alice', narrow: [
      [{ from: id.Bob }, []],
      [{ _id: id.e2 }, [id.e2]],
      [{ $or: [{ to: id.Bob }, { to: id.Alice }] }, [id.e1]],
    ] }),
    toName: () => ({ collection: 'edges', value: 'Carol', narrow: [
      [{ to: id.Bob }, []],
      [{ _id: id.e3 }, [id.e3]],
      [{ $or: [{ from: id.Bob }, { from: id.Carol }] }, [id.e3]],
    ] }),
  };

  for (const join_ of JOINS) {
    for (const transport of ['mcp', 'rest']) {
      it(`${join_} (${transport}): a caller filter on _id, on the field the join resolves, and in $or is narrowed, never replaced`, async () => {
        assert.ok(CASES[join_], `${join_} is a join argument with no case here: add its collection and caller filters`);
        const { collection, value, narrow } = CASES[join_]();
        const alone = await door.call('filter', { space: SPACE, collection, [join_]: value, limit: 100 }, { transport });
        assert.ok(!alone.result.isError, alone.text);
        assert.ok(rowsOf(alone).length > 0, `${join_} alone selects nothing: the fixture is wrong`);
        for (const [filter, want] of narrow) {
          const r = await door.call('filter', { space: SPACE, collection, filter, [join_]: value, limit: 100 }, { transport });
          assert.ok(!r.result.isError, r.text);
          assert.deepEqual(rowsOf(r), [...want].sort(), `${join_} with filter ${JSON.stringify(filter)} replaced the caller's predicate instead of narrowing it`);
          assert.equal(r.structured?.total, want.length, `${join_} with filter ${JSON.stringify(filter)}: total counts a wider match than the rows`);
        }
      });
    }
  }
});
