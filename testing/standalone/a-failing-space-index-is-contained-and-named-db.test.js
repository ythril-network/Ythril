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
 *   refuses is said in a line naming the space, the index and its collection, and every other index of the space is built. Then a
 *   best-effort index warned once, a store that does not answer, and a sweep tick whose listing hangs.
 *
 * Every refusal is the store's own (`_failing-index-build.mjs`), and each case asserts it fired: an index the code never builds
 * fails nothing, and is reported as never built.
 *
 * ## Two passes, not one per index
 *
 * The two cases that hold the rule for every index used to refuse ONE index per pass: the background case ran one full pass over
 * a space whose indexes were all dropped first for each of the 73 declared and derived indexes (N passes of N index builds, each
 * build a two-phase commit on a replica set), and the `initSpace` case made one new space per contained index. The background case
 * was cut into a file of its own to run beside its neighbours and took 3.7 times as long there, and the pair cost 2.6 times the one
 * file (Q-937). They are one file again, and each case refuses HALF of the indexes per pass:
 *
 * - the indexes are split into two passes by index NAME, alternating over the names in the order they are declared, so every index
 *   of one name (`type_1` is declared on four collections) is refused in the same pass, which makes two same-named indexes of
 *   different collections refused together, and the case asserts that it did;
 * - in each pass every refused index fired on its own and has a line naming `index <name> on <collection>` (the unit's own words:
 *   a name alone matches the same-named index of another collection), and every index NOT refused in that pass stands as
 *   declared;
 * - the background case ends with a pass in which nothing is refused and everything stands, so the cases after it start from a
 *   standing space.
 *
 * What two passes hold that N passes held: a refusal that stops the rest of the space leaves a later refused index never fired or a
 * later kept index not standing, in whichever pass it is; a refusal that skips only the next unit leaves that unit either refused
 * and never fired or kept and not standing. What the old case did not claim and this does: two refusals in one pass are both named.
 *
 * ## Seen red
 *
 * At df2e7534: the `initSpace` case on the declaration (`spaces/space-indexes.ts` is not built); the background pass on what it
 * builds (`tags_1`, the chrono, files, conflicts and candidates indexes, `lexical_text`, the TTL indexes and more are never built by
 * it) and on the names (a unit is `file tombstone indexes` or `facts type index`, so the line does not name `type_1`; and a refused
 * file tombstone index stops the other four of its unit).
 *
 * At b356, the merged cases, one planted defect per run in the runner's copy of the product (the first red lines are on the ticket):
 * - a unit's failure ends the remaining units (`eachUnit` stops after the first failure): both passes of the background case;
 *   `initSpace` builds its indexes in a loop of its own, not through `eachUnit`, so it is not reached by this one;
 * - the `initSpace` loop stops at the first refused index (`buildSpaceIndexesAtInit`), or a `report` failure rejects: the
 *   `initSpace` case;
 * - the shared failure reporter's line stops naming the unit: the `initSpace` case and both passes of the background case;
 * - the unit of an index stops naming its collection (`spaceIndexUnit`, the defect that tells the collection-aware name check from
 *   a name-only one): the `initSpace` case, both passes of the background case, and the two cases on the best-effort warning.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-failing-space-index-is-contained-and-named-db.test.js`
 * (a prior `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { loadSpaceIndexDeclaration, requireSpaceIndexDeclaration, buildReferenceSpace, indexesOfSpace, dropSpaceIndexes } from './_space-index-declaration.mjs';
import { failIndexBuilds, storeIndexRefusal } from './_failing-index-build.mjs';
import { notStanding, named } from './_failing-index-findings.mjs';
import { settleWithin } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const SUITE = 'q445contained';
const T = { timeout: 300_000 };
const REFERENCE_FLOOR = 20;

let door, db, reference, refusal, fault, initSpace, ensureQueryIndexes;

/** The collection and index a refusal arms for `entry` (`{ suffix, spec }`) on `space`. */
const targetOf = (space, entry) => ({ collectionName: `${space}_${entry.suffix}`, indexName: entry.spec.name });

/**
 * `entries` (index id to `{ suffix, spec }`) split into the two passes: the k-th distinct index NAME, in the order of `entries`, goes
 * to pass k mod 2, with every index of that name. So two indexes of one name on different collections are refused in one pass.
 *
 * @returns {[string, { suffix: string, spec: { name: string } }][][]} the two passes, each `[id, entry]` pairs
 */
function inTwoPasses(entries) {
  const passOfName = new Map();
  const passes = [[], []];
  for (const [id, entry] of entries) {
    if (!passOfName.has(entry.spec.name)) passOfName.set(entry.spec.name, passOfName.size % 2);
    passes[passOfName.get(entry.spec.name)].push([id, entry]);
  }
  assert.ok(passes[0].length > 0 && passes[1].length > 0, `${entries.size} indexes of ${passOfName.size} names make one pass of nothing: the case would refuse everything at once`);
  return passes;
}

describe('a failing space index is contained and named (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: ['reference', 'walked'].map(id => ({ id, label: id, folders: [] })) });
    db = door.mongo.getDb();
    ({ initSpace } = await import('../../server/dist/spaces/lifecycle.js'));
    ({ ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js'));
    reference = await buildReferenceSpace(db, 'reference');
    refusal = await storeIndexRefusal(db);
    fault = failIndexBuilds(Object.getPrototypeOf(db.collection('x')));
  });
  after(async () => { fault?.restore(); await door?.close(); });

  it('initSpace on a new space is not stopped by a refused report or best-effort index, and builds every other declared one', T, async () => {
    const declared = await requireSpaceIndexDeclaration(assert);
    const contained = declared.filter(e => e.policy !== 'throw');
    assert.ok(contained.some(e => e.policy === 'report') && contained.some(e => e.policy === 'best-effort'),
      `the declaration holds no report or no best-effort index (policies: ${[...new Set(declared.map(e => e.policy))].join(', ')})`);
    const expected = new Map(declared.map(e => [e.id, e]));
    const findings = [];
    for (const [pass, refused] of inTwoPasses(new Map(contained.map(e => [e.id, e]))).entries()) {
      const space = `nostop-${pass}`;
      fault.fail(refused.map(([, e]) => targetOf(space, e)), refusal);
      const { lines, result } = await logLinesDuring(() => initSpace(space, { waitForVectorReady: false }).then(() => 'resolved', err => err));
      const fired = new Map(refused.map(([id, e]) => [id, fault.firedOf(`${space}_${e.suffix}`, e.spec.name)]));
      fault.clear();
      // A rejection comes first: the indexes after the one that stopped it never fired, which is its consequence and not a finding of its own.
      if (result !== 'resolved') { findings.push(`pass ${pass}: ${refused.length} refused, initSpace failed: ${String(result?.message ?? result)}`); continue; }
      for (const [id, e] of refused) if (fired.get(id) === 0) findings.push(`${id} (${e.policy}): initSpace on a new space never built it`);
      const built = refused.filter(([id]) => fired.get(id) > 0);
      const rest = await notStanding(db, space, expected, refused.map(([id]) => id));
      if (rest.length) findings.push(`pass ${pass}: ${refused.length} refused, and then not standing: ${rest.join(', ')}`);
      for (const [id, e] of built) {
        if (e.policy === 'report' && !named(lines, space, e.suffix, e.spec.name)) findings.push(`${id} (report): no line names the space, the index and its collection`);
      }
    }
    assert.deepEqual(findings, [], `a refused index stopped initSpace or took other indexes with it: ${findings.join('; ')}`);
  });

  it('the background pass names a refused index and builds every other index of the space', T, async () => {
    assert.ok(reference.size >= REFERENCE_FLOOR, `the reference space carries ${reference.size} indexes: the builders read as not having run`);
    const expected = new Map(reference);
    const declaration = await loadSpaceIndexDeclaration();
    for (const e of declaration.entries ?? []) expected.set(e.id, e);
    const passes = inTwoPasses(expected);
    // The premise of the same-name claim: one pass refuses two indexes of one name on different collections, or the case would hold
    // nothing the name-only check did not.
    const sameName = passes.map(refused => {
      const byName = Map.groupBy(refused, ([, e]) => e.spec.name);
      return [...byName.values()].some(group => new Set(group.map(([, e]) => e.suffix)).size > 1);
    });
    assert.ok(sameName.some(Boolean), 'no pass refuses two same-named indexes of different collections: the names are all different now, or the split lost them');
    const findings = [];
    for (const [pass, refused] of passes.entries()) {
      await dropSpaceIndexes(db, 'walked');
      fault.fail(refused.map(([, e]) => targetOf('walked', e)), refusal);
      const { lines } = await logLinesDuring(() => ensureQueryIndexes());
      const fired = new Map(refused.map(([id, e]) => [id, fault.firedOf(`walked_${e.suffix}`, e.spec.name)]));
      fault.clear();
      for (const [id, e] of refused) {
        if (fired.get(id) === 0) findings.push(`pass ${pass}: ${id}: the background pass never builds it`);
        else if (!named(lines, 'walked', e.suffix, e.spec.name)) findings.push(`pass ${pass}: ${id}: no line names the space, the index and its collection`);
      }
      const rest = await notStanding(db, 'walked', expected, refused.map(([id]) => id));
      if (rest.length) findings.push(`pass ${pass}: ${refused.length} refused, and then not standing: ${rest.join(', ')}`);
    }
    // The pass in which nothing is refused: what the refusals left out is built now, so the cases below start from a standing space.
    const { lines: clean } = await logLinesDuring(() => ensureQueryIndexes());
    const rest = await notStanding(db, 'walked', expected);
    if (rest.length) findings.push(`the pass after the refusals, with nothing refused, left not standing: ${rest.join(', ')}`);
    const failed = clean.filter(l => /failed for space 'walked'/.test(l));
    if (failed.length) findings.push(`the pass after the refusals, with nothing refused, said: ${failed.join(' | ')}`);
    assert.deepEqual(findings, [], `the background pass over refused indexes: ${findings.join('; ')}`);
  });

  // Added by the bundle-101 pre-ship lens (L11): a best-effort index is best effort in the background pass too. The pass ran every
  // index as a unit, so a store that cannot build the text index reported a COUNTED space failure for it at every boot, while the
  // declaration says the space works without it. The rule: a refused best-effort index is a warning naming the space and the index,
  // said once while it stays refused (a second pass says nothing), and never the pass's space-failure line.
  it('the background pass warns once about a refused best-effort index and reports no space failure for it', T, async () => {
    const declared = await requireSpaceIndexDeclaration(assert);
    const bestEffort = declared.filter(e => e.policy === 'best-effort');
    assert.ok(bestEffort.length >= 1, 'the declaration holds no best-effort index');
    const findings = [];
    for (const e of bestEffort) {
      await dropSpaceIndexes(db, 'walked');
      fault.fail([targetOf('walked', e)], refusal);
      const first = (await logLinesDuring(() => ensureQueryIndexes())).lines;
      const second = (await logLinesDuring(() => ensureQueryIndexes())).lines;
      const fired = fault.fired();
      fault.clear();
      if (fired < 2) { findings.push(`${e.id}: the two passes did not both try it (${fired})`); continue; }
      const failureLine = (lines) => lines.some(l => /failed for space 'walked'/.test(l) && l.includes(e.spec.name));
      if (failureLine(first) || failureLine(second)) findings.push(`${e.id}: reported as a space failure of the pass`);
      if (!named(first, 'walked', e.suffix, e.spec.name)) findings.push(`${e.id}: no warning names the space and the index`);
      if (named(second, 'walked', e.suffix, e.spec.name)) findings.push(`${e.id}: warned again by the next pass while nothing changed`);
    }
    await ensureQueryIndexes();
    assert.deepEqual(findings, [], `a refused best-effort index in the background pass: ${findings.join('; ')}`);
  });

  // Added by the bundle-101 re-review (Q4): a best-effort failure that is the STORE not answering is not the index's. Swallowed
  // into the once-only warning, it burned that warning on a dead store and hid the store's condition from the walk whenever the
  // best-effort index was the last thing a space built. The rule: such a failure reaches the walk (its stop line), no "not built"
  // warning is said for it, and a later real refusal of the same index is still warned.
  it('a best-effort build that meets a store that is not answering is the walk\'s verdict, and does not use up the warning', T, async () => {
    const { MongoNetworkError } = await import('mongodb');
    const declared = await requireSpaceIndexDeclaration(assert);
    const e = declared.find(d => d.policy === 'best-effort');
    assert.ok(e, 'the declaration holds no best-effort index');
    await dropSpaceIndexes(db, 'walked');
    fault.fail([targetOf('walked', e)], new MongoNetworkError('connection closed by the test'));
    const down = (await logLinesDuring(() => ensureQueryIndexes())).lines;
    const firedDown = fault.fired();
    fault.fail([targetOf('walked', e)], refusal);
    const refused = (await logLinesDuring(() => ensureQueryIndexes())).lines;
    const firedRefused = fault.fired();
    fault.clear();
    await ensureQueryIndexes();
    const findings = [];
    if (firedDown === 0 || firedRefused === 0) findings.push(`the build was not tried (${firedDown}, ${firedRefused})`);
    if (named(down, 'walked', e.suffix, e.spec.name) && down.some(l => /not built/.test(l))) findings.push('a dead store was said as the index not being built');
    if (!down.some(l => /query indexes stopped: the store is not answering/.test(l)) && !down.some(l => /store is not answering/.test(l))) {
      findings.push('the walk did not hear that the store is not answering');
    }
    if (!named(refused, 'walked', e.suffix, e.spec.name)) findings.push('the real refusal after it was not warned: the dead store used up the warning');
    assert.deepEqual(findings, [], findings.join('; '));
  });

  // Added by the bundle-101 re-review (Q3): the TTL sweep looks at every space's indexes at every tick, and the listing was
  // unbounded; one space whose listing hangs held the tick, and with the job's single flight every later tick, so retention stopped
  // for every space. The rule: a listing is bounded by the housekeeping figure, a hung one is that space's failure said through the
  // walk, and the other spaces' sweep indexes are still built in the same tick.
  it('a sweep tick whose index listing hangs for one space says that space and still indexes the others', T, async () => {
    const { ensureSweepIndexes } = await import('../../server/dist/brain/ttl-sweep.js');
    const bound = await import('../../server/dist/db/write-bound.js');
    const proto = Object.getPrototypeOf(db.collection('x'));
    const original = proto.listIndexes;
    const hung = 'reference_facts';
    let hangs = 0;
    proto.listIndexes = function listIndexes(...args) {
      if (this.collectionName === hung) { hangs++; return { toArray: () => new Promise(() => {}) }; }
      return original.apply(this, args);
    };
    bound.setWriteBoundForTest({ housekeepingOpMs: 1500 });
    await db.collection('walked_facts').dropIndex('ttl_expireAt').catch(() => {});
    let lines = [];
    let outcome;
    try {
      // `settleWithin` clears its own timer: a bare race against a 20 s timer kept the process alive that long after the last case.
      const ticked = await settleWithin(logLinesDuring(() => ensureSweepIndexes()), 20_000);
      if (ticked.settled && !ticked.ok) throw ticked.error;
      outcome = ticked.settled ? 'ended' : 'hung';
      if (ticked.settled) lines = ticked.value.lines;
    } finally {
      proto.listIndexes = original;
      bound.setWriteBoundForTest(null);
    }
    const findings = [];
    if (hangs === 0) findings.push('the tick never listed the hung collection');
    if (outcome !== 'ended') findings.push('the tick did not end: one hung listing held it');
    else {
      if (!lines.some(l => l.includes("'reference'") && /TTL sweep: indexes/.test(l))) findings.push('no line names the space whose listing hung');
      if (!(await indexesOfSpace(db, 'walked')).has('facts:ttl_expireAt')) findings.push('the other space\'s sweep index was not built in the same tick');
    }
    assert.deepEqual(findings, [], findings.join('; '));
  });
});
