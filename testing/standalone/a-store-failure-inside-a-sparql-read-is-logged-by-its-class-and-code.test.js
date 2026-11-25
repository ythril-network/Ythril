/**
 * A store failure inside a SPARQL read keeps its cause in the log: the error's class and the driver's code, never its message (bundle-271,
 * Q-756; lens-3 O2).
 *
 * ## What it prevents
 *
 * The quad source answers a failed read of the store as `503 sparql_store_unavailable` and, until now, logged nothing: an operator told the
 * store "did not answer" could not see which failure it was (a closed client, a shutdown, a network error). The line names the class
 * (`MongoServerError`), the numeric `code` and the `codeName`. The driver's message can hold the filter the read failed on (a record id, a
 * value, a space's name), which the log is read by more people than may read: the message is in no line.
 *
 * ## Seen red
 *
 * On d78b20280 the answer was the refusal and no log line was written ("no log line names the failure").
 *
 * Run: node --test testing/standalone/a-store-failure-inside-a-sparql-read-is-logged-by-its-class-and-code.test.js (a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError, MongoNetworkError } from 'mongodb';

const { storeFailureRefusal } = await import('../../server/dist/rdf/quad-source.js');
const { subscribeLogLines } = await import('../../server/dist/util/log.js');

/** The log lines written while `fn` runs. */
function linesDuring(fn) {
  const lines = [];
  const stop = subscribeLogLines(line => lines.push(line));
  try { fn(); } finally { stop(); }
  return lines;
}

const SECRET = 'zq7secretfilter';

describe('a store failure inside a SPARQL read is logged by its class and code, never its message', () => {
  it('a server error is the 503 refusal and one log line with its class, code and code name', () => {
    const err = new MongoServerError({ message: `cursor id ${SECRET} not found`, code: 11600, codeName: 'InterruptedAtShutdown' });
    let refusal;
    const lines = linesDuring(() => { refusal = storeFailureRefusal(err); });
    assert.equal(refusal?.status, 503);
    assert.equal(refusal?.code, 'sparql_store_unavailable');
    const mine = lines.filter(l => l.includes('SPARQL read failed on the store'));
    assert.equal(mine.length, 1, `no log line names the failure: ${JSON.stringify(lines)}`);
    for (const part of ['MongoServerError', '11600', 'InterruptedAtShutdown']) assert.ok(mine[0].includes(part), `the line lacks ${part}: ${mine[0]}`);
    assert.ok(!lines.some(l => l.includes(SECRET)), 'a log line holds the driver\'s message');
  });

  it('a network error is logged by its class alone, and an error that is no store failure is neither refused nor logged', () => {
    let refusal;
    const lines = linesDuring(() => { refusal = storeFailureRefusal(new MongoNetworkError(`connection to ${SECRET} closed`)); });
    assert.equal(refusal?.code, 'sparql_store_unavailable');
    assert.ok(lines.some(l => l.includes('MongoNetworkError')), `no line names the class: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some(l => l.includes(SECRET)), 'a log line holds the driver\'s message');
    let other;
    const quiet = linesDuring(() => { other = storeFailureRefusal(new TypeError('a bug of ours')); });
    assert.equal(other, null);
    assert.deepEqual(quiet.filter(l => l.includes('SPARQL read failed')), []);
  });
});
