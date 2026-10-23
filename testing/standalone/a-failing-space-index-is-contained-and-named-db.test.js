/**
 * One per-space index that cannot be built stops nothing else: a best-effort or reported index does not stop `initSpace`, and the
 * background pass names the index that failed and builds every other one (bundle-101, Q-445 design rev 5.1 items 1, 2 and 7).
 *
 * ## The rule this holds, and why
 *
 * Four failure policies exist (premise R4): the identity index throws, the guard is caught and reported, `lexical_text` is best
 * effort, the TTL indexes are warned. The declaration carries each index's policy, so
 *
 * - **`initSpace` on a space created now** builds every declared index (all of its collections are new, so the not-boot-safe ones
 *   too, R5), and an index whose policy is `report` or `best-effort` that the store refuses does not stop it: it resolves, every
 *   other declared index stands, and a `report` one is said through the shared reporter naming the space and the index;
 * - **the background pass** (`ensureQueryIndexes`) runs EVERY declared index as its own unit (`eachUnit`): one that the store
 *   refuses is said in a line naming the space and the index, and every other index of the space is built. Derived from every index
 *   a fresh space carries once all its builders ran (`buildReferenceSpace`) and from the declaration, one refused build per case,
 *   on a space whose indexes were all dropped first.
 *
 * Every refusal is the store's own (`_failing-index-build.mjs`), and each case asserts it fired: an index the code never builds
 * fails nothing, and is reported as never built.
 *
 * ## Seen red
 *
 * At df2e7534: the `initSpace` case on the declaration (`spaces/space-indexes.ts` is not built); the background pass on what it
 * builds (`tags_1`, the chrono, files, conflicts and candidates indexes, `lexical_text`, the TTL indexes and more are never built by
 * it) and on the names (a unit is `file tombstone indexes` or `facts type index`, so the line does not name `type_1`; and a refused
 * file tombstone index stops the other four of its unit).
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-failing-space-index-is-contained-and-named-db.test.js`
 * (a prior `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import {
  loadSpaceIndexDeclaration, requireSpaceIndexDeclaration, indexesOfSpace, buildReferenceSpace, dropSpaceIndexes, specDifference,
} from './_space-index-declaration.mjs';
import { failIndexBuild, storeIndexRefusal } from './_failing-index-build.mjs';

const skip = await mongoSkipReason();

const SUITE = 'q445contained';
const T = { timeout: 300_000 };
const OPTIONAL = 'lexical_text';
const REFERENCE_FLOOR = 20;

let door, db, reference, refusal, fault, initSpace, ensureQueryIndexes;

/** The findings of `expected` against what `space` carries now, `skip` (an `indexId`) left out. */
async function notStanding(space, expected, skipId) {
  const now = await indexesOfSpace(db, space);
  const out = [];
  for (const [id, { spec }] of expected) {
    if (id === skipId) continue;
    const got = now.get(id);
    if (!got) { if (spec.name !== OPTIONAL) out.push(`${id} missing`); continue; }
    const diff = specDifference(spec, got.spec);
    if (diff.length) out.push(`${id} differs in ${diff.join(', ')}`);
  }
  return out;
}

/** Whether one emitted line names the space and the index. */
const named = (lines, space, name) => lines.some(l => l.includes(`'${space}'`) && l.includes(name));

describe('a failing space index is contained and named (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: ['reference', 'walked'].map(id => ({ id, label: id, folders: [] })) });
    db = door.mongo.getDb();
    ({ initSpace } = await import('../../server/dist/spaces/lifecycle.js'));
    ({ ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js'));
    reference = await buildReferenceSpace(db, 'reference');
    refusal = await storeIndexRefusal(db);
    fault = failIndexBuild(Object.getPrototypeOf(db.collection('x')));
  });
  after(async () => { fault?.restore(); await door?.close(); });

  it('initSpace on a new space is not stopped by a refused report or best-effort index, and builds every other declared one', T, async () => {
    const declared = await requireSpaceIndexDeclaration(assert);
    const contained = declared.filter(e => e.policy !== 'throw');
    assert.ok(contained.some(e => e.policy === 'report') && contained.some(e => e.policy === 'best-effort'),
      `the declaration holds no report or no best-effort index (policies: ${[...new Set(declared.map(e => e.policy))].join(', ')})`);
    const expected = new Map(declared.map(e => [e.id, e]));
    const findings = [];
    for (const [i, e] of contained.entries()) {
      const space = `nostop-${i}`;
      fault.fail(`${space}_${e.suffix}`, e.spec.name, refusal);
      const { lines, result } = await logLinesDuring(() => initSpace(space, { waitForVectorReady: false }).then(() => 'resolved', err => err));
      const fired = fault.fired();
      fault.clear();
      if (fired === 0) { findings.push(`${e.id} (${e.policy}): initSpace on a new space never built it`); continue; }
      if (result !== 'resolved') { findings.push(`${e.id} (${e.policy}): initSpace failed: ${String(result?.message ?? result)}`); continue; }
      const rest = await notStanding(space, expected, e.id);
      if (rest.length) findings.push(`${e.id} (${e.policy}) refused, and then not standing: ${rest.join(', ')}`);
      if (e.policy === 'report' && !named(lines, space, e.spec.name)) findings.push(`${e.id} (report): no line names the space and the index`);
    }
    assert.deepEqual(findings, [], `a refused index stopped initSpace or took other indexes with it: ${findings.join('; ')}`);
  });

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
      const rest = await notStanding('walked', expected, id);
      if (rest.length) findings.push(`${id} refused, and then not standing: ${rest.join(', ')}`);
    }
    assert.deepEqual(findings, [], `the background pass over one refused index: ${findings.join('; ')}`);
  });
});
