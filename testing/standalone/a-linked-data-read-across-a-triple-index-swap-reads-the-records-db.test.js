/**
 * A Linked Data address read across a swap of its space's triple index answers what the records answer (bundle-273, Q-764 slice S4;
 * design-r2 R5; contract row 2, held for every RDF read door that reads the index).
 *
 * ## The rule
 *
 * A read pins the build of the index it decided to read and checks it again at its end. When a rebuild swapped the index while the read
 * ran, what it read may mix two builds, so the read is answered again from the space's records. Here the live index's dictionary spells the
 * record's name as a stale one (the drift a verify finds), the records and the build being swapped in state the real one, and the swap
 * starts the moment the read sends its first statement find: a read that ends after the swap's state was committed answers the real name.
 *
 * A trial counts only when the swap's state was committed before the read ended (the read then crossed the swap); the read is made long
 * by the statements that point at the record. At least one trial must cross.
 *
 * ## Seen red
 *
 * On 2b166cbe2 (the SPARQL door reruns; the Linked Data reads do not): the first trial's read crossed the swap and was answered `500`
 * (`500 !== 200`): the collections renamed under it failed the read, and the act did not read the space again from its records.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-linked-data-read-across-a-triple-index-swap-reads-the-records-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc, edgeDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixb-ld';
/** Statements pointing at the record: they make the read long enough to cross a swap. */
const POINTING = 3_000;
const TRIALS = 5;
let d, tok, client;

const PUBLIC = 'https://rdf.example.org';
const previousPublic = process.env['PUBLIC_BASE_URL'];
const NAME = 'Target name';
const staleOf = (trial) => `Stale name ${trial}`;

describe('a Linked Data read across a triple index swap reads the records', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixb-ld', spaces: [{ id: S, meta: rdfMeta(S) }], monitorCommands: true });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    tok = await d.mint('tixb-ld-reader', { [S]: d.row({ knowledge: 'read' }) });
    const docs = [['entities', entityDoc(S, 'target', NAME, 'person')]];
    for (let i = 0; i < POINTING; i++) {
      docs.push(['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]);
      docs.push(['edges', edgeDoc(S, `k${i}`, `p${i}`, 'target', 'knows')]);
    }
    await landAll(d, S, docs);
    const { rebuildTripleIndex } = await rebuildModule();
    assert.equal((await rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
    client = d.door.mongo.getMongo();
    // The address asked for is the public URL and the path: the space's base (`rdfMeta`) is under this one.
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
  });
  after(async () => {
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await d?.close();
  });

  it('a read that crossed a swap answers the records, never the index it pinned', async () => {
    const { beginTripleIndexBuild, fillTripleIndexBuild, swapTripleIndexBuild } = await rebuildModule();
    const crossed = [];
    for (let trial = 1; trial <= TRIALS && crossed.length < 2; trial++) {
      // The drift: the live index's dictionary spells the record's name as a stale one (a write to a record would be journaled, and the
      // space read from its records); the build filled now states the records' name.
      const terms = d.col(`${S}_rdf_terms`);
      const term = await terms.findOne({ k: { $regex: `^L\\["${NAME}"` } });
      assert.ok(term, 'the live index holds the name');
      await terms.updateOne({ _id: term._id }, { $set: { k: term.k.replace(`"${NAME}"`, `"${staleOf(trial)}"`) } });
      const build = await beginTripleIndexBuild(S);
      assert.ok(build, 'the build row is free');
      await fillTripleIndexBuild(build);

      let swap = null;
      let sawState = false;
      let committedAt = null;
      const seen = new Set();
      const started = (ev) => {
        seen.add(`${ev.commandName} ${ev.command?.[ev.commandName]}`);
        if (swap === null && ev.commandName === 'find' && ev.command?.find === `${S}_rdf_quads`) swap = swapTripleIndexBuild(build);
        if (ev.commandName === 'update' && ev.command?.update === `${S}_rdf_state`
          // The swap's state write is a pipeline since bundle-378 (it carries the write counter on): its build id is inside the stage.
          && ev.command.updates?.some(u => JSON.stringify(u.u ?? null).includes(`"${build.buildId}"`))) sawState = true;
      };
      const succeeded = (ev) => { if (sawState && committedAt === null && ev.commandName === 'commitTransaction') committedAt = Date.now(); };
      client.on('commandStarted', started);
      client.on('commandSucceeded', succeeded);
      let r;
      let endedAt;
      try {
        r = await d.sparqlRest(tok.key, 'GET', `/ld/${S}/entity/target`, { headers: { Accept: 'text/turtle' } });
        endedAt = Date.now();
      } finally {
        client.off('commandStarted', started);
        client.off('commandSucceeded', succeeded);
      }
      assert.ok(swap, `the read sent a statement find, which started the swap (${r?.status} ${r?.text.slice(0, 200)}; sent: ${[...seen].join(', ')})`);
      await swap;
      await followUntilReady(d, S);
      assert.equal(r.status, 200, r.text.slice(0, 300));
      if (committedAt === null || committedAt >= endedAt) continue;
      crossed.push({ trial, text: r.text });
    }
    assert.ok(crossed.length >= 1, 'no read crossed a swap: the trials prove nothing');
    for (const { trial, text } of crossed) {
      assert.ok(!text.includes(`"${staleOf(trial)}"`), `trial ${trial}: a read across the swap answered the name the swapped-out index stated`);
      assert.ok(text.includes(`"${NAME}"`), `trial ${trial}: the read answers the records' name`);
    }
  });
});
