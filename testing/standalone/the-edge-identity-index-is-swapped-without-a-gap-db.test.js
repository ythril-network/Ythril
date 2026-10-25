/**
 * The partial edge identity replaces the full one with uniqueness held at EVERY step, and a fork edge waits for it on the edges family
 * ALONE (Q-624, design rev 4 section 5 and test 5 of section 16, with R5 and S6).
 *
 * ## The rule
 *
 * A space built before this design holds the FULL five-field unique index, which counts fork rows. Swapping it for the partial one
 * (`partialFilterExpression: { forkOf: null }`) is three steps of \`ensurePartialEdgeIdentity\`: build the partial index BESIDE the full
 * one, confirm it from \`listIndexes\`, drop the full one. This file drives the three steps ONE AT A TIME, deterministically (no timing, no
 * parked write), from a space it puts into the 5.6 state by hand, and between steps it holds:
 *
 * - **uniqueness**: a second non-fork holder of an identity is refused by the store at every step, before and after the drop;
 * - **readiness** is read from \`listIndexes\`, failing closed: \`edgeIdentityAdmitsForks\` is false until the full index is gone, and false
 *   again if \`listIndexes\` fails;
 * - **the hold is the edges family's alone**: a push of a fork edge (one the planner would fork, or a fork row) answers
 *   \`503 edge_identity_building\`, \`retryable\`, and writes nothing, while a push of facts is served; a pull stops the edges family and
 *   lands a fact of the same cycle; the transfer's \`stoppedBy\` is \`'held'\`; the space's mark stays at the held position; the cycle
 *   lists the edges family under \`held\`, and the member is not counted as failing (it is not \`incomplete\`);
 * - **the cost, stated (R5)**: the next cycle re-offers the other families from the held position, and the receiver plans them
 *   \`skipped\` and writes nothing;
 * - **a full re-read never ends with a family unfetched (S6)**: a re-read in which the edges family is held stays open (it is not ended,
 *   it is not failing), and the cycle after the last step fetches the edges family and only then ends it;
 * - **the third step needs \`{ from: 1 }\`**: the partial index serves only reads that name \`forkOf: null\`, so dropping the full one before
 *   \`{ from: 1 }\` stands would leave every from-prefixed read scanning; the step refuses, and the full index stands;
 * - **the import door** holds a restore page of fork edges the same way (`EdgeIdentityBuilding`, which the route answers `503 edge_identity_building`): the
 *   families before it stay, nothing of the edges is written, and a re-run after the swap lands the rest;
 * - **after the last step** the same page lands: the fork edge is stored beside its subject on both doors;
 * - **the owed job** (\`runEdgeIdentityOwedTick\`, \`spaces/edge-identity-owed\`) builds the swap for a space still on the full index, and
 *   \`ythril_edge_identity_building_spaces\` goes 1 to 0.
 *
 * ## Names this file takes from the design and the ones it had to choose
 *
 * From the design: \`ensurePartialEdgeIdentity\`, \`edgeIdentityAdmitsForks\` (\`spaces/edge-identity-index\`), \`EDGE_IDENTITY_BUILDING =
 * 'edge_identity_building'\`, \`MemberExchange.held\`, \`TransferOutcome.stoppedBy: 'cap' | 'held' | 'error'\`, \`resolveWatermark\` returning a
 * \`held\` list, the gauge. The design says "the three exported steps of \`ensurePartialEdgeIdentity\`" and names none, and it names no
 * function that runs one pass of the owed job: this file expects \`buildPartialEdgeIdentity\`, \`confirmPartialEdgeIdentity\` and
 * \`dropFullEdgeIdentity\` (each \`(spaceId) => Promise\`) and \`runEdgeIdentityOwedTick()\` (the shape of \`runPositionsOwedTick\`,
 * \`_b81b-owed.mjs\`). If the implementation names them otherwise, \`STEP_NAMES\` below is the one line to change.
 *
 * ## Seen red
 *
 * On the base (b857da8f) \`spaces/edge-identity-index.js\` does not exist, so every case that drives the steps fails on the missing module;
 * the pure \`stoppedBy: 'held'\` case fails because \`resolveWatermark\` returns no \`held\` and says nothing about a held transfer.
 *
 * Run: node --test testing/standalone/the-edge-identity-index-is-swapped-without-a-gap-db.test.js  (requires a server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { readMark } from './_b81b-positions.mjs';
import { forkIdOf } from './_fork-kinds.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'q624t2swap';
const END = { from: 'ent-a', to: 'ent-b', label: 'knows' };
const IDENTITY = ['from', 'to', 'label', 'fromKind', 'toKind'];
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const STEP_NAMES = Object.freeze({ build: 'buildPartialEdgeIdentity', confirm: 'confirmPartialEdgeIdentity', drop: 'dropFullEdgeIdentity' });
const GAUGE = 'ythril_edge_identity_building_spaces';

let door, mod, space, rereads, register;

const edge = (id, seq, description, extra = {}) => build.edge(S, id, seq, { ...END, description, author: { ...PEER_AUTHOR }, ...extra });
const fiveKey = (ix) => IDENTITY.every(k => k in ix.key) && Object.keys(ix.key).length === IDENTITY.length;

/** The 5.6 state of the edges collection, built by hand: the full unique index, no partial one, no `{ from: 1 }`. */
async function to56State() {
  const c = door.coll(S, 'edges');
  for (const ix of await c.indexes()) {
    if (ix.name !== '_id_' && (fiveKey(ix) || JSON.stringify(ix.key) === JSON.stringify({ from: 1 }))) await c.dropIndex(ix.name);
  }
  await c.createIndex(Object.fromEntries(IDENTITY.map(k => [k, 1])), { unique: true });
}
const indexesNow = async () => (await door.coll(S, 'edges').indexes());
const hasFromIndex = async () => (await indexesNow()).some(ix => JSON.stringify(ix.key) === JSON.stringify({ from: 1 }));

/** One exchange of the space with the fake peer, as the engine runs it: the `MemberExchange` it answers. */
async function exchange() {
  const headers = { Authorization: 'Bearer pull-door-token', 'Content-Type': 'application/json' };
  const opts = () => ({ headers, signal: AbortSignal.timeout(60_000) });
  const net = door.config().networks.find(n => n.id === door.NET);
  const out = await mod.exchanges.exchangeSpacesWithMember(net, door.member(), headers, opts, opts);
  await door.settled();
  return out;
}

describe('the edge identity index is swapped without a gap (Q-624)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'q624t2_swap', spaces: [S], direction: 'both' });
    mod = {
      exchanges: await import('../../server/dist/sync/space-exchange.js'),
      watermark: await import('../../server/dist/sync/watermark.js'),
    };
    rereads = await import('../../server/dist/sync/full-reread.js');
    ({ register } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => { await door?.close(); });

  it('the hold is a third stop reason: resolveWatermark treats a held transfer as it treats a capped one, returns it, and says so', () => {
    const { stopTransfer, stoppedTransfers, resolveWatermark } = mod.watermark;
    const edges = { deliveredThrough: 40, truncated: false };
    const warned = [];
    stopTransfer(edges, () => {}, 'the edges family is held: edge identity rebuilding', 'held');
    assert.equal(edges.stoppedBy, 'held');
    const facts = { deliveredThrough: 100, truncated: false };
    const labelled = [{ ...edges, label: 'edges' }, { ...facts, label: 'facts' }];
    assert.deepEqual([stoppedTransfers(labelled, 'held'), stoppedTransfers(labelled, 'cap'), stoppedTransfers(labelled, 'error')], [['edges'], [], []]);
    const r = resolveWatermark({ direction: 'receive', peerLabel: 'peer', spaceId: S, from: 10, transfers: { edges, facts }, warn: (m) => warned.push(m) });
    assert.equal(r.at, 40, 'the mark moved past the held family');
    assert.deepEqual(r.held, ['edges'], 'resolveWatermark returns no held list');
    assert.ok(warned.some(m => m.includes('edges')), `the held family was not named in the warning: ${JSON.stringify(warned)}`);
  });

  it('every step of the swap holds uniqueness, readiness and the edges-family hold; the last step lets a fork edge land', async () => {
    const failures = [];
    const note = (label, what) => failures.push(`${label}: ${what}`);
    const steps = {};
    for (const [k, name] of Object.entries(STEP_NAMES)) {
      const m = await import('../../server/dist/spaces/edge-identity-index.js');
      assert.equal(typeof m[name], 'function', `spaces/edge-identity-index.js exports no ${name}: the design names three exported steps of ensurePartialEdgeIdentity and not what they are called (STEP_NAMES)`);
      steps[k] = m[name];
      space = m;
    }
    assert.equal(typeof space.edgeIdentityAdmitsForks, 'function', 'spaces/edge-identity-index.js exports no edgeIdentityAdmitsForks');
    assert.equal(typeof space.ensurePartialEdgeIdentity, 'function', 'spaces/edge-identity-index.js exports no ensurePartialEdgeIdentity');

    await door.reset();
    await to56State();
    await door.coll(S, 'edges').insertOne(edge('e1', 5, 'mine'));
    await door.raiseVersionTo(S, 5);

    let cycleNo = 0;
    /** What must hold while the full index still stands (before the third step). */
    async function whileFullStands(label) {
      // uniqueness
      await assert.rejects(door.coll(S, 'edges').insertOne(edge(`dup-${label}`, 6, 'another holder')), (e) => e?.code === 11000).catch(() => note(label, 'a second holder of the identity was stored'));
      await door.coll(S, 'edges').deleteMany({ _id: { $regex: '^dup-' } });
      // readiness
      if (await space.edgeIdentityAdmitsForks(S)) note(label, 'edgeIdentityAdmitsForks is true while the full unique index stands');
      // a planned fork, and a fork row, on the push doors: 503, retryable, nothing written
      for (const [what, send] of [
        ['single, a divergent copy', () => door.push('/edges', edge('e1', 5, 'theirs'), { spaceId: S, networkId: door.NET, token: TOKEN })],
        ['batch, a divergent copy', () => door.push('/batch-upsert', { edges: [edge('e1', 5, 'theirs')] }, { spaceId: S, networkId: door.NET, token: TOKEN })],
      ]) {
        const r = await send();
        if (r.code !== 503 || r.body?.code !== 'edge_identity_building' || r.body?.retryable !== true) note(label, `${what}: answered ${r.code} ${JSON.stringify(r.body)}, expected 503 edge_identity_building retryable`);
      }
      const rowId = await forkIdOf('edges', 'e1', 5, edge('e1', 5, 'theirs'));
      const asRow = await door.push('/batch-upsert', { edges: [{ ...edge(rowId, 5, 'theirs'), forkOf: 'e1', forkAt: 5 }] }, { spaceId: S, networkId: door.NET, token: TOKEN });
      if (asRow.code !== 503) note(label, `batch, a fork row: answered ${asRow.code} ${JSON.stringify(asRow.body)}, expected 503`);
      if ((await door.coll(S, 'edges').countDocuments({})) !== 1) note(label, 'the held push wrote a row');
      // the other families are served by the same door
      const served = await door.push('/batch-upsert', { facts: [build.fact(S, `push-fact-${label}`, 8, { author: { ...PEER_AUTHOR } })] }, { spaceId: S, networkId: door.NET, token: TOKEN });
      if (served.code !== 200) note(label, `a batch of facts alone answered ${served.code}: the hold is not the edges family's alone`);
      // a pull: the edges family stops, a fact of the same cycle lands, the member is not failing, the mark stays
      cycleNo++;
      const factId = `pull-fact-${label}`;
      door.state.records[S] = { edges: [edge('e1', 5, 'theirs')], facts: [build.fact(S, factId, 9, { author: { ...PEER_AUTHOR } })] };
      const out = await exchange();
      if (!out.held.some(h => JSON.stringify(h).includes('edges'))) note(label, `the cycle did not list the edges family under held: ${JSON.stringify(out.held)}`);
      if (out.incomplete.length > 0) note(label, `the held family counted the member as failing: ${JSON.stringify(out.incomplete)}`);
      if (!(await door.coll(S, 'facts').findOne({ _id: factId }))) note(label, 'the fact of the same cycle did not land: the hold ended the whole space');
      if ((readMark(door, 'received', S) ?? 0) !== 0) note(label, `the mark moved to ${readMark(door, 'received', S)} past the held edges family`);
      if ((await door.coll(S, 'edges').countDocuments({})) !== 1) note(label, 'the held pull wrote a row');
      // the cost of R5: the next cycle re-offers the fact, the receiver plans it skipped and writes nothing
      const before = await door.coll(S, 'facts').findOne({ _id: factId });
      await exchange();
      const after = await door.coll(S, 'facts').findOne({ _id: factId });
      if (JSON.stringify(before) !== JSON.stringify(after)) note(label, 'the re-offered fact was rewritten: a re-offer must be planned skipped');
    }

    // step 0: the 5.6 state
    await whileFullStands('5.6 state');
    // step 1: the partial index is built BESIDE the full one
    await steps.build(S);
    {
      const ix = await indexesNow();
      const partial = ix.filter(i => fiveKey(i) && i.unique && JSON.stringify(i.partialFilterExpression) === JSON.stringify({ forkOf: null }));
      if (partial.length !== 1) note('after build', `expected the partial index beside the full one: ${JSON.stringify(ix.filter(fiveKey))}`);
      if (!ix.some(i => fiveKey(i) && i.unique && i.partialFilterExpression === undefined)) note('after build', 'the full index is gone before the partial one was confirmed');
    }
    await whileFullStands('after build');
    // step 2: confirmed from listIndexes
    await steps.confirm(S);
    await whileFullStands('after confirm');

    // a full re-read in which the edges family is held does not end (S6)
    rereads.requestFullReread(door.NET, [S]);
    door.state.records[S] = { edges: [edge('e1', 5, 'theirs')], facts: [] };
    const held = await exchange();
    if (rereads.fullRereadStateOf(door.NET, PEER, S) === undefined) note('re-read', 'a full re-read ended while the edges family was held and unfetched');
    if (held.incomplete.length > 0) note('re-read', `the held re-read counted the member as failing: ${JSON.stringify(held.incomplete)}`);
    if (!held.held.some(h => JSON.stringify(h).includes('edges'))) note('re-read', `the re-read cycle did not name the edges family under held: ${JSON.stringify(held.held)}`);

    // step 3 refuses until { from: 1 } stands, and the full index stays
    if (await hasFromIndex()) note('before step 3', 'fixture check: { from: 1 } already stands');
    let refused = false;
    try { await steps.drop(S); } catch { refused = true; }
    if (!refused) note('step 3 without { from: 1 }', 'the full index was dropped (or the step answered) while { from: 1 } did not stand');
    if (!(await indexesNow()).some(i => fiveKey(i) && i.unique && i.partialFilterExpression === undefined)) note('step 3 without { from: 1 }', 'the full index is gone');
    await whileFullStands('step 3 refused');
    // the keyset pass builds { from: 1 }; the step goes through
    await door.coll(S, 'edges').createIndex({ from: 1 });
    await steps.drop(S);
    {
      const ix = await indexesNow();
      if (ix.some(i => fiveKey(i) && i.unique && i.partialFilterExpression === undefined)) note('after drop', 'the full unique index still stands');
      if (!ix.some(i => fiveKey(i) && i.unique && JSON.stringify(i.partialFilterExpression) === JSON.stringify({ forkOf: null }))) note('after drop', 'the partial index is gone');
    }
    // uniqueness after the swap: a second non-fork holder is refused, a fork beside the subject is not
    await assert.rejects(door.coll(S, 'edges').insertOne(edge('dup-final', 6, 'another holder')), (e) => e?.code === 11000).catch(() => note('after drop', 'a second non-fork holder was stored'));
    // readiness: true, and false again when listIndexes fails
    if (!(await space.edgeIdentityAdmitsForks(S))) note('after drop', 'edgeIdentityAdmitsForks is false although the swap is complete');
    {
      const proto = Object.getPrototypeOf(door.mongo.col('probe'));
      const keep = { listIndexes: proto.listIndexes, indexes: proto.indexes };
      proto.listIndexes = () => { throw new Error('listIndexes is down'); };
      proto.indexes = async () => { throw new Error('listIndexes is down'); };
      try { if (await space.edgeIdentityAdmitsForks(S)) note('listIndexes down', 'readiness was true when listIndexes failed: it must fail closed'); } catch { /* a throw is not "ready" either: the verdict below is what the rule needs */ } finally { Object.assign(proto, keep); }
    }
    // the next cycle: the re-read fetches the edges family and only then ends
    door.state.records[S] = { edges: [edge('e1', 5, 'theirs')], facts: [] };
    const landed = await exchange();
    if (landed.held.length > 0) note('after drop', `the cycle still reports held: ${JSON.stringify(landed.held)}`);
    const forks = await door.coll(S, 'edges').find({ forkOf: 'e1' }).toArray();
    if (forks.length !== 1) note('after drop', `the pull landed ${forks.length} fork edges, expected 1 beside the subject`);
    if (rereads.fullRereadStateOf(door.NET, PEER, S) !== undefined) note('re-read', 'the re-read did not end after the edges family was fetched');
    if ((readMark(door, 'received', S) ?? 0) === 0) note('after drop', 'the mark did not move once the edges family landed');
    // and the single door stores a fork row now
    const rowId = await forkIdOf('edges', 'e1', 5, edge('e1', 5, 'a third body'));
    const single = await door.push('/edges', { ...edge(rowId, 5, 'a third body'), forkOf: 'e1', forkAt: 5 }, { spaceId: S, networkId: door.NET, token: TOKEN });
    if (single.code !== 200) note('after drop', `a fork row on the single door answered ${single.code} ${JSON.stringify(single.body)}`);

    assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
  });

  it('the owed job builds the swap for a space still on the full index, and the gauge goes 1 to 0', async () => {
    const owed = await import('../../server/dist/spaces/edge-identity-owed.js');
    assert.equal(typeof owed.runEdgeIdentityOwedTick, 'function', 'spaces/edge-identity-owed.js has no runEdgeIdentityOwedTick: the design names the job (edgeIdentityOwedJob) and no function that runs one pass of it');
    const m = await import('../../server/dist/spaces/edge-identity-index.js');
    const gauge = async () => (await register.getSingleMetric(GAUGE).get()).values.reduce((n, v) => n + v.value, 0);
    await door.reset();
    await to56State();
    await door.coll(S, 'edges').createIndex({ from: 1 });
    await door.coll(S, 'edges').insertOne(edge('e1', 5, 'mine'));
    // The tick counts the spaces that are not ready, sets the gauge, then builds for them; it ends with the gauge at what it found, so the
    // tick that finds the space on the full index reports 1, and the one after it, with the swap done, reports 0.
    await owed.runEdgeIdentityOwedTick();
    assert.equal(await m.edgeIdentityAdmitsForks(S), true, 'one owed tick did not complete the swap of a space on the full index');
    assert.equal(await gauge(), 1, 'the tick that built the swap did not report the space as building');
    await owed.runEdgeIdentityOwedTick();
    assert.equal(await gauge(), 0, 'the gauge did not return to 0 once the space was ready');
  });

  it('an import of a fork edge into a space on the full index is held, the families before it stay, and it lands after the swap (design 5.4, the import door)', async () => {
    const { importDocuments } = await import('../../server/dist/api/admin-import.js');
    const m = await import('../../server/dist/spaces/edge-identity-index.js');
    await door.reset();
    await to56State();
    await door.coll(S, 'edges').createIndex({ from: 1 });
    await door.coll(S, 'edges').insertOne(edge('e1', 5, 'mine'));
    const rowId = await forkIdOf('edges', 'e1', 5, edge('e1', 5, 'theirs'));
    const forkRow = { ...edge(rowId, 5, 'theirs'), forkOf: 'e1', forkAt: 5 };
    const fact = build.fact(S, 'import-fact', 7, { author: { ...PEER_AUTHOR } });
    await assert.rejects(importDocuments(S, { facts: [fact], edges: [forkRow] }),
      (e) => e?.code === 'edge_identity_building' && e?.name === 'EdgeIdentityBuilding', 'the import of a fork edge into a space on the full index was not held');
    assert.ok(await door.coll(S, 'facts').findOne({ _id: 'import-fact' }), 'the family before the held one did not stay');
    assert.equal(await door.coll(S, 'edges').countDocuments({}), 1, 'the held import wrote an edge');
    await m.ensurePartialEdgeIdentity(S);
    const done = await importDocuments(S, { edges: [forkRow] });
    assert.equal(done.results.edges.inserted, 1, JSON.stringify(done.results.edges));
    assert.equal((await door.coll(S, 'edges').findOne({ _id: rowId }))?.forkOf, 'e1');
  });
});
