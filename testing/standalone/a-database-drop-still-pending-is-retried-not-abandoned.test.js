/**
 * A database whose drop is still in progress answers "not now", and a migrate or a restore that meets it retries instead of
 * ending as abandoned (bundle-157, Q-564; Full run 39645546710).
 *
 * ## The defect this holds
 *
 * `restoreDatabase` creates every collection of the backup on the target, tolerating only `NamespaceExists` (48) since the round-3
 * fix that stopped it swallowing timeouts. On CI the target had just been dropped (`dropDatabase`) and MongoDB answered the create
 * with `DatabaseDropPending` (215): "Cannot create collection ... - database is in the process of being dropped". Nothing classified
 * 215 as the store's condition, so `isStoreSide` read it as a database REFUSAL; `migrateInstance` turned that into an input failure
 * and the whole set ended as abandoned - a migrate that only had to try again a moment later, given up for good. Before the round-3
 * narrowing the create swallowed everything, so the same race passed by timing.
 *
 * ## The rule
 *
 * A drop still pending is transient, and it is classified where every transient store answer is (`STORE_ERROR_CODES`,
 * `db/store-condition.ts`, read by `classifyReadFailure` and so by `isStoreSide`): `503`, retryable, never a refusal. Built with the
 * driver's own `MongoServerError` and the server's own words, so the classifier meets what the server sends. Namespace-exists stays
 * the only answer a create swallows (`isNamespaceExists` is false for 215).
 *
 * ## Seen red
 *
 * On 35ee8b48 `isStoreSide` answers false for 215 and `classifyReadFailure` answers it `400`.
 *
 * Run: `node --test testing/standalone/a-database-drop-still-pending-is-retried-not-abandoned.test.js` (a prior `npx tsc -p server`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('server/package.json'));
const { MongoServerError } = require('mongodb');
const { isStoreSide, classifyReadFailure } = await import('../../server/dist/brain/store-failure.js');
const { isNamespaceExists } = await import('../../server/dist/db/namespace-answers.js');

/** What the server answered the create with on CI, word for word but the database name. */
const dropPending = () => new MongoServerError({
  ok: 0, code: 215, codeName: 'DatabaseDropPending',
  errmsg: 'Cannot create collection ythril_migrate_target.m-a_entities - database is in the process of being dropped.',
});

describe('a database drop still pending is the store\'s condition, retried and never a refusal', () => {
  it('isStoreSide is true, so a migrate\'s or a restore\'s body rethrows it as retryable', () => {
    assert.equal(isStoreSide(dropPending()), true, 'a drop still pending was read as a database refusal: the act would end as abandoned');
  });

  it('classifyReadFailure answers 503 retryable, in our words', () => {
    const r = classifyReadFailure(dropPending());
    assert.equal(r.status, 503, `answered ${r.status}: ${JSON.stringify(r)}`);
    assert.equal(r.retryable, true);
    assert.doesNotMatch(r.error, /ythril_migrate_target|being dropped/, 'the answer carries the server\'s text');
  });

  it('it is not "already there": a create still does not swallow it', () => {
    assert.equal(isNamespaceExists(dropPending()), false);
  });
});
