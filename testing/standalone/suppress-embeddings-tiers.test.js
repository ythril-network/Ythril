/**
 * `suppressEmbeddings` resolves record > schema > space, and an edge finds its schema by `label`.
 *
 * ## Why the order is asserted rather than assumed
 *
 * `retention` already resolves in this order, by owner decision. Two tiered settings that resolve differently
 * is the kind of thing nobody discovers until it is wrong — and "wrong" here means either embedding records
 * somebody paid to suppress, or silently not embedding records somebody expects to find by meaning. The
 * second is worse: recall simply stops covering something, and nothing reports it.
 *
 * ## The distinction that carries the whole thing
 *
 * "Not stated" must fall THROUGH, not count as `false`. A schema saying nothing has to let the space setting
 * apply; if absent read as "do not suppress", the space-wide switch in the Danger Zone would do nothing for
 * any type that had a schema at all — which is every type worth suppressing.
 *
 * Run: node --test testing/standalone/suppress-embeddings-tiers.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let embeddingSuppressed, schemaKeyFor;
before(async () => {
  ({ embeddingSuppressed, schemaKeyFor } = await import('../../server/dist/brain/suppress-embeddings.js'));
});

describe('the tiers', () => {
  it('the record wins over both lower tiers, in both directions', () => {
    assert.equal(embeddingSuppressed({ record: true, schema: { suppressEmbeddings: false }, space: false }), true);
    assert.equal(embeddingSuppressed({ record: false, schema: { suppressEmbeddings: true }, space: true }), false);
  });

  it('the schema wins over the space when the record says nothing', () => {
    assert.equal(embeddingSuppressed({ schema: { suppressEmbeddings: true }, space: false }), true);
    assert.equal(embeddingSuppressed({ schema: { suppressEmbeddings: false }, space: true }), false);
  });

  it('the space applies when neither higher tier states anything', () => {
    assert.equal(embeddingSuppressed({ space: true }), true);
    assert.equal(embeddingSuppressed({ space: false }), false);
  });

  it('NOT STATED falls through — it is not `false`', () => {
    // The distinction the whole thing rests on. If an absent schema flag read as "do not suppress", the
    // space-wide switch would do nothing for any type that had a schema at all.
    assert.equal(embeddingSuppressed({ schema: {}, space: true }), true);
    assert.equal(embeddingSuppressed({ schema: undefined, space: true }), true);
    assert.equal(embeddingSuppressed({ record: undefined, schema: {}, space: true }), true);
  });

  it('defaults to embedding when nothing anywhere says otherwise', () => {
    // Suppression is opt-in. The failure direction of getting this wrong is records silently absent from
    // recall, which nobody reports because there is nothing to see.
    assert.equal(embeddingSuppressed({}), false);
  });
});

describe('the schema key', () => {
  it('an EDGE keys on `label`, not `type`', () => {
    // The trap. EdgeDoc carries both, so reading `type` finds a schema that is never there and looks like it
    // worked — suppression would silently never apply to edges, the record kind this was widened to cover.
    assert.equal(schemaKeyFor('edge', { label: 'depends-on', type: 'relation' }), 'depends-on');
  });

  it('everything else keys on `type`', () => {
    for (const kind of ['entity', 'fact', 'chrono']) {
      assert.equal(schemaKeyFor(kind, { type: 'task', label: 'nope' }), 'task', `${kind} used the wrong field`);
    }
  });

  it('returns undefined rather than guessing on an untyped record', () => {
    // Guessing would match some other type's schema and apply its suppression to a record that never
    // declared one.
    assert.equal(schemaKeyFor('entity', {}), undefined);
    assert.equal(schemaKeyFor('entity', undefined), undefined);
    assert.equal(schemaKeyFor('entity', { type: '' }), undefined);
    assert.equal(schemaKeyFor('entity', { type: 42 }), undefined);
  });
});
