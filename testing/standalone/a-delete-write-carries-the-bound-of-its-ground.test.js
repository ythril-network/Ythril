/**
 * The delete a tombstone causes carries the bound of the ground that authorised it, INSIDE the write.
 *
 * ## The rule
 *
 * `authorises` reads the target, decides, and the delete happens a moment later: a record another author wrote — or
 * a stamp that changed — between the read and the write must not be taken with it. So the verdict is re-checked in
 * the write itself, and what it re-checks is a function of the ground (`deleteBound`):
 *
 *   - ground `issuer`   -> `{ 'author.instanceId': { $in: [issuer, null, ''] } }` — the issuer's own records and
 *                          author-less ones, today's bound;
 *   - ground `upstream` -> `{ deliveredBy: deliverer, 'author.instanceId': { $ne: selfId } }` — exactly what the
 *                          deliverer stamped, minus anything THIS instance wrote: the verdict's own exclusion
 *                          (`target.author?.instanceId !== selfId`) is repeated inside the write, so a record this
 *                          instance authored is never taken by the upstream ground, whatever stamp it carries. The
 *                          author clause is the self-exclusion and nothing else: it names no issuer, and it never
 *                          selects an author, it only refuses one.
 *
 * ## Why the guard is part of the module and is tested
 *
 * `{ deliveredBy: undefined }` is the forgettable failure: the driver drops or nulls an undefined and the predicate
 * matches rows it was never meant to reach, and `{ deliveredBy: '' }` matches EVERY record that arrived without a
 * peer deliverer (admin pushes, local writes, pre-release rows) — which is exactly what the upstream ground must never
 * reach. A bound that cannot be built from what it is given throws; it never returns something that matches wrongly.
 * (The throw is stated here from the repo's rule "never return empty where it should throw"; if the module refuses by
 * another means, this is the one `it` to change.)
 *
 * ## Mutation that turns it red
 *
 * Make the `upstream` bound select an author (`{ 'author.instanceId': issuer }`), or drop its `$ne: selfId` clause
 * (a record this instance wrote and the upstream stamped is taken), or swap the two grounds, or drop `null`/`''` from
 * the issuer's `$in` (author-less records stop being the issuer's to delete — a change of behaviour for every legacy
 * record), or let the upstream bound take an empty deliverer.
 *
 * Run: node --test testing/standalone/a-delete-write-carries-the-bound-of-its-ground.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/sync/deletion-authority.js', import.meta.url); });
const mod = (rule) => needModule(loaded, ['deleteBound'], rule);

describe('deleteBound', () => {
  it('issuer ground: the issuer\'s records, plus author-less and blank-author ones, and nothing keyed on a stamp', () => {
    const { deleteBound } = mod('issuer ground');
    for (const issuer of ['inst-a', 'inst-b']) {
      const bound = deleteBound('issuer', { issuer, selfId: 'inst-self' });
      assert.deepEqual(bound, { 'author.instanceId': { $in: [issuer, null, ''] } });
      assert.equal('deliveredBy' in bound, false, 'the issuer ground is not bounded by a stamp');
    }
  });

  it('issuer ground ignores a deliverer and selfId: the bound is the issuer\'s, whoever delivered it', () => {
    const { deleteBound } = mod('issuer ground / deliverer');
    assert.deepEqual(deleteBound('issuer', { issuer: 'inst-a', deliverer: 'inst-up', selfId: 'inst-self' }), { 'author.instanceId': { $in: ['inst-a', null, ''] } });
  });

  it('upstream ground: exactly the records the deliverer stamped, minus this instance\'s own', () => {
    const { deleteBound } = mod('upstream ground');
    for (const deliverer of ['inst-up', 'inst-other']) {
      for (const selfId of ['inst-self', 'inst-self-2']) {
        const bound = deleteBound('upstream', { issuer: 'inst-claimed', deliverer, selfId });
        assert.deepEqual(bound, { deliveredBy: deliverer, 'author.instanceId': { $ne: selfId } });
      }
    }
  });

  it('upstream ground never selects an author: its author clause only excludes this instance', () => {
    const { deleteBound } = mod('upstream ground / author clause');
    const bound = deleteBound('upstream', { issuer: 'inst-claimed', deliverer: 'inst-up', selfId: 'inst-self' });
    const clause = bound['author.instanceId'];
    assert.deepEqual(Object.keys(clause), ['$ne'], 'the author clause is a bare $ne: it refuses an author, it never names one');
    assert.notEqual(clause.$ne, 'inst-claimed', 'the exclusion is of THIS instance, not of the issuer the tombstone named');
  });

  it('upstream ground ignores the issuer: a deletion the upstream issued in someone else\'s name is bounded by the stamp and the self-exclusion alone', () => {
    const { deleteBound } = mod('upstream ground / issuer');
    assert.deepEqual(deleteBound('upstream', { issuer: 'x', deliverer: 'inst-up', selfId: 'inst-self' }),
      deleteBound('upstream', { issuer: 'y', deliverer: 'inst-up', selfId: 'inst-self' }));
  });

  it('the two grounds never build the same predicate', () => {
    const { deleteBound } = mod('grounds differ');
    const p = { issuer: 'inst-up', deliverer: 'inst-up', selfId: 'inst-self' };
    assert.notDeepEqual(deleteBound('issuer', p), deleteBound('upstream', p));
  });

  it('upstream ground cannot be built without a deliverer: an absent or blank one would match rows it must never reach', () => {
    const { deleteBound } = mod('upstream ground guard');
    for (const deliverer of [undefined, '']) {
      assert.throws(() => deleteBound('upstream', { issuer: 'inst-up', deliverer, selfId: 'inst-self' }), undefined,
        `deleteBound('upstream') with deliverer ${JSON.stringify(deliverer)} returned a predicate instead of refusing`);
    }
  });

  it('every call hands back a fresh object, so a caller adding its own `_id` clause cannot alter the next bound', () => {
    const { deleteBound } = mod('fresh');
    const a = deleteBound('upstream', { issuer: 'i', deliverer: 'inst-up', selfId: 'inst-self' });
    a._id = { $in: ['x'] };
    a['author.instanceId'].$ne = 'tampered';
    assert.deepEqual(deleteBound('upstream', { issuer: 'i', deliverer: 'inst-up', selfId: 'inst-self' }),
      { deliveredBy: 'inst-up', 'author.instanceId': { $ne: 'inst-self' } });
  });
});
