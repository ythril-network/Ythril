/**
 * A merge relinks edges onto the survivor, and says which of them will break their label's endpoint rule.
 *
 * ## The gap this closes
 *
 * S-3 made `endpoints` and `functional` refusals at write time, on all three doors — every path that CREATES
 * an edge goes through `upsertEdge`. A merge does not create an edge: it rewrites the `from` or `to` of every
 * edge touching the absorbed entity, directly on the collection, inside a transaction. So a merge was the one
 * way to move an edge onto an end its label forbids, silently.
 *
 * And it is a legitimate thing to do — a merge is how an operator fixes a record typed wrongly, so the two
 * entities having different types is the normal case rather than the exception.
 *
 * ## It WARNS, and the file already established which
 *
 * `detectDuplicateEdges` is merge's own precedent: it finds the edges that would COLLIDE after relinking and
 * reports them on the plan rather than refusing the merge. This follows it.
 *
 * A refusal here would be worse than the problem. An operator who cannot merge two duplicate entities because
 * a rule was declared afterwards is stuck with the duplicates, and the merge is the repair. It is the same
 * reasoning `preExisting` exists for: a schema declared later must never make the records it describes
 * unmaintainable.
 *
 * ## Only the END THAT MOVES is reported
 *
 * The other end is not changed by the merge. If it already breaks the rule that is a stored problem, and
 * `POST /validate-schema` is what reports those — repeating it here would make a merge preview look like it
 * had caused something it found.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-merge-reports-the-endpoint-rules-it-breaks-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merge-endpoints-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const ALICE = 'aaaaaaaa-0000-4000-8000-00000000a1ce';   // person, the survivor in most cases
const BOB = 'aaaaaaaa-0000-4000-8000-00000000b0b0';     // person
const DOC = 'aaaaaaaa-0000-4000-8000-0000000d0c00';     // document
const CAROL = 'aaaaaaaa-0000-4000-8000-00000000ca01';   // person
const DAVE = 'aaaaaaaa-0000-4000-8000-00000000da7e';    // person

let mongo, mergeMod, loader;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

const entity = (id, name, type) => ({ _id: id, spaceId: SPACE, name, type, tags: [], seq: 1 });

/** Rewrite the config with the given edge type schemas, and reload it. */
function withEdgeSchemas(schemas) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'merge-endpoints-test', instanceLabel: 'test', tokens: [], networks: [],
    spaces: [{
      id: SPACE, label: 'General', builtIn: true, folders: [],
      meta: { validationMode: 'strict', typeSchemas: { edge: schemas } },
    }],
  }, null, 2), { mode: 0o600 });
  loader.loadConfig();
}

const edge = (id, from, to, label) => coll('edges').insertOne({
  _id: id, spaceId: SPACE, from, to, label, tags: [], seq: 1,
});

/** The endpoint-rule rows of a plan for merging `absorbed` into `survivor`. */
async function warningsFor(survivor, absorbed) {
  const out = await mergeMod.computeMergePlan(SPACE, survivor, absorbed);
  assert.ok(out.plan, `computeMergePlan errored: ${JSON.stringify(out)}`);
  return out.plan.endpointRuleWarnings;
}

describe('a merge reports the endpoint rules it breaks', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('mergeendpoints');
    loader = await import('../../server/dist/config/loader.js');
    withEdgeSchemas({});
    mergeMod = await import('../../server/dist/brain/merge.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'files', 'tombstones']) await coll(c).deleteMany({});
    await coll('entities').insertMany([
      entity(ALICE, 'Alice', 'person'),
      entity(BOB, 'Bob', 'person'),
      entity(DOC, 'Handbook', 'document'),
      entity(CAROL, 'Carol', 'person'),
      entity(DAVE, 'Dave', 'person'),
    ]);
  });

  it('the planner is reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof mergeMod.computeMergePlan, 'function');
  });

  it('relinking onto a survivor of the wrong type is reported', async () => {
    /*
     * The whole point. `reports_to` runs person → person; merging Bob (a person) into the Handbook (a
     * document) moves `Bob reports_to Alice` onto a document subject, which the label forbids. Before this
     * nothing said so — the transaction committed and the space quietly held an edge its own schema refuses.
     */
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    await edge('e-1', BOB, ALICE, 'reports_to');

    const rows = await warningsFor(DOC, BOB);
    assert.equal(rows.length, 1, `expected one warning, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].edgeId, 'e-1');
    assert.equal(rows[0].end, 'from', 'the row must name the end the merge moves');
    // The FIELD as well as the end, and they come from different places: `end` is computed here, `field` comes
    // out of the validator and depends on which end was resolved. A mutant that resolved the survivor's type
    // onto the wrong end survived every other assertion in this file, because the label constrains both ends
    // and the reason text mentions `person` either way.
    assert.equal(rows[0].field, 'fromType', 'the survivor type was resolved onto the wrong end');
    assert.equal(rows[0].label, 'reports_to');
    assert.match(rows[0].reason, /person/, 'the reason has to say what the label does admit');
  });

  it('and the TO end is reported when that is the end that moves', async () => {
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    await edge('e-2', ALICE, BOB, 'reports_to');

    const rows = await warningsFor(DOC, BOB);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].end, 'to');
    assert.equal(rows[0].field, 'toType', 'the survivor type was resolved onto the wrong end');
  });

  it('a survivor whose type satisfies the rule is not reported', async () => {
    // The control. Without it every case above could be passing because the check reports unconditionally.
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    await edge('e-3', BOB, ALICE, 'reports_to');
    assert.deepEqual(await warningsFor(ALICE, BOB), []);
  });

  it('the end that does NOT move is not reported, even when it breaks the rule', async () => {
    /*
     * A stored problem is not something the merge caused, and `POST /validate-schema` is what reports those.
     * Repeating it on a merge preview would make the preview look like it had created a violation it found —
     * and the operator would clear a rule they cannot clear by merging.
     */
    withEdgeSchemas({ mentions: { endpoints: { from: ['person'], to: ['person'] } } });
    // `Handbook mentions Bob` already breaks the `from` rule; merging Bob into Alice moves only `to`.
    await edge('e-4', DOC, BOB, 'mentions');
    const rows = await warningsFor(ALICE, BOB);
    assert.deepEqual(rows, [],
      'the merge reported a violation on the end it does not touch, so a preview blames the operator for '
      + 'stored data');
  });

  it('a label with no endpoints rule is silent', async () => {
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'] } }, mentions: {} });
    await edge('e-5', BOB, ALICE, 'mentions');
    assert.deepEqual(await warningsFor(DOC, BOB), []);
  });

  it('a functional label warns when the merge gives the survivor a second one', async () => {
    /*
     * The cardinality half, and it is the case only a merge can produce: Alice and Bob each report to
     * somebody, both legitimately, and merging them leaves ONE person with two managers. No write created
     * that — the relink did.
     */
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] }, functional: true } });
    // DIFFERENT objects on purpose. Pointing both at each other makes them collapse into one self-loop after
    // the relink, which is `duplicateEdgeWarnings`' business and not a cardinality breach — the first draft of
    // this case did exactly that and reported nothing, correctly.
    await edge('e-a', ALICE, CAROL, 'reports_to');
    await edge('e-b', BOB, DAVE, 'reports_to');

    const rows = await warningsFor(ALICE, BOB);
    assert.ok(rows.some(r => /functional|more than one|at most one/i.test(r.reason)),
      `no cardinality warning: ${JSON.stringify(rows)}`);
  });

  it('and does NOT warn when the survivor still ends up with one', async () => {
    // The control for the case above: one functional edge before, one after, nothing to say.
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] }, functional: true } });
    await edge('e-c', BOB, CAROL, 'reports_to');
    const rows = await warningsFor(ALICE, BOB);
    assert.deepEqual(rows.filter(r => /functional|more than one|at most one/i.test(r.reason)), [],
      'a single relinked functional edge was reported as a duplicate of itself');
  });

  it('a warning does not refuse the merge', async () => {
    /*
     * The design decision, asserted rather than described. `detectDuplicateEdges` set the precedent: merge
     * reports what relinking will do and lets the operator proceed. Refusing would leave somebody unable to
     * merge two duplicates because a rule was declared after the fact — and the merge is the repair.
     */
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    await edge('e-6', BOB, ALICE, 'reports_to');

    const out = await mergeMod.computeMergePlan(SPACE, DOC, BOB);
    assert.equal(out.plan.endpointRuleWarnings.length, 1, 'the fixture produced no warning to test with');
    assert.equal(out.fullyResolved, true,
      'an endpoint warning made the plan unresolved, so it refuses the merge instead of reporting it — that '
      + 'leaves an operator unable to merge duplicates whenever a rule was declared later');
  });

  it('a violation the merge did not cause is not reported — only the endpoint fields', async () => {
    /*
     * The filter, and a mutant that removed it survived nine cases. `validateEdge` checks three things: the
     * label allowlist, the property schemas, and the endpoint rules. A merge changes NONE of the first two —
     * so reporting them on a merge preview would tell an operator their merge caused something that was
     * stored before they started, and it would be about the one edge they cannot fix by merging.
     *
     * `legacy_rel` is undeclared, which the allowlist refuses once a space has any edge type schema. It was
     * legal when it was written; the relink does not make it less so.
     */
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    await edge('e-legacy', BOB, ALICE, 'legacy_rel');

    const rows = await warningsFor(ALICE, BOB);
    assert.deepEqual(rows, [],
      `a merge reported a violation it did not cause: ${JSON.stringify(rows)}`);
  });

  it('nothing to relink means nothing to say', async () => {
    // Floors the rest: if the check threw or reported on an absorbed entity with no edges, every case above
    // would be passing for the wrong reason.
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    assert.deepEqual(await warningsFor(DOC, BOB), []);
  });
});
