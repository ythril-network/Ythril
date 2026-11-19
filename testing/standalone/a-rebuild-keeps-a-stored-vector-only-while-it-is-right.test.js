/**
 * A rebuild that fails keeps the stored vector only while it is still RIGHT (Q-930, bundle-351).
 *
 * ## The defect
 *
 * `embedStoredRecord` kept a record's vector through a rebuild that failed only when the queue called the failure "transient" (the words of its
 * message), and unset it for every other failure: a wrong API key, a wrong model name or a refused address, which is the embedder's or the
 * settings' failure and never the record's, stripped a whole space of vectors that were of the current model. The first draft of the repair
 * kept the vector for every failure that is not the record's own, and that is wrong too, because recall does not filter by model and serves
 * what is stored: after a model change the kept vector is the OLD model's, and a record edited during a reindex has the old text's.
 *
 * ## The rule (`failureLeavesStoredVectorRight`, the one pure question; four rows)
 *
 * During a rebuild, when the embed fails:
 *
 *  1. the verdict `ends` (the embedder refuses the record as too large, or it is over the ceiling): the vector is unset, as today;
 *  2. otherwise, and the text to embed is not the stored text: unset now (text that was removed must stop matching);
 *  3. otherwise, the text is the same, and the vector was made by the current model under the configuration in force now: kept, however the
 *     job ends;
 *  4. otherwise (the text is the same, and the vector is of another model or of a configuration that cannot be told): kept while the job
 *     will be tried again, unset on its last try.
 *
 * "Its last try" is `embedVerdictEndsJob`, the function `failEmbedJob` decides by: an outage is never a last try, a third lost inference process
 * is, and a `record` failure is when the budget is spent.
 *
 * Run: node --test testing/standalone/a-rebuild-keeps-a-stored-vector-only-while-it-is-right.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let errors, queue, record;

before(async () => {
  errors = await import('../../server/dist/brain/embed-errors.js');
  queue = await import('../../server/dist/brain/embed-queue.js');
  record = await import('../../server/dist/brain/embed-record.js');
});

const ENDS = () => [
  { kind: 'ends', reason: 'refused_413' },
  { kind: 'ends', reason: 'over_ceiling' },
];
const NOT_ENDS = () => [{ kind: 'lost' }, { kind: 'outage', proven: true }, { kind: 'outage', proven: false }, { kind: 'record' }];
const keeps = (input) => record.failureLeavesStoredVectorRight(input);

describe('row 1: a verdict that ends the job unsets the vector, whatever else is true', () => {
  it('for every combination of the other three facts', () => {
    for (const verdict of ENDS()) {
      for (const textUnchanged of [true, false]) {
        for (const madeUnderCurrentConfiguration of [true, false]) {
          for (const lastTry of [true, false]) {
            assert.equal(keeps({ verdict, textUnchanged, madeUnderCurrentConfiguration, lastTry }), false,
              `${verdict.reason}, text unchanged ${textUnchanged}, current ${madeUnderCurrentConfiguration}, last try ${lastTry}`);
          }
        }
      }
    }
  });
});

describe('row 2: a changed text unsets the vector now', () => {
  it('whatever the verdict, the model and the try', () => {
    for (const verdict of NOT_ENDS()) {
      for (const madeUnderCurrentConfiguration of [true, false]) {
        for (const lastTry of [true, false]) {
          assert.equal(keeps({ verdict, textUnchanged: false, madeUnderCurrentConfiguration, lastTry }), false,
            `${verdict.kind}, current ${madeUnderCurrentConfiguration}, last try ${lastTry}`);
        }
      }
    }
  });
});

describe('row 3: the same text under the current model and configuration is kept however the job ends', () => {
  it('for every verdict that does not end the job, on the last try too', () => {
    for (const verdict of NOT_ENDS()) {
      for (const lastTry of [true, false]) {
        assert.equal(keeps({ verdict, textUnchanged: true, madeUnderCurrentConfiguration: true, lastTry }), true, `${verdict.kind}, last try ${lastTry}`);
      }
    }
  });
});

describe('row 4: the same text under another model or configuration is kept while the job will be tried again', () => {
  it('kept before the last try', () => {
    for (const verdict of NOT_ENDS()) {
      assert.equal(keeps({ verdict, textUnchanged: true, madeUnderCurrentConfiguration: false, lastTry: false }), true, verdict.kind);
    }
  });

  it('unset on the last try', () => {
    for (const verdict of NOT_ENDS()) {
      assert.equal(keeps({ verdict, textUnchanged: true, madeUnderCurrentConfiguration: false, lastTry: true }), false, verdict.kind);
    }
  });
});

describe('the two endings, asked of the function failEmbedJob decides by', () => {
  const lastTry = (failure, counters) => queue.embedVerdictEndsJob(errors.classifyEmbedFailure(failure), counters);

  it('a failure that spends the budget is the last try on the fifth attempt only', () => {
    const failure = new errors.EmbeddingHttpError(401, 'bad key', null);
    assert.equal(lastTry(failure, { attempts: queue.MAX_EMBED_ATTEMPTS - 1, lostChildFailures: 0 }), false);
    assert.equal(lastTry(failure, { attempts: queue.MAX_EMBED_ATTEMPTS, lostChildFailures: 0 }), true);
  });

  it('a third lost inference process is the last try whatever the attempts are; an outage never is', () => {
    const lost = new errors.LostChildError('code=139 signal=null');
    assert.equal(lastTry(lost, { attempts: 1, lostChildFailures: queue.MAX_LOST_CHILD_FAILURES - 2 }), false);
    assert.equal(lastTry(lost, { attempts: 1, lostChildFailures: queue.MAX_LOST_CHILD_FAILURES - 1 }), true);
    const down = new errors.EmbedUnreachableError('Could not reach embedding endpoint at http://x');
    assert.equal(lastTry(down, { attempts: queue.MAX_EMBED_ATTEMPTS, lostChildFailures: queue.MAX_LOST_CHILD_FAILURES }), false);
  });

  it('the rebuild takes the question from there: the rule asks embedVerdictEndsJob and keeps no count of its own', () => {
    const src = stripComments(fs.readFileSync('server/src/brain/embed-record.ts', 'utf8'));
    assert.match(src, /\bembedVerdictEndsJob\s*\(/, 'the rebuild rule does not ask whether the verdict ends the job');
    assert.doesNotMatch(src, /\bMAX_EMBED_ATTEMPTS\b|\bMAX_LOST_CHILD_FAILURES\b/, 'the rebuild rule counts the job\'s tries itself');
  });

  it('the worker passes the job\'s own counters to the rebuild', () => {
    const src = stripComments(fs.readFileSync('server/src/brain/embed-worker.ts', 'utf8'));
    const call = src.slice(src.indexOf('embedStoredRecord(job.spaceId'));
    const args = call.slice(0, call.indexOf(');'));
    assert.match(args, /\battempts:\s*job\.attempts\b/, 'the worker does not pass the job\'s attempts');
    assert.match(args, /\blostChildFailures:\s*job\.lostChildFailures\b/, 'the worker does not pass the job\'s lost-process count');
  });
});
