/**
 * The verdict for a member whose triple index is ready costs one command of the store, and a write acknowledged before a query started is
 * in that query's answer whatever the index says (bundle-378, Q-976 S2, contract row 2).
 *
 * ## The rule
 *
 * The quad source asks `indexVerdict` once per member and query. It read the state row, then counted the rows above `appliedPos` in each
 * record collection and the tombstones, then the journal: nine round trips for every query, about half of the cheapest query's time. The
 * verdict for a ready member now sends ONE command: the state row with, in the same command, whether any record row, tombstone or journal
 * row stands above it.
 *
 * ## The barrier (the guard the cut must keep)
 *
 * The state row alone cannot keep it: a write whose follower did not run (the lease held elsewhere) and an unpositioned write until its
 * journal row is cleared leave the state row as it was. So each case below holds the follower's lease for another owner, makes the write,
 * and asks for the verdict and the answer: the member is read from its records and the answer holds the write. Under a held transaction (an
 * unpositioned write in the transaction's session, journaled at its commit) and under two overlapping positioned writes.
 *
 * ## Seen red
 *
 * On d97660409 the verdict sends nine commands (the state row, seven counts of the record collections and tombstones, the journal count).
 * The barrier cases hold there: they are the guarantee the cut must not lose.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-verdict-reads-the-store-once-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, rowTexts } from './_sparql-doors.mjs';
import { landAll, followUntilReady, holdLease, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixv-verdict';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

let d, admin, read;

/** The labels the space answers now, through the SPARQL door. */
async function labels() {
  const r = await d.sparqlPost(admin.key, S, `SELECT ?n WHERE { ?e <${LABEL}> ?n }`);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  return rowTexts(r.body).join(' | ');
}

/** The verdict a query starting now gets for the space. */
async function verdict() {
  const config = await import('../../server/dist/config/loader.js');
  const meta = (await import('../../server/dist/rdf/rdf-space-state.js')).rdfSpaceState(config.getConfig(), S, undefined, () => '');
  assert.ok(meta.ok, 'the space reads as RDF');
  return read.indexVerdict(S, meta.meta, Date.now() + 30_000);
}

/** Give the lease back and run the follower until the index is ready again. */
async function release() {
  await d.col(`${S}_rdf_state`).deleteOne({ _id: 'lease' });
  await followUntilReady(d, S);
}

describe('the triple index verdict reads the store once', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b378-tixv', spaces: [{ id: S, meta: rdfMeta(S) }], monitorCommands: true });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    admin = await d.mint('tixv-admin', {}, { admin: true });
    read = await import('../../server/dist/rdf/triple-index/read.js');
    await landAll(d, S, [['entities', entityDoc(S, 'v0', 'Seed zero', 'thing')]]);
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
  });
  after(async () => { await d?.close(); });

  it('the verdict for a ready member sends one command', async () => {
    let v;
    const commands = await d.door.commandsDuring(async () => { v = await verdict(); });
    assert.equal(v.read, 'index', `the member is read from its index: ${JSON.stringify(v)}`);
    assert.equal(commands.length, 1, `the verdict for a ready member is one command: ${commands.length} sent (${commands.join('; ')})`);
    assert.match(commands[0], /_rdf_state$/, `the one command reads the state row: ${commands[0]}`);
  });

  it('a positioned write the follower did not apply is read from the records', async () => {
    await holdLease(d, S);
    try {
      await landAll(d, S, [['entities', entityDoc(S, 'v1', 'Lagging one', 'thing')]]);
      const v = await verdict();
      assert.deepEqual(v, { read: 'records', why: 'lagging' }, 'an acknowledged write above appliedPos sends the member to its records');
      assert.match(await labels(), /Lagging one/, 'the answer holds the acknowledged write');
    } finally { await release(); }
    assert.equal((await verdict()).read, 'index', 'once applied, the member is read from its index again');
    assert.match(await labels(), /Lagging one/, 'the index answers the write once applied');
  });

  it('a write in a held transaction, acknowledged at its commit, is read from the records until applied', async () => {
    const { inHeldTransaction } = await import('../../server/dist/brain/held-transaction.js');
    await holdLease(d, S);
    try {
      await inHeldTransaction(S, 'test.held', async (session) => {
        await d.col(d.spaceCollection(S, 'entities')).updateOne({ _id: 'v0' }, { $set: { name: 'Held rename' } }, { session });
      });
      const v = await verdict();
      assert.equal(v.read, 'records', `a committed write the index has not applied sends the member to its records: ${JSON.stringify(v)}`);
      assert.match(await labels(), /Held rename/, 'the answer holds the committed write');
    } finally { await release(); }
    assert.match(await labels(), /Held rename/, 'the index answers the write once applied');
  });

  it('two overlapping writes, both acknowledged, are both in the answer', async () => {
    await holdLease(d, S);
    try {
      await Promise.all([
        landAll(d, S, [['entities', entityDoc(S, 'v2', 'Overlap two', 'thing')]]),
        landAll(d, S, [['entities', entityDoc(S, 'v3', 'Overlap three', 'thing')]]),
      ]);
      assert.equal((await verdict()).read, 'records', 'two writes the index has not applied send the member to its records');
      const seen = await labels();
      assert.match(seen, /Overlap two/);
      assert.match(seen, /Overlap three/);
    } finally { await release(); }
    const seen = await labels();
    assert.match(seen, /Overlap two/, 'the index answers the first write once applied');
    assert.match(seen, /Overlap three/, 'the index answers the second write once applied');
  });
});
