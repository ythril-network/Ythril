/**
 * The background pass names the one index the store refuses and builds every other index of the space, one refused build per
 * case (bundle-101, Q-445 design rev 5.1 items 2 and 7). The other half of the rule, `initSpace` and the later cases of the
 * pass, is `a-failing-space-index-is-contained-and-named-db.test.js`; the two files are one rule cut in two because this case
 * is the longest of them (one pass over a space of every declared index per index), and
 * `a-failing-space-index-cases-are-held-once-across-their-files.test.js` holds that each case is in exactly one of them.
 *
 * ## The rule this holds, and why
 *
 * The background pass (`ensureQueryIndexes`) runs EVERY declared index as its own unit (`eachUnit`): one that the store refuses is
 * said in a line naming the space and the index, and every other index of the space is built. Derived from every index a fresh
 * space carries once all its builders ran (`buildReferenceSpace`) and from the declaration, one refused build per case, on a space
 * whose indexes were all dropped first. The refusal is the store's own (`_failing-index-build.mjs`), and each case asserts it
 * fired: an index the code never builds fails nothing, and is reported as never built.
 *
 * ## Seen red
 *
 * At df2e7534: the background pass on what it builds (`tags_1`, the chrono, files, conflicts and candidates indexes,
 * `lexical_text`, the TTL indexes and more are never built by it) and on the names (a unit is `file tombstone indexes` or `facts
 * type index`, so the line does not name `type_1`; and a refused file tombstone index stops the other four of its unit).
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-failing-space-index-in-the-background-pass-is-named-db.test.js`
 * (a prior `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { loadSpaceIndexDeclaration, buildReferenceSpace, dropSpaceIndexes } from './_space-index-declaration.mjs';
import { failIndexBuild, storeIndexRefusal } from './_failing-index-build.mjs';
import { notStanding, named } from './_failing-index-findings.mjs';

const skip = await mongoSkipReason();

const SUITE = 'q445bgpass';
const T = { timeout: 300_000 };
const REFERENCE_FLOOR = 20;

let door, db, reference, refusal, fault, ensureQueryIndexes;

describe('the background pass names a failing space index and builds the rest (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: ['reference', 'walked'].map(id => ({ id, label: id, folders: [] })) });
    db = door.mongo.getDb();
    ({ ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js'));
    reference = await buildReferenceSpace(db, 'reference');
    refusal = await storeIndexRefusal(db);
    fault = failIndexBuild(Object.getPrototypeOf(db.collection('x')));
  });
  after(async () => { fault?.restore(); await door?.close(); });

  it('the background pass names a refused index and builds every other index of the space', T, async () => {
    assert.ok(reference.size >= REFERENCE_FLOOR, `the reference space carries ${reference.size} indexes: the builders read as not having run`);
    const expected = new Map(reference);
    const declaration = await loadSpaceIndexDeclaration();
    for (const e of declaration.entries ?? []) expected.set(e.id, e);
    const findings = [];
    for (const [id, { suffix, spec }] of expected) {
      await dropSpaceIndexes(db, 'walked');
      fault.fail(`walked_${suffix}`, spec.name, refusal);
      const { lines } = await logLinesDuring(() => ensureQueryIndexes());
      const fired = fault.fired();
      fault.clear();
      if (fired === 0) { findings.push(`${id}: the background pass never builds it`); continue; }
      if (!named(lines, 'walked', spec.name)) findings.push(`${id}: no line names the space and the index`);
      const rest = await notStanding(db, 'walked', expected, id);
      if (rest.length) findings.push(`${id} refused, and then not standing: ${rest.join(', ')}`);
    }
    assert.deepEqual(findings, [], `the background pass over one refused index: ${findings.join('; ')}`);
  });
});
