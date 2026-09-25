/**
 * Two peers that independently create the same relationship must agree on its id.
 *
 * ## The defect
 *
 * An edge's `_id` was `uuidv4()` — random. The collection has a unique index on `(from, to, label)`
 * (`spaces/lifecycle.ts`), so the relationship itself cannot be stored twice; what happens instead is that two
 * peers each store it under a DIFFERENT id, sync exchanges them, and the receiving side's insert violates that
 * index. One relationship, two identities, and a duplicate-key error on every cycle.
 *
 * Deriving the id from the triplet makes the two peers arrive at the same `_id` without talking, which is what
 * turns the collision into an idempotent no-op.
 *
 * ## `spaceId` is NOT part of the key, and that is the whole subtlety
 *
 * It is the obvious thing to include, and `_LINKS-AND-SCHEMA-PLAN.md:304` still spells it that way. It is
 * wrong: `sync/space-map.ts` lets a peer's space live under a DIFFERENT local id, so a key including `spaceId`
 * derives differently on each side — reproducing the exact defect, and reproducing it precisely on the
 * networks that configured aliasing. The collection is already per-space, so the space is in the collection
 * name rather than in the key.
 *
 * ## What this does NOT do
 *
 * **Existing edges keep their v4 ids.** There is no migration: a derived id only has to be agreed on by peers
 * creating an edge from now on, and rewriting stored ids would mean a tombstone and a re-insert for every edge
 * in every space to fix a collision that is already handled.
 *
 * **An edge whose identity CHANGES keeps its old id**, and that is a stated limit rather than an oversight —
 * pinned below so it cannot quietly become a surprise. `merge.ts` relinks an edge by `$set`ting `from`/`to`,
 * and `updateEdgeById` accepts a new `label`; Mongo's `_id` is immutable, so after either the stored id no
 * longer equals its derivation. That edge then behaves exactly as every edge did before this change — no
 * worse — and re-keying it is its own work, because delete-and-reinsert on a synced natural-key collection
 * has to reason about the tombstone it leaves behind.
 *
 * Run: node --test testing/standalone/an-edge-id-is-derived-from-its-identity.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

let EDGES = null;
try { EDGES = await import('../../server/dist/brain/edge-id.js'); } catch { /* not built yet */ }
const edgeIdFor = EDGES?.edgeIdFor ?? (() => { throw new Error('brain/edge-id.ts does not exist yet'); });

const src = (p) => stripComments(readFileSync(p, 'utf8'));

describe('the same relationship derives the same id', () => {
  it('is deterministic across calls', () => {
    assert.equal(edgeIdFor('a', 'b', 'knows'), edgeIdFor('a', 'b', 'knows'));
  });

  it('does NOT depend on the space — spaceMap aliasing is why', () => {
    /*
     * The load-bearing assertion, written as the thing the plan document gets wrong.
     *
     * `sync/space-map.ts` lets the same logical space carry a different id on each peer. A key including
     * `spaceId` therefore derives differently on the two sides, which is the defect this change exists to
     * remove — and it would appear only on networks that configured aliasing, i.e. exactly where it is
     * hardest to reproduce. The collection is per-space already; the space is in its name.
     *
     * Asserted on the PARAMETER NAMES rather than on the count. It was the count — "exactly three, so it
     * cannot take a space" — and M-3 added the two endpoint kinds, at which point a correct change failed a
     * gate whose subject was `spaceId`. A count is a proxy for a rule, and the proxy is what went stale.
     */
    const s = src('server/src/brain/edge-id.ts');
    const at = s.indexOf('export function edgeIdFor(');
    // From the FUNCTION, not from the file: `indexOf('): string')` unanchored finds `part(s: string): string`
    // above it, and the slice comes out backwards — an empty string passes every `doesNotMatch` there is.
    const params = s.slice(at, s.indexOf('): string', at));
    assert.doesNotMatch(params, /space/i, 'the space must not be a parameter of the derivation');
    assert.doesNotMatch(bodyOf(s, 'edgeIdFor'), /spaceId/, 'the space must not be part of the key');
  });

  it('is a valid UUID, version 5', () => {
    // Stored in the same `_id` field as the v4 ids that came before it, and read by clients that expect a
    // UUID. Version 5 is the name-based one; a v4 here would mean the derivation is not actually happening.
    assert.match(edgeIdFor('a', 'b', 'knows'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('different relationships derive different ids', () => {
  it('a different label is a different edge', () => {
    assert.notEqual(edgeIdFor('a', 'b', 'knows'), edgeIdFor('a', 'b', 'dislikes'));
  });

  it('direction matters — an edge is not symmetric', () => {
    // `(a)-[knows]->(b)` and `(b)-[knows]->(a)` are two rows under the unique index, so they must be two ids.
    // Sorting the endpoints to make the key order-insensitive would silently merge them.
    assert.notEqual(edgeIdFor('a', 'b', 'knows'), edgeIdFor('b', 'a', 'knows'));
    // And with the endpoint kinds swapped along with the ends: reversing an entity->file edge is not the same
    // relationship as the file->entity one it mirrors.
    assert.notEqual(edgeIdFor('a', 'b', 'knows', 'entity', 'file'), edgeIdFor('b', 'a', 'knows', 'file', 'entity'));
  });

  it('the separator cannot be forged out of the parts', () => {
    /*
     * `${from}|${to}|${label}` is ambiguous if an id or label may contain the separator: ('a|b', 'c', 'd') and
     * ('a', 'b|c', 'd') would produce one key for two different edges. Entity ids are UUIDs today, but a label
     * is operator-supplied text and nothing stops it containing a pipe.
     *
     * The reason every part is LENGTH-PREFIXED, and the last case is the one only a prefix defeats: a label
     * spelled like an encoded kind must not collide with an empty label carrying that kind.
     */
    assert.notEqual(edgeIdFor('a|b', 'c', 'd'), edgeIdFor('a', 'b|c', 'd'));
    assert.notEqual(edgeIdFor('a', 'b', 'c|d'), edgeIdFor('a', 'b|c', 'd'));
    assert.notEqual(edgeIdFor('a', 'b', '4:file'), edgeIdFor('a', 'b', '', 'entity', 'file'));
  });
});

describe('the creation path uses it', () => {
  it('no random id is minted for a new edge', () => {
    const body = bodyOf(src('server/src/brain/edges.ts'), 'upsertEdge');
    assert.doesNotMatch(body, /uuidv4\(\)/,
      'a new edge still gets a random id, so two peers creating the same relationship still disagree');
    assert.match(body, /edgeIdFor\(/, 'the creation path must derive the id from the triplet');
  });

  it('the derivation and the unique index are fed the SAME fields', () => {
    /*
     * Derived from the index rather than hardcoded against it. A derivation over a different set produces ids
     * that collide where the index does not, or differ where it does — worse than random ids, because it looks
     * deliberate.
     *
     * This used to assert the literal `{ from: 1, to: 1, label: 1 }`, and M-3 widened both sides together: the
     * kinds joined the key because a memory and an entity may share an id. The literal failed on a correct
     * change while the rule it stood for was more true than before, so the rule is now compared directly and
     * neither side can move alone.
     */
    const lifecycle = src('server/src/spaces/lifecycle.ts');
    const idx = lifecycle.match(/createIndex\(\{([^}]*)\}, \{ unique: true \}\)/);
    assert.ok(idx, 'the unique index on the edges collection was not found — re-anchor this gate');
    const indexed = [...idx[1].matchAll(/(\w+):\s*1/g)].map(m => m[1]);
    assert.ok(indexed.length >= 3, `only ${indexed.length} fields in the unique index`);

    const derivation = src('server/src/brain/edge-id.ts');
    const at = derivation.indexOf('export function edgeIdFor(');
    const params = derivation.slice(at, derivation.indexOf('): string', at));
    /*
     * BOTH directions, and the second is the one a mutation run had to reveal.
     *
     * Derived-from-the-index alone, narrowing the index back to three fields left this GREEN: it only asked
     * whether the derivation takes what the index has, and the derivation still took `from`, `to` and `label`.
     * One-directional by construction — the same shape as the traverse-description gate that passed on a
     * description naming no flags at all.
     *
     * The two failures are opposite and both real. A field the INDEX has and the derivation lacks: two rows the
     * index keeps apart derive one id, so the second is a duplicate `_id` for a row the index would have
     * allowed. A field the DERIVATION has and the index lacks: two ids for rows the index calls one, so the
     * second is refused on the triplet while its `_id` is free.
     */
    const declared = [...params.matchAll(/^\s*(\w+)\??:/gm)].map(m => m[1]);
    assert.deepEqual([...declared].sort(), [...indexed].sort(),
      'the unique index and the derivation are fed different fields, so the two disagree about what makes an '
      + 'edge unique — whichever has more produces rows the other refuses');
  });
});

describe('an identity change is re-keyed, and both paths do it', () => {
  /*
   * INVERTED in 3.6, not deleted. This block pinned the opposite — that both paths mutate identity in place,
   * so the follow-up would be visible in source rather than living only in a gitignored tracker. The same two
   * paths are still the subject; what changed is which way they must behave.
   *
   * `an-edge-that-is-re-keyed-converges.test.js` holds the rules of the re-key itself: the tombstone, the seq
   * ordering, and the refusal when the target identity is taken. What stays here is the narrower claim this
   * file is about — that an id is only ever the derivation of the identity stored beside it.
   */
  it('merge relinks THROUGH the re-key, and writes in place only as its fallback', () => {
    /*
     * The in-place `$set` is still there and must be: `rekeyEdge` declines an edge this instance did not
     * author, because a peer refuses a tombstone whose issuer is not the document's author and would end up
     * holding both rows. Declining has to leave the endpoint pointing at the survivor, so the fallback is
     * the pre-3.6 write, unchanged.
     *
     * What this pins is the ORDER: the re-key is attempted first, and the `$set` is reached only when it
     * returns null. A `$set` that ran unconditionally would leave every edge under an id it no longer
     * derives, which is the limit this change removes.
     */
    const merge = src('server/src/brain/merge.ts');
    const loop = merge.slice(merge.indexOf('for (const edge of edgesToRelink)'));
    const rekeyAt = loop.indexOf('rekeyEdge(');
    const setAt = loop.search(/updates\['from'\]|updates\['to'\]/);
    assert.ok(rekeyAt > 0, 'a relinked edge must move onto the id its new identity derives');
    assert.ok(setAt > rekeyAt,
      'the in-place write runs before the re-key is attempted, so no edge is ever moved');
  });

  it('a label change re-keys rather than patching the label alone', () => {
    const edges = src('server/src/brain/edges.ts');
    const body = bodyOf(edges, 'updateEdgeById');
    assert.match(body, /rekeyEdge\(/, 'a new label is a new identity, so it is a new id');
  });

  it('the derivation file says so, where whoever reads the code will see it', () => {
    // The reverse of what this used to assert. A limit that has been lifted and is still written down is
    // worse than one never written: nobody reports being able to do what they were told they could not.
    const raw = readFileSync('server/src/brain/edge-id.ts', 'utf8');
    assert.match(raw, /rekeyEdge/, 'the docblock must point at the function that does the re-key');
    assert.doesNotMatch(raw, /keeps its old id/i, 'the lifted limit is still stated here');
  });
});
