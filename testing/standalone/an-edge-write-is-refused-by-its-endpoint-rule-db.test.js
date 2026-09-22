/**
 * A write that breaks an edge label's endpoint or cardinality rule is REFUSED, not merely reported.
 *
 * ## What shipped before this, and why it was not enough
 *
 * `endpoints` and `functional` landed with one consumer: the `validate-schema` dry run, which lists stored edges
 * that break a rule. Useful, and it is an audit — an operator has to go and ask. Nothing stopped the next write
 * creating the violation it would then report.
 *
 * ## Why a database test and not a pure one
 *
 * The rules need the TYPE of the entity at each end and a count of edges sharing a subject, and neither is in
 * the payload. `schema-validation.test.js` covers the decision with plain objects; what is unproven without a
 * database is that the write path actually LOOKS — that it resolves the endpoints it was handed and passes what
 * it found. A source read cannot tell a resolution that happens from one that is written and never reached.
 *
 * ## The two things it would be easy to get wrong, and both have a case
 *
 * **A pre-existing violation must not block an unrelated edit.** `classifyUpdateViolations` already splits
 * violations into `preExisting` and `introduced` for properties, and endpoint types have to travel the same
 * road: a space that declares a rule on a label it has already used must not become a space where nobody can fix
 * a typo in a description. The rule is enforced on what the write INTRODUCES.
 *
 * **An edge is not its own duplicate.** `functional` counts the OTHER edges from the subject, so re-upserting
 * the same triplet must not report the edge against itself. That is an off-by-one whose symptom is that a
 * functional label can be written once and never touched again.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/an-edge-write-is-refused-by-its-endpoint-rule-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-edge-endpoints-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const ALICE = 'aaaaaaaa-0000-4000-8000-00000000a1ce';
const BOB   = 'aaaaaaaa-0000-4000-8000-00000000b0b0';
const DOC    = 'aaaaaaaa-0000-4000-8000-0000000d0c00';

let mongo, edgesMod, bulkMod, loader;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

const entity = (id, name, type) => ({ _id: id, spaceId: SPACE, name, type, tags: [], seq: 1 });

/**
 * Rewrite the config with the given edge type schemas, and reload it.
 *
 * `strictLinkage` is a parameter because one case is about the space that turns it OFF: that setting is
 * what says dangling references are allowed, and a gate that could not build such a space could not tell
 * a refusal about EXISTENCE from one about endpoint types.
 */
function withEdgeSchemas(schemas, { strictLinkage = true } = {}) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'edge-endpoints-test', instanceLabel: 'test', tokens: [], networks: [],
    spaces: [{
      id: SPACE, label: 'General', builtIn: true, folders: [], completeLinkage: true,
      meta: { validationMode: 'strict', strictLinkage, typeSchemas: { edge: schemas } },
    }],
  }, null, 2), { mode: 0o600 });
  loader.loadConfig();
}

/**
 * Upsert, returning the refusal or `null` when it was accepted.
 *
 * The REASONS, not the message. A schema refusal's `message` summarises the fields — *"The change violates this
 * space's schema: fromType."* — and the detail an agent needs travels in the structured violations, which both
 * doors return as `violations`. Asserting on the summary would pin the weaker half and would have made these
 * cases pass on a refusal that said nothing about what IS allowed.
 */
async function upsert(from, to, label) {
  try {
    await edgesMod.upsertEdge(SPACE, from, to, label);
    return null;
  } catch (e) {
    const all = e?.check?.all ?? [];
    return {
      message: e instanceof Error ? e.message : String(e),
      reasons: all.map(v => `${v.field}: ${v.reason}`),
    };
  }
}

describe('an edge write is refused by its endpoint rule', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('edgeendpoints');
    loader = await import('../../server/dist/config/loader.js');
    withEdgeSchemas({});
    edgesMod = await import('../../server/dist/brain/edges.js');
    bulkMod = await import('../../server/dist/brain/bulk.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'embed_jobs', 'tombstones']) await coll(c).deleteMany({});
    await coll('entities').insertMany([
      entity(ALICE, 'Alice', 'person'),
      entity(BOB, 'Bob', 'person'),
      entity(DOC, 'Handbook', 'document'),
    ]);
  });

  it('the writer is reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof edgesMod.upsertEdge, 'function');
  });

  it('a declared pair is accepted', async () => {
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    assert.equal(await upsert(ALICE, BOB, 'reports_to'), null);
    assert.equal(await coll('edges').countDocuments({}), 1);
  });

  it('a wrong endpoint TYPE is refused, and nothing is stored', async () => {
    /*
     * The whole point. Before this the write succeeded and the dry run would have reported it later — an
     * operator had to go and ask to find out their schema was not being kept.
     */
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    const r = await upsert(DOC, BOB, 'reports_to');
    assert.ok(r, 'a document reporting to a person was stored');
    assert.ok(r.reasons.some(x => x.startsWith('fromType:')), `no fromType violation: ${r.reasons.join(' | ')}`);
    assert.ok(r.reasons.some(x => /person/.test(x)), 'the reason must say what IS allowed');
    assert.equal(await coll('edges').countDocuments({}), 0, 'it was refused and stored anyway');
  });

  it('an untyped entity is refused where a type is named', async () => {
    // The case that only works because `null` (resolved, untyped) and `undefined` (not resolved) are different
    // values. Collapsed, every untyped entity passes every rule.
    await coll('entities').insertOne({ _id: 'untyped-1', spaceId: SPACE, name: 'Thing', tags: [], seq: 1 });
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    assert.ok(await upsert('untyped-1', BOB, 'reports_to'), 'an untyped entity passed a rule naming a type');
  });

  it('UNTYPED is accepted where it is declared', async () => {
    await coll('entities').insertOne({ _id: 'untyped-2', spaceId: SPACE, name: 'Thing', tags: [], seq: 1 });
    withEdgeSchemas({ mentions: { endpoints: { to: ['UNTYPED'] } } });
    assert.equal(await upsert(ALICE, 'untyped-2', 'mentions'), null);
  });

  it('a functional label refuses a SECOND edge from the same subject', async () => {
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'] }, functional: true } });
    assert.equal(await upsert(ALICE, BOB, 'reports_to'), null, 'the first was refused');
    const r = await upsert(ALICE, DOC, 'reports_to');
    assert.ok(r, 'a second manager was accepted');
    assert.ok(r.reasons.some(x => x.startsWith('functional:')), `no functional violation: ${r.reasons.join(' | ')}`);
    assert.equal(await coll('edges').countDocuments({}), 1);
  });

  it('and an edge is not its own duplicate — re-upserting the same triplet is fine', async () => {
    /*
     * The off-by-one whose symptom is that a functional label can be written once and never touched again.
     * `functional` counts the OTHER edges from the subject, so the edge being written has to be excluded.
     */
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'] }, functional: true } });
    assert.equal(await upsert(ALICE, BOB, 'reports_to'), null);
    assert.equal(await upsert(ALICE, BOB, 'reports_to'), null, 'the same relationship refused itself');
  });

  it('a functional label still permits one edge per DIFFERENT subject', async () => {
    // The control: the constraint is per subject, not per label. Getting this wrong would make a functional
    // label writable exactly once in the whole space.
    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'] }, functional: true } });
    assert.equal(await upsert(ALICE, DOC, 'reports_to'), null);
    assert.equal(await upsert(BOB, DOC, 'reports_to'), null, 'a second subject was refused');
  });

  it('a PRE-EXISTING violation does not block an unrelated edit', async () => {
    /*
     * A space that declares a rule on a label it has already used must not become a space where nobody can fix
     * a typo. `classifyUpdateViolations` already draws this line for properties; endpoint types travel the same
     * road, and the rule is enforced on what a write INTRODUCES.
     */
    withEdgeSchemas({});
    assert.equal(await upsert(DOC, BOB, 'reports_to'), null, 'the fixture edge could not be created');

    withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
    const msg = await upsert(DOC, BOB, 'reports_to');
    assert.equal(msg, null,
      'a stored edge that already broke the rule can no longer be touched, so declaring a schema froze the data '
      + 'it describes');
  });

  /*
   * ## The third door, and the one place the self-exclusion is visible
   *
   * Bulk keeps its own `validateEdge` call because its contract is per-item: it names the index that failed and
   * carries on with the rest. That makes it a second reader of one rule, and the parity discipline says check it
   * rather than assume the write underneath covers it.
   *
   * It also happens to be the ONLY door where the `functional` count's self-exclusion changes an outcome. The
   * upsert path hands the same resolved facts to the before-state and the after-state, so an edge counted
   * against itself shows up in both and is classified `preExisting` — invisible. Bulk validates a single state,
   * so the same mistake refuses a re-import of an edge that is already stored. A mutant dropping the exclusion
   * survived every case above.
   */
  describe('through the bulk door', () => {
    const bulkEdge = (from, to, label) => bulkMod.bulkWrite(SPACE, { edges: [{ from, to, label }] });

    it('re-importing a stored functional edge is not refused as its own duplicate', async () => {
      withEdgeSchemas({ reports_to: { endpoints: { from: ['person'] }, functional: true } });
      assert.equal(await upsert(ALICE, BOB, 'reports_to'), null, 'the fixture edge could not be created');

      const res = await bulkEdge(ALICE, BOB, 'reports_to');
      assert.deepEqual(res.errors, [], 'an edge was counted against itself, so a stored functional edge can '
        + 'never be re-imported');
      assert.equal(res.updated.edges, 1);
    });

    it('a wrong endpoint type is reported per item, naming what IS allowed', async () => {
      /*
       * Fed nothing, bulk's own validation would report the property violations and stay silent on this one —
       * the write underneath would still throw, and the catch would flatten it to a summary naming the FIELD.
       * The caller would learn that `fromType` is wrong and not what would have been right, which on a
       * per-item contract is the whole value of the report.
       */
      withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
      const res = await bulkEdge(DOC, BOB, 'reports_to');
      assert.equal(res.inserted.edges, 0, 'the edge was stored');
      assert.equal(res.errors.length, 1, `expected one item error, got ${JSON.stringify(res.errors)}`);
      assert.equal(res.errors[0].index, 0, 'the report must name the item');
      assert.match(res.errors[0].reason, /person/,
        `the item reason does not say what is allowed: ${res.errors[0].reason}`);
    });

    it('an endpoint that resolves to nothing is refused for NOT EXISTING, never for its type', async () => {
      /*
       * The floor under the whole design, and the reason `ResolvedEdgeEnds` distinguishes an absent field
       * from a null one: an end that cannot be resolved has no type, so no endpoint rule can have an
       * opinion about it.
       *
       * Reported as a TYPE violation, every dangling edge in every space would become unwritable the
       * moment an operator declared an endpoint rule — a schema declaration silently changing what linkage
       * means.
       *
       * **What the answer is has changed and what it is ABOUT has not.** This door stored the dangling
       * edge while shape-not-existence was its contract; since 5.0 it refuses under `strictLinkage`, as
       * the single-record doors always did. The refusal has to say the record does not exist — the case
       * below holds the other half, where linkage is off and the edge is stored.
       */
      withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } });
      const res = await bulkEdge(ALICE, 'aaaaaaaa-0000-4000-8000-0000deadbeef', 'reports_to');
      assert.equal(res.errors.length, 1, `expected one refusal, got ${JSON.stringify(res.errors)}`);
      assert.match(res.errors[0].reason, /does not exist/,
        `the refusal must be about the missing record: ${res.errors[0].reason}`);
      assert.doesNotMatch(res.errors[0].reason, /person/,
        'an unresolvable endpoint was reported as breaking a rule about types — it has no type to break it');
    });

    it('and with linkage OFF it is STORED, with no endpoint rule reported against it', async () => {
      /*
       * The other half, and the one the design turns on. `strictLinkage: false` is a deliberate per-space
       * choice to accept dangling references — the case it exists for is a staged import whose targets
       * resolve in a later pass — so the end simply has no type, and an endpoint rule must stay silent
       * about it rather than making every such edge unwritable.
       */
      withEdgeSchemas({ reports_to: { endpoints: { from: ['person'], to: ['person'] } } }, { strictLinkage: false });
      const res = await bulkEdge(ALICE, 'aaaaaaaa-0000-4000-8000-0000deadbeef', 'reports_to');
      assert.deepEqual(res.errors, [],
        'an unresolvable endpoint was reported although the space allows dangling references');
      assert.equal(res.inserted.edges, 1, 'the edge was not stored on a space that permits it');
    });
  });

  it('a label with no endpoints rule is unaffected', async () => {
    /*
     * Floors the rest: if the resolution threw, or reported on a label carrying no rule, every case above would
     * be passing for the wrong reason.
     *
     * The label still has to be DECLARED. Once a space has any edge type schema, the label allowlist is live and
     * an undeclared label is refused — which is behaviour that long predates this change, and which the first
     * draft of this case tripped over by inventing a label name.
     */
    withEdgeSchemas({
      constrained: { endpoints: { from: ['person'] } },
      unconstrained: {},
    });
    assert.equal(await upsert(DOC, BOB, 'unconstrained'), null);
  });
});
