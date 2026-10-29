/**
 * `brain/edge-ends-of-record.ts` answers "which end of this edge IS record X of kind K" — in a query and in memory — and the two forms agree
 * (Q-321). An absent kind is an entity end, so an entity matches an absent kind and the kind `'entity'`; any other kind matches only itself; the
 * same id under another kind is not an end of the record; a self-loop has both ends.
 *
 * Run: node --test testing/standalone/edge-ends-of-record.test.js  (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { endIsRecord, edgeEndsAt, endsOfRecord, relinkedEnds } = await import('../../server/dist/brain/edge-ends-of-record.js');

describe('which end of an edge is a record, by kind as well as id', () => {
  it('an absent kind is an entity end, and so is the kind entity', () => {
    assert.deepEqual(endsOfRecord({ from: 'a', to: 'b' }, 'a', 'entity'), { from: true, to: false });
    assert.deepEqual(endsOfRecord({ from: 'a', to: 'b', fromKind: 'entity', toKind: 'entity' }, 'b', 'entity'), { from: false, to: true });
  });

  it('the same id under another kind is not an end of the record, in either direction', () => {
    assert.deepEqual(endsOfRecord({ from: 'a', to: 'b', fromKind: 'fact' }, 'a', 'entity'), { from: false, to: false });
    assert.deepEqual(endsOfRecord({ from: 'a', to: 'b', fromKind: 'fact' }, 'a', 'fact'), { from: true, to: false });
    assert.deepEqual(endsOfRecord({ from: 'a', to: 'b' }, 'a', 'fact'), { from: false, to: false }, 'an absent kind is an entity, never a fact');
    assert.deepEqual(endsOfRecord({ from: 'a', to: 'b', toKind: 'chrono' }, 'b', 'chrono'), { from: false, to: true });
  });

  it('a self-loop has both ends, and only both when both kinds match', () => {
    assert.deepEqual(endsOfRecord({ from: 'a', to: 'a' }, 'a', 'entity'), { from: true, to: true });
    assert.deepEqual(endsOfRecord({ from: 'a', to: 'a', toKind: 'fact' }, 'a', 'entity'), { from: true, to: false });
  });

  it('a relink moves exactly the ends that are the record, and leaves the others as they are', () => {
    assert.deepEqual(relinkedEnds({ from: 'a', to: 'x' }, 'a', 's', 'entity'), { from: 's', to: 'x' });
    assert.deepEqual(relinkedEnds({ from: 'a', to: 'x', fromKind: 'fact' }, 'a', 's', 'entity'), { from: 'a', to: 'x' });
    assert.deepEqual(relinkedEnds({ from: 'x', to: 'a', toKind: 'fact' }, 'a', 's', 'fact'), { from: 'x', to: 's' });
    assert.deepEqual(relinkedEnds({ from: 'a', to: 'a', toKind: 'fact' }, 'a', 's', 'entity'), { from: 's', to: 'a' });
  });

  it('the query form says what the in-memory form says', () => {
    assert.deepEqual(endIsRecord('from', 'a', 'entity'), { from: 'a', fromKind: { $in: [null, 'entity'] } });
    assert.deepEqual(endIsRecord('to', 'a', 'fact'), { to: 'a', toKind: 'fact' });
    assert.deepEqual(edgeEndsAt('a', 'chrono'), { $or: [{ from: 'a', fromKind: 'chrono' }, { to: 'a', toKind: 'chrono' }] });
  });
});
