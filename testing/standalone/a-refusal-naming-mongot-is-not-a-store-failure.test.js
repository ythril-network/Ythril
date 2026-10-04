/**
 * A refusal whose TEXT happens to look like a store failure is still the caller's refusal: the store-failure message
 * patterns are read only from an error the database driver raised (bundle-30 I13, pre-ship reliability R3).
 *
 * ## The defect
 *
 * `classifyReadFailure` matched `Executor error during … command` and the search-stage pattern (`$vectorSearch`,
 * `$search`, an unanchored `mongot`, `vector search index`) against the message of ANY error. Since I12 the
 * strict-linkage reference refusals of the edge and link routes go through `sendReadFailure`, and their text quotes
 * the caller's reference and the space id. So `POST …/edges` with `to: "notes/mongot-setup.md"` (absent) answered
 * `503 retryable` with `Retry-After` instead of `400` — a client told to retry a refusal for ever, the unsafe
 * direction the module itself names. Any missing reference in a space whose id contains `mongot` did the same.
 *
 * ## What is asserted
 *
 * The refusals the reference check builds (`missingRefsRefusal`, the one sentence every door uses), for a reference
 * and for a space id that contain each pattern word, are `400`, not retryable — through the classifier and through the
 * REST sender. And the driver's own error with the same text is still the store's (`503`).
 *
 * Run: node --test testing/standalone/a-refusal-naming-mongot-is-not-a-store-failure.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const { classifyReadFailure } = await import('../../server/dist/brain/store-failure.js');
const { missingRefsRefusal } = await import('../../server/dist/brain/entity-refs.js');
const { sendReadFailure } = await import('../../server/dist/api/brain/_read-failure.js');
const driver = createRequire(path.resolve('server/package.json'))('mongodb');

/** Refusals as the reference check words them, each carrying one of the store patterns in caller-supplied text. */
const REFUSALS = [
  ['a file reference naming mongot', () => missingRefsRefusal('general', 'to', 'file', ['notes/mongot-setup.md'])],
  ['a space id containing mongot', () => missingRefsRefusal('mongotest', 'to', 'entity', ['cccccccc-0000-4000-8000-000000000001'])],
  ['a file reference naming $search', () => missingRefsRefusal('general', 'linkFiles', 'file', ['docs/$search.md'])],
  ['a file reference naming a vector search index', () => missingRefsRefusal('general', 'to', 'file', ['vector search index notes.md'])],
  ['a file reference quoting an executor error', () => missingRefsRefusal('general', 'to', 'file', ['Executor error during find command.txt'])],
];

describe('a refusal naming mongot is not a store failure', () => {
  for (const [name, make] of REFUSALS) {
    it(`${name}: 400, not retryable, on the classifier and the REST sender`, () => {
      const refusal = make();
      assert.ok(refusal, 'the reference check built no refusal — the fixture is broken');
      const f = classifyReadFailure(refusal);
      assert.equal(f.status, 400, `a refusal of the caller's reference was classified ${f.status}: ${refusal.message}`);
      assert.equal(f.retryable, false);

      const res = { code: 0, body: undefined, headers: {},
        status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; return this; },
        json(b) { this.body = b; return this; } };
      sendReadFailure(res, 'brain POST /spaces/:spaceId/edges (reference check)', refusal);
      assert.equal(res.code, 400, `the REST door answered ${res.code} for the caller's own reference`);
      assert.equal(res.headers['Retry-After'], undefined, 'a refusal must not invite a retry');
    });
  }

  it('the driver\'s own error with that text is still the store\'s', () => {
    const f = classifyReadFailure(new driver.MongoServerError({ errmsg: 'PlanExecutor error :: mongot connection closed' }));
    assert.equal(f.status, 503, 'narrowing the patterns to driver errors must not lose the store failures they exist for');
  });
});
