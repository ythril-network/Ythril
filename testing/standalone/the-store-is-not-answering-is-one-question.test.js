/**
 * "Is the store not answering?" is ONE question for code with no walk above it, asked of one module — `Q-274`, bundle-53 G16.
 *
 * ## Why a predicate beside `isStoreUnreachable`
 *
 * `isStoreUnreachable` (`db/store-condition.ts`) deliberately EXCLUDES a timeout: a hung space and a dead store both time out, and the
 * housekeeping walk tells them apart with a ping. But a piece of code with NO walk above it (the suppression sweep a meta write
 * triggers; a request that scans one space) has nothing to ping with and nothing to end its space for it, so for it a bound that ended
 * the read and a store that cannot be reached mean the same: asking the next unit would wait the driver's timeout again, once per unit,
 * while an operator waits on the request. That question was written by hand in `brain/suppression-sweep.ts` (`isWriteTimeout(err) ||
 * isStoreUnreachable(err)`) and was about to be written again in `brain/scan-seed-runner.ts`: the second site, so it is
 * `storeIsNotAnswering`.
 *
 * ## What is held
 *
 *  - the predicate: a bound of ours ending the operation, a network error, a server-selection error, and any of those wrapped, are
 *    "not answering"; a plain refusal, a validation failure, a `NotFoundError` and a write concern that can never be met are not;
 *  - the request-side seed runner (`seedsInRequest`): a plain seed failure is reported and the other seeds are still asked; a seed whose
 *    failure is the store not answering is reported once and RETHROWN after ONE seed, so the request answers it the way its door maps a
 *    store failure;
 *  - the gate: no server module other than `db/store-condition.ts` spells the pair `isWriteTimeout(...) || isStoreUnreachable(...)` (or
 *    the other way round) by hand. The set is every tracked server source, with a floor.
 *
 * Run: node --test testing/standalone/the-store-is-not-answering-is-one-question.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const requireFromServer = createRequire(path.resolve('server/package.json'));
const { MongoNetworkError, MongoServerSelectionError, MongoOperationTimeoutError, MongoServerError } = requireFromServer('mongodb');
const sc = await import('../../server/dist/db/store-condition.js');
const { StoreTimeout } = await import('../../server/dist/db/write-timeout.js');
const { NotFoundError } = await import('../../server/dist/util/errors.js');
const { seedsInRequest } = await import('../../server/dist/brain/scan-seed-runner.js');

const selection = () => new MongoServerSelectionError('no server', { servers: new Map(), type: 'Unknown' });
const wrapped = (inner) => new Error('outer', { cause: inner });

describe('storeIsNotAnswering', () => {
  const answers = {
    'a StoreTimeout (a bound of ours ended the operation)': () => new StoreTimeout('the read'),
    'the driver\'s operation timeout': () => new MongoOperationTimeoutError('Timed out'),
    'a network error': () => new MongoNetworkError('connection reset'),
    'a server-selection error': selection,
    'a timeout under a wrapper': () => wrapped(new StoreTimeout('the read')),
    'a network error under a wrapper': () => wrapped(new MongoNetworkError('connection reset')),
  };
  for (const [name, make] of Object.entries(answers)) {
    it(`${name} is the store not answering`, () => {
      assert.equal(sc.storeIsNotAnswering?.(make()), true);
    });
  }

  const refusals = {
    'a plain Error': () => new Error('nope'),
    'a NotFoundError': () => new NotFoundError('no such record'),
    'a validation failure from the server (code 121)': () => new MongoServerError({ message: 'Document failed validation', code: 121 }),
    'a bad value (code 2) that is not a write concern': () => new MongoServerError({ message: 'bad value', code: 2 }),
    'a non-error': () => 'a string',
  };
  for (const [name, make] of Object.entries(refusals)) {
    it(`${name} is not`, () => {
      assert.equal(sc.storeIsNotAnswering?.(make()), false);
    });
  }

  it('is wider than isStoreUnreachable by exactly the timeouts', () => {
    assert.equal(sc.isStoreUnreachable(new StoreTimeout('x')), false, 'isStoreUnreachable now counts a timeout: the walk\'s ping question is gone');
    assert.equal(sc.storeIsNotAnswering?.(new StoreTimeout('x')), true);
    assert.equal(sc.isStoreUnreachable(new MongoNetworkError('x')), true);
  });
});

describe('seedsInRequest', () => {
  let n = 0;
  const fresh = () => ({ step: `Request scan ${++n}`, space: `req-space-${n}` });

  it('a plain seed failure is reported and the other seeds are still asked', async () => {
    const { step, space } = fresh();
    const asked = [];
    const { lines } = await logLinesDuring(() => seedsInRequest(step, space)([1, 2, 3, 4], async (s) => {
      asked.push(s);
      if (s === 2) throw new Error('this seed cannot be read');
    }, 'fact'));
    assert.deepEqual(asked, [1, 2, 3, 4]);
    assert.equal(lines.filter(l => l.includes(`${step} failed for space '${space}' (fact)`)).length, 1, lines.join(' | '));
  });

  const stops = {
    'a timeout': () => new StoreTimeout('the read'),
    'a network error': () => new MongoNetworkError('connection reset'),
    'a server-selection error': selection,
  };
  for (const [name, make] of Object.entries(stops)) {
    it(`${name} ends the batch after ONE seed, is reported once, and is rethrown for the request to answer`, async () => {
      const { step, space } = fresh();
      const asked = [];
      const failure = make();
      let thrown;
      const { lines } = await logLinesDuring(async () => {
        try {
          await seedsInRequest(step, space)([1, 2, 3, 4], async (s) => { asked.push(s); throw failure; }, 'fact');
        } catch (err) { thrown = err; }
      });
      assert.deepEqual(asked, [1], `the batch asked ${asked.length} seeds against a store that is not answering: each waits the driver's timeout while the request waits`);
      assert.equal(thrown, failure, 'the failure the request must answer (503, retryable) was swallowed or replaced');
      assert.equal(lines.filter(l => l.includes(`${step} failed for space '${space}'`)).length, 1, lines.join(' | '));
    });
  }
});

describe('the pair is spelled in one module', () => {
  it('no server module but db/store-condition.ts spells isWriteTimeout(...) with isStoreUnreachable(...) by hand', () => {
    const sources = readTrackedSources('server/src', { floor: 300 });
    const pair = /isWriteTimeout\([^)]*\)\s*\|\|\s*isStoreUnreachable\(|isStoreUnreachable\([^)]*\)\s*\|\|\s*isWriteTimeout\(/;
    const hits = sources
      .filter(({ file, text }) => file !== 'server/src/db/store-condition.ts' && pair.test(stripComments(text)))
      .map(({ file }) => file);
    assert.deepEqual(hits, [], `${hits.join(', ')} ask "is the store not answering" by hand: a second copy of the question (use storeIsNotAnswering)`);
  });
});
