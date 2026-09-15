/**
 * A correlation key names a record the same call created, and cannot name anything else.
 *
 * ## What this is for (`F-27` item 2)
 *
 * `save_bulk` takes four record arrays in one payload and its own contract says why that is not enough:
 * you cannot reference a record the call creates, because identities are minted server-side. The operator
 * measured what that costs — posting ONE message to their board took six round trips, one `save_entity`
 * and five `save_edge`.
 *
 * ## The cases that matter are the REFUSALS
 *
 * A correlation key is a naming scheme, and every naming scheme fails the same three ways: the name is
 * claimed twice, the name is never declared, or the name is declared as one thing and used as another. Each
 * of those has a wrong answer that looks reasonable — overwrite, ignore, coerce — and each wrong answer
 * produces a payload half of which points somewhere its author did not intend.
 *
 * Run: node --test testing/standalone/a-batch-can-reference-what-it-creates.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { BatchRefs, resolveRef, isRefUse, refKeyUsed, refKeyDeclared, REF_DECLARE_FIELD } =
  await import('../../server/dist/brain/batch-refs.js');

const UUID = '11111111-2222-4333-8444-555555555555';

describe('reading the two halves of the scheme', () => {
  it('an item DECLARES a key, and a value USES one', () => {
    assert.equal(refKeyDeclared({ [REF_DECLARE_FIELD]: 'post-1', name: 'x' }), 'post-1');
    assert.equal(refKeyUsed('$ref:post-1'), 'post-1');
    assert.ok(isRefUse('$ref:post-1'));
  });

  it('a stored id is not a reference, and is left alone', () => {
    // The distinction the whole module turns on: one value type, two meanings, and the caller should not
    // have to ask which they are holding before using it.
    assert.equal(refKeyUsed(UUID), undefined);
    assert.equal(isRefUse(UUID), false);
    assert.deepEqual(resolveRef(UUID, new BatchRefs()), { id: UUID });
  });

  it('a blank or absent declaration is no declaration', () => {
    assert.equal(refKeyDeclared({ [REF_DECLARE_FIELD]: '   ' }), undefined);
    assert.equal(refKeyDeclared({ name: 'x' }), undefined);
    assert.equal(refKeyDeclared(null), undefined);
  });
});

describe('what it resolves', () => {
  it('a key declared earlier in the call', () => {
    const refs = new BatchRefs();
    assert.equal(refs.declare('post-1', UUID, 'entity'), null);
    assert.deepEqual(resolveRef('$ref:post-1', refs), { id: UUID, kind: 'entity' });
  });

  it('and the KIND comes from where it was declared, not from the caller', () => {
    /*
     * The hazard this removes rather than restates: a bare UUID can name records in two collections, so an
     * explicit kind exists to disambiguate. A `$ref` cannot be ambiguous — the array it was declared in
     * already says what it is — so stating the kind becomes a check instead of an input.
     */
    const refs = new BatchRefs();
    refs.declare('m-1', UUID, 'memory');
    assert.deepEqual(resolveRef('$ref:m-1', refs, 'memory'), { id: UUID, kind: 'memory' });
  });
});

describe('and the three ways a naming scheme fails', () => {
  it('a key claimed TWICE is refused, not overwritten', () => {
    // Overwriting is the reasonable-looking wrong answer: the payload still writes, and half of it points
    // at the second record while its author meant the first.
    const refs = new BatchRefs();
    assert.equal(refs.declare('x', UUID, 'entity'), null);
    const err = refs.declare('x', '99999999-8888-4777-8666-555555555555', 'memory');
    assert.match(err, /duplicate \$ref "x"/);
    assert.match(err, /already names the entity/, 'the refusal must say what the key already means');
  });

  it('a key that was never declared is refused, not ignored', () => {
    const err = resolveRef('$ref:nobody', new BatchRefs()).error;
    assert.match(err, /unknown \$ref "nobody"/);
    assert.match(err, /cannot point forwards/,
      'the refusal must say WHY, or a caller reorders their payload at random until it works');
  });

  it('a stated kind that disagrees is refused, not coerced', () => {
    const refs = new BatchRefs();
    refs.declare('post-1', UUID, 'entity');
    const err = resolveRef('$ref:post-1', refs, 'memory').error;
    assert.match(err, /names a entity, but the item says memory/);
    assert.match(err, /guessing which side is right/,
      'the reason has to be in the message: this is the hazard an explicit kind exists to remove');
  });

  it('a resolution that failed carries NO id, so a caller cannot use it by accident', () => {
    // The property that makes the refusals real. An error plus a usable id would let a careless caller
    // store the dangling reference anyway, which is the failure the whole check exists to prevent.
    const bad = resolveRef('$ref:nobody', new BatchRefs());
    assert.equal(bad.id, undefined);
    assert.ok(bad.error);
  });
});
