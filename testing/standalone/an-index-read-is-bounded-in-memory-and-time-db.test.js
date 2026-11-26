/**
 * One query's reads of a triple index are bounded in memory and in time by more than the row cap (bundle-273, Q-764, review finding G6;
 * contract row 1).
 *
 * ## The rules
 *
 * 1. **The term caches stop growing.** A query's two caches (a stored key to its id, an id to its RDF/JS term) lived as long as the query
 *    and grew with every distinct term it read: up to three per row of a 4 000 000 row read. Each holds at most `cacheTermsMax` entries per
 *    space; a term past the limit is looked up again when it is asked for again, and the answer is the same.
 * 2. **The filter loop of a batched read checks for a caller that left.** `matchMany` fits every row it read to each of up to 100 patterns:
 *    rows times patterns tests with no `check()` between them. The loop calls `check()` (and gives the event loop a turn) as often as the
 *    reads do, so a query whose caller left or whose deadline passed stops inside it.
 *
 * ## Seen red
 *
 * On d5192c4f6: case 1 fails at the id cache (`cacheTermsMax` is not an option, the cache holds every term read: 3 009 entries, not 50); case 2
 * fails at the checks (a hundred patterns over the rows make the same number of `check()` calls as one).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/an-index-read-is-bounded-in-memory-and-time-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta, baseOf } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixc-caps';
const PEOPLE = 1_500;
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
let d, read, N3;

const named = (value) => ({ termType: 'NamedNode', value });
const variable = (value) => ({ termType: 'Variable', value });
const person = (i) => named(`${baseOf(S)}entity/p${i}`);
const graph = () => N3.DataFactory.namedNode(baseOf(S));

/** A reader over the index of S whose `check` counts its calls. */
function reader(extra = {}) {
  const counts = { checks: 0 };
  const io = new read.IndexRead({
    cap: 4_000_000, deadline: Date.now() + 120_000, check: () => { counts.checks++; },
    tooMuch: () => new Error('too much'), ...extra,
  });
  return { io, counts };
}

describe('an index read is bounded in memory and in time', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixc-caps', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: PEOPLE }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
    read = await import('../../server/dist/rdf/triple-index/read.js');
    N3 = await import('n3');
  });
  after(async () => { await d?.close(); });

  it('the caches of one query stop growing at cacheTermsMax and the answers do not change', async () => {
    const cacheTermsMax = 50;
    const bounded = reader({ cacheTermsMax });
    const free = reader();
    const subjects = Array.from({ length: PEOPLE }, (_, i) => [person(i), variable('p'), variable('o')]);
    const answers = async (io) => {
      const out = [];
      for (let at = 0; at < subjects.length; at += read.IndexRead.BATCH) {
        for (const quads of await io.matchMany(S, true, graph(), subjects.slice(at, at + read.IndexRead.BATCH))) out.push(quads.map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).sort().join('\n'));
      }
      return out;
    };
    const want = await answers(free.io);
    assert.equal(want.length, PEOPLE);
    assert.ok(want.every(a => a.length > 0), 'every person states something');
    assert.deepEqual(await answers(bounded.io), want, 'a query whose caches stopped growing answers alike');
    for (const [name, cache] of [['ids', bounded.io.idCache.get(S)], ['terms', bounded.io.termCache.get(S)]]) {
      assert.ok(cache.size <= cacheTermsMax, `the ${name} cache holds at most ${cacheTermsMax} entries, not ${cache.size}`);
    }
    assert.ok(free.io.idCache.get(S).size > cacheTermsMax, 'the unbounded default holds more, so the bound is what held it');
  });

  it('a hundred patterns over the rows read check for a caller that left inside the filter loop', async () => {
    const one = [[variable('s'), named(LABEL), variable('o')]];
    const hundred = Array.from({ length: read.IndexRead.BATCH }, () => [variable('s'), named(LABEL), variable('o')]);
    const alone = reader();
    await alone.io.matchMany(S, true, graph(), one);
    const many = reader();
    const answers = await many.io.matchMany(S, true, graph(), hundred);
    assert.equal(answers.length, read.IndexRead.BATCH);
    assert.ok(answers[0].length >= PEOPLE, `every pattern matches every label: ${answers[0].length}`);
    assert.ok(many.counts.checks - alone.counts.checks >= 10,
      `a hundred patterns over ${PEOPLE} rows check ${many.counts.checks} times, one pattern ${alone.counts.checks}: the filter loop checks in between`);
    // A caller that left stops the read inside the loop.
    let calls = 0;
    const leaving = reader({ check: () => { if (++calls > alone.counts.checks + 3) throw new Error('the caller left'); } });
    await assert.rejects(leaving.io.matchMany(S, true, graph(), hundred), /the caller left/);
  });
});
